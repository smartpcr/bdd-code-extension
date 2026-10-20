<#
.SYNOPSIS
    Checks one built package against its expected contents and metadata
    (docs/packages, E1, DEC-P11).

.DESCRIPTION
    A package is what a stranger installs, and a registry never takes a version
    back, so before anything is published each package must hold exactly the
    files its list in packaging/ names (no test, corpus or build output, nothing
    missing) and carry the release version, the license, the README and the
    repository.

      NuGet     <id>.<version>.nupkg          packaging/<id>.files.txt; the
                                              archive's bookkeeping
                                              ([Content_Types].xml, _rels/,
                                              package/) is not listed
      PowerShell BddSuite.<version>.nupkg     packaging/BddSuite.files.txt; a
                                              NuGet package Publish-PSResource
                                              packed (its tags say PSModule)
      Go       <feed>/<module>/@v/v<version>.zip
                                              packaging/runtimes-go.files.txt,
                                              without the <module>@<version>/
                                              prefix every entry carries
      Rust      <name>-<version>.crate        packaging/<name>.files.txt,
                                              without the <name>-<version>/
                                              prefix

    Exits 0 when the package conforms, 1 with one line per difference when it
    does not.

.EXAMPLE
    pwsh -File scripts/Test-PackageContents.ps1 -Package runtimes/csharp/artifacts/packages/Bdd.Suite.0.6.10.nupkg
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Package,
    # Default: packaging/<id>.files.txt, the id read from the package's name.
    [string]$Expected
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repo = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$leaf = Split-Path -Leaf $Package
$name = [IO.Path]::GetFileNameWithoutExtension($Package)
$escaped = [regex]::Escape($version)

# What kind of package, its id, and the prefix every entry carries.
if ($name -ceq "v$version" -and $Package -match '[\\/]@v[\\/]') {
    $kind, $id, $prefix = 'go', 'runtimes-go', "github.com/smartpcr/bdd-code-extension/runtimes/go@v$version/"
} elseif ($leaf -match "^(?<id>.+)-$escaped\.crate$") {
    $kind, $id = 'crate', $Matches.id
    $prefix = "$id-$version/"
} elseif ($leaf -match "^(?<id>.+)-$escaped\.tgz$") {
    # npm pack names @scope/name scope-name-<version>.tgz; every entry is under package/.
    $kind, $id, $prefix = 'npm', $Matches.id, 'package/'
} elseif ($leaf -match "^(?<id>.+)\.$escaped\.nupkg$") {
    $kind, $id, $prefix = 'nuget', $Matches.id, ''
} else {
    Write-Output "$Package is not a package of version ${version}: every package carries the release version (DEC-P03)."
    exit 1
}
if (-not $Expected) { $Expected = Join-Path $repo "packaging/$id.files.txt" }

# Every file the archive holds, and a way to read one of them as text.
$files = @{}
if ($kind -in 'crate', 'npm') {
    # A gzipped tar, read with .NET itself rather than whichever tar is on PATH.
    $stream = [IO.File]::OpenRead((Resolve-Path $Package))
    try {
        $tar = [Formats.Tar.TarReader]::new([IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionMode]::Decompress))
        while ($null -ne ($entry = $tar.GetNextEntry())) {
            if ($entry.EntryType -notin [Formats.Tar.TarEntryType]::RegularFile, [Formats.Tar.TarEntryType]::V7RegularFile) { continue }
            $text = if ($entry.DataStream) { [IO.StreamReader]::new($entry.DataStream).ReadToEnd() } else { '' }
            $files[$entry.Name] = $text
        }
    } finally {
        $stream.Dispose()
    }
} else {
    $archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $Package))
    try {
        foreach ($entry in $archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') }) {
            $path = if ($kind -eq 'nuget') { [Uri]::UnescapeDataString($entry.FullName) } else { $entry.FullName }
            if ($kind -eq 'nuget' -and $path -match '^(\[Content_Types\]\.xml|_rels/|package/)') { continue }
            $reader = [IO.StreamReader]::new($entry.Open())
            try { $files[$path] = $reader.ReadToEnd() } finally { $reader.Dispose() }
        }
    } finally {
        $archive.Dispose()
    }
}

$problems = [Collections.Generic.List[string]]::new()
$outside = @($files.Keys | Where-Object { -not $_.StartsWith($prefix) })
if ($outside) { $problems.Add("holds entries outside $prefix ($($outside[0]))") }
$held = @($files.Keys | ForEach-Object { $_.Substring([Math]::Min($prefix.Length, $_.Length)) } | Sort-Object)
function Text([string]$Relative) { $files["$prefix$Relative"] }

$wanted = @(Get-Content $Expected | Where-Object { $_ -and -not $_.StartsWith('#') } | Sort-Object)
foreach ($extra in $held | Where-Object { $wanted -cnotcontains $_ }) { $problems.Add("holds $extra, which $Expected does not list") }
foreach ($missing in $wanted | Where-Object { $held -cnotcontains $_ }) { $problems.Add("lacks $missing") }

switch ($kind) {
    'nuget' {
        $nuspec = $held | Where-Object { $_ -like '*.nuspec' } | Select-Object -First 1
        if (-not $nuspec) { $problems.Add('it holds no .nuspec'); break }
        $metadata = ([xml](Text $nuspec)).package.metadata
        if ($metadata.id -cne $id) { $problems.Add("its id is $($metadata.id), not $id") }
        if ($metadata.version -ne $version) { $problems.Add("its version is $($metadata.version), not package.json's $version") }
        if (-not $metadata.description) { $problems.Add('it has no description') }
        if ("$($metadata.tags)" -split ' ' -ccontains 'PSModule') {
            # A PowerShell module, as Publish-PSResource packs it: its manifest
            # is the metadata, a license and project link rather than an
            # expression and a README, and the license file itself inside.
            $manifest = Text "$id.psd1"
            if ($manifest -notmatch "(?m)^\s*ModuleVersion\s*=\s*'$escaped'") { $problems.Add("its $id.psd1 is not version $version") }
            if ($metadata.licenseUrl -ne 'https://github.com/smartpcr/bdd-code-extension/blob/main/LICENSE') { $problems.Add('it links no license') }
            if ($metadata.projectUrl -notlike 'https://github.com/smartpcr/bdd-code-extension*') { $problems.Add('it names no project') }
            if ($held -cnotcontains 'LICENSE') { $problems.Add('it holds no LICENSE') }
            $said = 'module manifest, LICENSE, license and project links'
            break
        }
        if ($metadata.license.'#text' -ne 'MIT') { $problems.Add('it declares no MIT license expression') }
        if (-not $metadata.readme -or $held -cnotcontains $metadata.readme) { $problems.Add('it names no README it holds') }
        if ($metadata.repository.url -ne 'https://github.com/smartpcr/bdd-code-extension') { $problems.Add('it names no repository') }
        $said = 'MIT, README, repository'
    }
    'go' {
        if ((Text 'go.mod') -notmatch '(?m)^module github\.com/smartpcr/bdd-code-extension/runtimes/go\s*$') { $problems.Add('its go.mod does not name the module') }
        foreach ($file in 'LICENSE', 'README.md') { if ($held -cnotcontains $file) { $problems.Add("it holds no $file") } }
        $said = 'go.mod, LICENSE, README'
    }
    'crate' {
        $manifest = Text 'Cargo.toml'
        foreach ($rule in @(
                @("(?m)^name = `"$([regex]::Escape($id))`"", "it is not named $id"),
                @("(?m)^version = `"$escaped`"", "its version is not package.json's $version"),
                @('(?m)^license = "MIT"', 'it declares no MIT license'),
                @('(?m)^repository = "https://github\.com/smartpcr/bdd-code-extension"', 'it names no repository'),
                @('(?m)^readme = "README\.md"', 'it names no README'),
                @('(?m)^description = "', 'it has no description'))) {
            if ($manifest -notmatch $rule[0]) { $problems.Add($rule[1]) }
        }
        foreach ($file in 'LICENSE', 'README.md') { if ($held -cnotcontains $file) { $problems.Add("it holds no $file") } }
        $said = 'MIT, README, LICENSE, repository'
    }
    'npm' {
        $manifest = (Text 'package.json') | ConvertFrom-Json
        if (($manifest.name -replace '^@', '' -replace '/', '-') -cne $id) { $problems.Add("its name $($manifest.name) is not $id") }
        if ($manifest.version -ne $version) { $problems.Add("its version is $($manifest.version), not package.json's $version") }
        if ($manifest.license -ne 'MIT') { $problems.Add('it declares no MIT license') }
        if ($manifest.repository.url -notmatch 'github\.com/smartpcr/bdd-code-extension') { $problems.Add('it names no repository') }
        if ($manifest.private) { $problems.Add('it is private') }
        if (-not $manifest.description) { $problems.Add('it has no description') }
        foreach ($file in 'LICENSE', 'README.md') { if ($held -cnotcontains $file) { $problems.Add("it holds no $file") } }
        $said = 'MIT, README, LICENSE, repository'
    }
}

if ($problems.Count) {
    Write-Output "${leaf}:"
    $problems | ForEach-Object { Write-Output "  $_" }
    exit 1
}
Write-Output "${leaf}: $($held.Count) files as listed, version $version, $said"
