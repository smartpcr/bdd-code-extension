<#
.SYNOPSIS
    Checks one built package against its expected contents and metadata
    (docs/packages, E1, DEC-P11).

.DESCRIPTION
    A package is what a stranger installs, and a registry never takes a version
    back, so before anything is published each package must hold exactly the
    files its list in packaging/ names (no test, corpus or build output, nothing
    missing) and carry the release version, the license, the README and the
    repository. The archive's own bookkeeping ([Content_Types].xml, _rels/,
    package/) is not listed.

    Exits 0 when the package conforms, 1 with one line per difference when it
    does not.

.EXAMPLE
    pwsh -File scripts/Test-PackageContents.ps1 -Package runtimes/csharp/artifacts/packages/Bdd.Suite.0.6.10.nupkg
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Package,
    # Default: packaging/<id>.files.txt, the id read from the package's file name.
    [string]$Expected
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repo = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$name = [IO.Path]::GetFileNameWithoutExtension($Package)
if ($name -notmatch "^(?<id>.+)\.$([regex]::Escape($version))$") {
    Write-Output "$Package is not named <id>.${version}: every package carries the release version (DEC-P03)."
    exit 1
}
$id = $Matches.id
if (-not $Expected) { $Expected = Join-Path $repo "packaging/$id.files.txt" }

$problems = [Collections.Generic.List[string]]::new()
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $Package))
try {
    $held = @($archive.Entries | Where-Object { $_.FullName -notmatch '^(\[Content_Types\]\.xml|_rels/|package/)' -and -not $_.FullName.EndsWith('/') } |
        ForEach-Object { [Uri]::UnescapeDataString($_.FullName) } | Sort-Object)
    $wanted = @(Get-Content $Expected | Where-Object { $_ -and -not $_.StartsWith('#') } | Sort-Object)
    foreach ($extra in $held | Where-Object { $wanted -cnotcontains $_ }) { $problems.Add("holds $extra, which $Expected does not list") }
    foreach ($missing in $wanted | Where-Object { $held -cnotcontains $_ }) { $problems.Add("lacks $missing") }

    $nuspec = $archive.Entries | Where-Object { $_.FullName -like '*.nuspec' } | Select-Object -First 1
    if ($nuspec) {
        $reader = [IO.StreamReader]::new($nuspec.Open())
        try { [xml]$document = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $metadata = $document.package.metadata
        if ($metadata.id -cne $id) { $problems.Add("its id is $($metadata.id), not $id") }
        if ($metadata.version -ne $version) { $problems.Add("its version is $($metadata.version), not package.json's $version") }
        if ($metadata.license.'#text' -ne 'MIT') { $problems.Add('it declares no MIT license expression') }
        if (-not $metadata.readme -or $held -cnotcontains $metadata.readme) { $problems.Add('it names no README it holds') }
        if ($metadata.repository.url -ne 'https://github.com/smartpcr/bdd-code-extension') { $problems.Add('it names no repository') }
        if (-not $metadata.description) { $problems.Add('it has no description') }
    } else {
        $problems.Add('it holds no .nuspec')
    }
} finally {
    $archive.Dispose()
}

if ($problems.Count) {
    Write-Output "$(Split-Path -Leaf $Package):"
    $problems | ForEach-Object { Write-Output "  $_" }
    exit 1
}
Write-Output "$(Split-Path -Leaf $Package): $($held.Count) files as listed, version $version, MIT, README, repository"
