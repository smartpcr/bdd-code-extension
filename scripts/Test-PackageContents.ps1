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

    A Go module zip (<feed>/<module>/@v/v<version>.zip) is listed as
    packaging/runtimes-go.files.txt, without the <module>@<version>/ prefix
    every entry carries, and must hold go.mod naming the module, a LICENSE and a
    README.

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
$goModule = $name -ceq "v$version" -and $Package -match '[\\/]@v[\\/]'
if ($goModule) {
    $id = 'runtimes-go'
} elseif ($name -notmatch "^(?<id>.+)\.$([regex]::Escape($version))$") {
    Write-Output "$Package is not named <id>.${version}: every package carries the release version (DEC-P03)."
    exit 1
}
if (-not $goModule) { $id = $Matches.id }
if (-not $Expected) { $Expected = Join-Path $repo "packaging/$id.files.txt" }

$problems = [Collections.Generic.List[string]]::new()
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $Package))
try {
    $held = @($archive.Entries | Where-Object { $_.FullName -notmatch '^(\[Content_Types\]\.xml|_rels/|package/)' -and -not $_.FullName.EndsWith('/') } |
        ForEach-Object { if ($goModule) { $_.FullName } else { [Uri]::UnescapeDataString($_.FullName) } } | Sort-Object)
    if ($goModule) {
        $prefix = "github.com/smartpcr/bdd-code-extension/runtimes/go@v$version/"
        $outside = @($held | Where-Object { -not $_.StartsWith($prefix) })
        if ($outside) { $problems.Add("holds entries outside $prefix ($($outside[0]))") }
        $held = @($held | ForEach-Object { $_.Substring([Math]::Min($prefix.Length, $_.Length)) } | Sort-Object)
    }
    $wanted = @(Get-Content $Expected | Where-Object { $_ -and -not $_.StartsWith('#') } | Sort-Object)
    foreach ($extra in $held | Where-Object { $wanted -cnotcontains $_ }) { $problems.Add("holds $extra, which $Expected does not list") }
    foreach ($missing in $wanted | Where-Object { $held -cnotcontains $_ }) { $problems.Add("lacks $missing") }

    $nuspec = $archive.Entries | Where-Object { $_.FullName -like '*.nuspec' } | Select-Object -First 1
    if ($goModule) {
        $goMod = $archive.Entries | Where-Object { $_.FullName -ceq "${prefix}go.mod" } | Select-Object -First 1
        $reader = if ($goMod) { [IO.StreamReader]::new($goMod.Open()) }
        $text = if ($reader) { try { $reader.ReadToEnd() } finally { $reader.Dispose() } } else { '' }
        if ($text -notmatch '(?m)^module github\.com/smartpcr/bdd-code-extension/runtimes/go\s*$') { $problems.Add('its go.mod does not name the module') }
        foreach ($file in 'LICENSE', 'README.md') { if ($held -cnotcontains $file) { $problems.Add("it holds no $file") } }
    } elseif ($nuspec) {
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
Write-Output "$(Split-Path -Leaf $Package): $($held.Count) files as listed, version $version, $(if ($goModule) { 'go.mod, LICENSE, README' } else { 'MIT, README, repository' })"
