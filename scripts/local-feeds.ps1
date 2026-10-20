<#
.SYNOPSIS
    Packs the runtimes into local feeds a consumer installs from exactly as from
    a registry (docs/packages, DEC-P09, D15), and checks each package's contents.

.DESCRIPTION
    Nothing is published: every feed is a folder under artifacts/feeds/ at the
    repository root (git-ignored). A consumer sample names that folder as a
    package source, so it proves the very files a release would publish.

      nuget    Bdd.Suite and Bdd.Suite.Testing (.nupkg and .snupkg), Release
      goproxy  the Go module github.com/smartpcr/bdd-code-extension/runtimes/go at
               v<version>, in the module proxy's layout, for GOPROXY=file:///...

    Each package is checked with Test-PackageContents.ps1 against its list in
    packaging/ (the Go zip is also made, and so checked, by golang.org/x/mod/zip).
    Exits 1 when a pack or a check fails.

.EXAMPLE
    pwsh -File scripts/local-feeds.ps1 -Language csharp, go
#>
[CmdletBinding()]
param(
    [ValidateSet('csharp', 'go')][string[]]$Language = @('csharp', 'go'),
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
        'go' {
            $feed = Join-Path $Out 'goproxy'
            $version = 'v' + (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
            $module = Join-Path $feed 'github.com/smartpcr/bdd-code-extension/runtimes/go'
            Remove-Item $module -Recurse -Force -ErrorAction SilentlyContinue
            Push-Location (Join-Path $repo 'scripts/go-module-zip')
            try {
                go run . -dir (Join-Path $repo 'runtimes/go') -version $version -out $feed
                if ($LASTEXITCODE) { throw 'the Go module zip failed' }
            } finally {
                Pop-Location
            }
            & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Test-PackageContents.ps1') -Package (Join-Path $module "@v/$version.zip")
            if ($LASTEXITCODE) { throw 'the Go module zip does not hold what packaging/runtimes-go.files.txt lists' }
            Write-Output "goproxy feed: $feed"
        }
    }
}
