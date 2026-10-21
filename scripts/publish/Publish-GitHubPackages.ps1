<#
.SYNOPSIS
    Pushes this release's packages to the repository owner's GitHub Packages
    registries, or with -DryRun prepares them and pushes nothing (docs/packages,
    D16; the user's choice, 2026-10-20: this repository and its feed first).

.DESCRIPTION
    GitHub Packages links a package to this repository and lists it on the
    repository's page. What goes there, from the files scripts/pack-all.ps1
    gathers (-Packages):

      Bdd.Suite, Bdd.Suite.Testing
                  the NuGet feed https://nuget.pkg.github.com/<owner>/index.json,
                  as packed (dotnet nuget push --skip-duplicate --no-symbols;
                  the feed has no symbol server)
      BddSuite    the same NuGet feed, which PSResourceGet installs from
                  (Register-PSResourceRepository -Uri <the feed>). Its nuspec
                  gains the repository URL first: Publish-PSResource writes
                  none, and GitHub Packages links a NuGet package to a
                  repository by it.
      @bdd-suite/runtime
                  the npm registry https://npm.pkg.github.com as
                  @<owner>/bdd-suite-runtime: that registry takes only the
                  owner's scope. The tarball is unpacked, renamed and published
                  as it is (its scripts are not run, it is built already);
                  publishConfig goes, since provenance is npmjs.com's. A
                  consumer keeps importing @bdd-suite/runtime through an alias:
                    npm install @bdd-suite/runtime@npm:@<owner>/bdd-suite-runtime@<version>

    GITHUB_TOKEN (packages: write) authenticates. A version the feed has is
    skipped (--skip-duplicate for NuGet; npm view first for npm), so a release
    is finished by running it again. -DryRun makes the renamed and amended
    packages and checks them, and pushes nothing.

.EXAMPLE
    pwsh -File scripts/publish/Publish-GitHubPackages.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$Packages,
    # The account the registries belong to; GitHub Actions' GITHUB_REPOSITORY_OWNER.
    [string]$Owner = $(if ($env:GITHUB_REPOSITORY_OWNER) { $env:GITHUB_REPOSITORY_OWNER } else { 'smartpcr' }),
    [switch]$DryRun,
    # A folder to keep the amended BddSuite package and the renamed npm package in, to install them from.
    [string]$Keep
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Packages) { $Packages = Join-Path $repo 'artifacts/packages' }
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$slug = if ($env:GITHUB_REPOSITORY) { $env:GITHUB_REPOSITORY } else { 'smartpcr/bdd-code-extension' }
$owner = $Owner.ToLowerInvariant()
$nugetFeed = "https://nuget.pkg.github.com/$owner/index.json"
$npmRegistry = 'https://npm.pkg.github.com'
$npmName = "@$owner/bdd-suite-runtime"
if (-not $DryRun -and -not $env:GITHUB_TOKEN) { throw 'GITHUB_TOKEN is not set: the job passes the run''s token (packages: write).' }

$work = Join-Path ([IO.Path]::GetTempPath()) ('github-packages-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null

function Get-Package([string]$Name) {
    $file = Join-Path $Packages $Name
    if (-not (Test-Path $file)) { throw "$file is not there: run scripts/pack-all.ps1 first." }
    return $file
}

function Invoke-Native([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE) { throw "$What failed (exit $LASTEXITCODE)" }
}

function Push-NuGet([string]$File) {
    $leaf = Split-Path -Leaf $File
    if ($DryRun) { Write-Output "  would push $leaf to $nugetFeed"; return }
    Invoke-Native "dotnet nuget push $leaf" { dotnet nuget push $File --source $nugetFeed --api-key $env:GITHUB_TOKEN --skip-duplicate --no-symbols }
}

try {
    Write-Output "GitHub Packages of $owner ($(if ($DryRun) { 'dry run' } else { 'publish' })), version ${version}:"

    foreach ($id in 'Bdd.Suite', 'Bdd.Suite.Testing') { Push-NuGet (Get-Package "$id.$version.nupkg") }

    # BddSuite: a copy whose nuspec names this repository.
    $module = Join-Path $work "BddSuite.$version.nupkg"
    Copy-Item (Get-Package "BddSuite.$version.nupkg") $module
    $zip = [IO.Compression.ZipFile]::Open($module, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $entry = $zip.Entries | Where-Object { $_.FullName -eq 'BddSuite.nuspec' }
        if (-not $entry) { throw "BddSuite.$version.nupkg holds no BddSuite.nuspec" }
        $reader = [IO.StreamReader]::new($entry.Open())
        try { $nuspec = [xml]$reader.ReadToEnd() } finally { $reader.Dispose() }
        $metadata = $nuspec.package.metadata
        if (-not $metadata.repository) {
            $element = $nuspec.CreateElement('repository', $nuspec.DocumentElement.NamespaceURI)
            $element.SetAttribute('type', 'git')
            $element.SetAttribute('url', "https://github.com/$slug")
            $null = $metadata.AppendChild($element)
        }
        $entry.Delete()
        $writer = [IO.StreamWriter]::new($zip.CreateEntry('BddSuite.nuspec').Open(), [Text.UTF8Encoding]::new($false))
        try { $nuspec.Save($writer) } finally { $writer.Dispose() }
    } finally {
        $zip.Dispose()
    }
    Write-Output "  BddSuite.$version.nupkg names https://github.com/$slug as its repository"
    Push-NuGet $module

    # @bdd-suite/runtime as @<owner>/bdd-suite-runtime.
    $stream = [IO.File]::OpenRead((Get-Package "bdd-suite-runtime-$version.tgz"))
    try {
        [Formats.Tar.TarFile]::ExtractToDirectory([IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionMode]::Decompress), $work, $true)
    } finally {
        $stream.Dispose()
    }
    $folder = Join-Path $work 'package'
    $manifestPath = Join-Path $folder 'package.json'
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashtable
    $manifest['name'] = $npmName
    $manifest.Remove('publishConfig')
    $manifest | ConvertTo-Json -Depth 50 | Set-Content $manifestPath -Encoding utf8NoBOM
    Write-Output "  bdd-suite-runtime-$version.tgz renamed $npmName"
    # Its own npm configuration: the token for this registry only, nothing from the machine's.
    $npmrc = Join-Path $work '.npmrc'
    Set-Content $npmrc "//npm.pkg.github.com/:_authToken=$(if ($DryRun) { 'dry-run' } else { $env:GITHUB_TOKEN })" -Encoding utf8NoBOM
    if ($DryRun) {
        Invoke-Native "npm publish --dry-run $npmName" { npm publish $folder --dry-run --ignore-scripts --registry $npmRegistry --userconfig $npmrc }
    } else {
        $held = npm view "$npmName@$version" version --registry $npmRegistry --userconfig $npmrc 2> $null
        if ("$held".Trim() -eq $version) {
            Write-Output "  $npmName $version is already published; skipped."
        } else {
            Invoke-Native "npm publish $npmName" { npm publish $folder --ignore-scripts --registry $npmRegistry --userconfig $npmrc }
        }
    }
    if ($Keep) {
        New-Item -ItemType Directory -Force -Path $Keep | Out-Null
        Copy-Item $module $Keep
        Copy-Item $folder (Join-Path $Keep 'npm-package') -Recurse -Force
    }
} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
