<#
.SYNOPSIS
    Publishes this release's package to one public registry, or with -DryRun
    says what it would publish and publishes nothing (docs/packages, D16,
    DEC-P10, E10).

.DESCRIPTION
    The registry is asked first whether it holds the version; a version it
    holds is skipped, so a release that failed part-way is finished by running
    it again, never by a new version (DEC-P10).

      nuget      Bdd.Suite and Bdd.Suite.Testing to nuget.org (their .snupkg
                 beside them): dotnet nuget push --skip-duplicate with
                 NUGET_API_KEY, the short-lived key NuGet/login gives a trusted
                 publisher. dotnet has no dry run: a dry run pushes nothing.
      npm        @bdd-suite/runtime to npmjs.com: npm publish <tarball>
                 --provenance --access public, by npm trusted publishing.
                 Dry run: npm publish --dry-run.
      crates     suiterun to crates.io: cargo publish in runtimes/rust, with
                 CARGO_REGISTRY_TOKEN from crates.io trusted publishing.
                 Dry run: cargo publish --dry-run.
      psgallery  BddSuite to the PowerShell Gallery: Publish-PSResource
                 -NupkgPath with PSGALLERY_API_KEY. Dry run: nothing is called;
                 PSResourceGet 1.2.0 publishes a -NupkgPath even under -WhatIf
                 (seen against a file repository, 2026-10-20).

    -Packages is the folder scripts/pack-all.ps1 fills (the CI artifact
    "packages"). A dry run that cannot reach the registry says so and goes
    on; a publish that cannot ask it fails, since it cannot know what to skip.
    Exits 0 when every package was published, skipped, or (dry run) reported;
    1 otherwise.

.EXAMPLE
    pwsh -File scripts/publish/Publish-Package.ps1 -Registry npm -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('nuget', 'npm', 'crates', 'psgallery')][string]$Registry,
    [string]$Packages,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Packages) { $Packages = Join-Path $repo 'artifacts/packages' }
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
# The registries' APIs ask for a User-Agent that names the caller.
$agent = 'bdd-code-extension-release (https://github.com/smartpcr/bdd-code-extension)'

function Test-Published([string]$Uri) {
    # $true when the URI answers, $false on 404, $null when the registry cannot be asked.
    try {
        $null = Invoke-RestMethod -Uri $Uri -UserAgent $agent -TimeoutSec 30
        return $true
    } catch {
        $status = $_.Exception.Response.StatusCode.value__
        if ($status -eq 404) { return $false }
        Write-Output "  could not ask ${Uri}: $($_.Exception.Message)"
        return $null
    }
}

function Get-Package([string]$Name) {
    $file = Join-Path $Packages $Name
    if (-not (Test-Path $file)) { throw "$file is not there: run scripts/pack-all.ps1 first." }
    return $file
}

function Invoke-Native([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE) { throw "$What failed (exit $LASTEXITCODE)" }
}

# Each package of the registry: its name, the file, the URI that exists once the version is published.
$items = switch ($Registry) {
    'nuget' {
        foreach ($id in 'Bdd.Suite', 'Bdd.Suite.Testing') {
            @{ Name = "$id $version"; File = Get-Package "$id.$version.nupkg"
                Uri = "https://api.nuget.org/v3-flatcontainer/$($id.ToLowerInvariant())/$version/$($id.ToLowerInvariant()).nuspec" }
        }
    }
    'npm' { @{ Name = "@bdd-suite/runtime $version"; File = Get-Package "bdd-suite-runtime-$version.tgz"; Uri = "https://registry.npmjs.org/@bdd-suite/runtime/$version" } }
    'crates' { @{ Name = "suiterun $version"; File = Get-Package "suiterun-$version.crate"; Uri = "https://crates.io/api/v1/crates/suiterun/$version" } }
    'psgallery' { @{ Name = "BddSuite $version"; File = Get-Package "BddSuite.$version.nupkg"; Uri = "https://www.powershellgallery.com/api/v2/package/BddSuite/$version" } }
}

$mode = if ($DryRun) { 'dry run' } else { 'publish' }
Write-Output "$Registry ($mode), version ${version}:"
foreach ($item in $items) {
    $published = Test-Published $item.Uri
    if ($published) {
        Write-Output "  $($item.Name) is already published; skipped."
        continue
    }
    if ($null -eq $published -and -not $DryRun) { throw "$Registry could not be asked whether $($item.Name) exists; nothing was published." }
    $leaf = Split-Path -Leaf $item.File
    switch ($Registry) {
        'nuget' {
            if ($DryRun) { Write-Output "  would push $leaf (and its .snupkg) to nuget.org"; break }
            if (-not $env:NUGET_API_KEY) { throw 'NUGET_API_KEY is not set: the NuGet/login step gives it.' }
            Invoke-Native "dotnet nuget push $leaf" { dotnet nuget push $item.File --api-key $env:NUGET_API_KEY --source https://api.nuget.org/v3/index.json --skip-duplicate }
        }
        'npm' {
            # npmjs.com by name: a machine's own npm configuration may name a mirror.
            if ($DryRun) { Invoke-Native "npm publish --dry-run $leaf" { npm publish $item.File --dry-run --access public --registry https://registry.npmjs.org/ }; break }
            Invoke-Native "npm publish $leaf" { npm publish $item.File --provenance --access public --registry https://registry.npmjs.org/ }
        }
        'crates' {
            # cargo publishes from the sources, which pack-all packed: the same commit.
            Push-Location (Join-Path $repo 'runtimes/rust')
            try {
                if ($DryRun) { Invoke-Native 'cargo publish --dry-run' { cargo publish --dry-run --allow-dirty }; break }
                if (-not $env:CARGO_REGISTRY_TOKEN) { throw 'CARGO_REGISTRY_TOKEN is not set: the crates.io auth step gives it.' }
                Invoke-Native 'cargo publish' { cargo publish }
            } finally {
                Pop-Location
            }
        }
        'psgallery' {
            if ($DryRun) { Write-Output "  would publish $leaf to the PowerShell Gallery"; break }
            if (-not $env:PSGALLERY_API_KEY) { throw 'PSGALLERY_API_KEY is not set: it is the release environment''s secret.' }
            Publish-PSResource -NupkgPath $item.File -Repository PSGallery -ApiKey $env:PSGALLERY_API_KEY
        }
    }
    if (-not $DryRun) { Write-Output "  published $($item.Name)." }
}
