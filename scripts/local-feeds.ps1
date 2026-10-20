<#
.SYNOPSIS
    Packs the runtimes into local feeds a consumer installs from exactly as from
    a registry (docs/packages, DEC-P09, D15), and checks each package's contents.

.DESCRIPTION
    Nothing is published: every feed is a folder under artifacts/feeds/ at the
    repository root (git-ignored). A consumer sample names that folder as a
    package source, so it proves the very files a release would publish.

      nuget   Bdd.Suite and Bdd.Suite.Testing (.nupkg and .snupkg), Release

    Each package is checked with Test-PackageContents.ps1 against its list in
    packaging/. Exits 1 when a pack or a check fails.

.EXAMPLE
    pwsh -File scripts/local-feeds.ps1 -Language csharp
#>
[CmdletBinding()]
param(
    [ValidateSet('csharp')][string[]]$Language = @('csharp'),
    [string]$Out
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $repo 'artifacts/feeds' }

foreach ($language in $Language) {
    switch ($language) {
        'csharp' {
            $feed = Join-Path $Out 'nuget'
            New-Item -ItemType Directory -Force -Path $feed | Out-Null
            # A feed holds only this pack's files, so nothing stale is installed.
            Get-ChildItem $feed -Filter 'Bdd.Suite*' | Remove-Item -Force
            dotnet pack (Join-Path $repo 'runtimes/csharp/Bdd.Suite.sln') -c Release -o $feed --nologo -v q
            if ($LASTEXITCODE) { throw 'dotnet pack failed' }
            foreach ($package in Get-ChildItem $feed -Filter '*.nupkg') {
                & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Test-PackageContents.ps1') -Package $package.FullName
                if ($LASTEXITCODE) { throw "$($package.Name) does not hold what packaging/ lists" }
            }
            Write-Output "nuget feed: $feed"
        }
    }
}
