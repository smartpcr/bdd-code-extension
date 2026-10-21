<#
.SYNOPSIS
    Packs every package of this release once, checks each against its expected
    contents, and gathers the publishable files (docs/packages, E1, D15, D16).

.DESCRIPTION
    1. scripts/local-feeds.ps1 for all five languages, into -Feeds
       (artifacts/feeds by default): the local feeds a consumer installs from
       (E2 to E6), each package checked with Test-PackageContents.ps1 against
       packaging/ (E1), the Go module zip included.
    2. The files a release publishes, into -Out (artifacts/packages by
       default, emptied first): Bdd.Suite and Bdd.Suite.Testing (.nupkg and
       .snupkg), suiterun-<version>.crate, bdd-suite-runtime-<version>.tgz and
       BddSuite.<version>.nupkg. The Go module has no file: Go reads the tag.

    The TypeScript runtime's dependencies are installed first when they are
    not (npm pack builds it). Exits 1 when a pack or a check fails, or a file
    a release needs is missing.

.EXAMPLE
    pwsh -File scripts/pack-all.ps1
#>
[CmdletBinding()]
param(
    [string]$Out,
    [string]$Feeds
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $repo 'artifacts/packages' }
if (-not $Feeds) { $Feeds = Join-Path $repo 'artifacts/feeds' }
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version

if (-not (Test-Path (Join-Path $repo 'runtimes/typescript/node_modules'))) {
    Push-Location (Join-Path $repo 'runtimes/typescript')
    try {
        npm ci --no-audit --no-fund
        if ($LASTEXITCODE) { throw 'npm ci in runtimes/typescript failed' }
    } finally {
        Pop-Location
    }
}

& (Join-Path $PSScriptRoot 'local-feeds.ps1') -Language csharp, go, rust, typescript, powershell -Out $Feeds

Remove-Item $Out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$wanted = @(
    "nuget/Bdd.Suite.$version.nupkg", "nuget/Bdd.Suite.$version.snupkg",
    "nuget/Bdd.Suite.Testing.$version.nupkg", "nuget/Bdd.Suite.Testing.$version.snupkg",
    "cargo/suiterun-$version.crate",
    "npm/bdd-suite-runtime-$version.tgz",
    "psresource/BddSuite.$version.nupkg"
)
foreach ($relative in $wanted) {
    $file = Join-Path $Feeds $relative
    if (-not (Test-Path $file)) { throw "$relative is not in $Feeds after packing" }
    Copy-Item $file $Out
}
Write-Output "packages in ${Out}:"
Get-ChildItem $Out | Sort-Object Name | ForEach-Object { Write-Output ("  {0,-40} {1,9:N0} bytes" -f $_.Name, $_.Length) }
