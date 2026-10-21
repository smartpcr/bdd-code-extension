<#
.SYNOPSIS
    Packs the runtimes into local feeds a consumer installs from exactly as from
    a registry (docs/packages, DEC-P09, D15), and checks each package's contents.

.DESCRIPTION
    Nothing is published: every feed is a folder under artifacts/feeds/ at the
    repository root (git-ignored). A consumer sample names that folder as a
    package source, so it proves the very files a release would publish.

      nuget    Smartpcr.BddSuite and Smartpcr.BddSuite.Testing (.nupkg and .snupkg), Release
      goproxy  the Go module github.com/smartpcr/bdd-code-extension/runtimes/go at
               v<version>, in the module proxy's layout, for GOPROXY=file:///...
      cargo    the crate suiterun-<version>.crate (cargo package, which builds
               it from its packaged files), and the same unpacked beside it,
               which a consumer's [patch.crates-io] can name
      npm      @bdd-suite/runtime as bdd-suite-runtime-<version>.tgz (npm pack,
               which builds dist/ first)
      psresource  the BddSuite module as BddSuite.<version>.nupkg
               (Publish-PSResource to a file repository), with the
               powershell-yaml it requires, so Install-PSResource needs
               nothing else

    Each package is checked with Test-PackageContents.ps1 against its list in
    packaging/ (the Go zip is also made, and so checked, by golang.org/x/mod/zip).
    Exits 1 when a pack or a check fails.

.EXAMPLE
    pwsh -File scripts/local-feeds.ps1 -Language csharp, go, rust, typescript, powershell
#>
[CmdletBinding()]
param(
    [ValidateSet('csharp', 'go', 'rust', 'typescript', 'powershell')][string[]]$Language = @('csharp', 'go', 'rust', 'typescript', 'powershell'),
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
            Get-ChildItem $feed -Filter 'Smartpcr.BddSuite*' | Remove-Item -Force
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
        'rust' {
            $feed = Join-Path $Out 'cargo'
            $version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
            New-Item -ItemType Directory -Force -Path $feed | Out-Null
            Get-ChildItem $feed -Filter 'suiterun-*' | Remove-Item -Recurse -Force
            Push-Location (Join-Path $repo 'runtimes/rust')
            try {
                # --allow-dirty: a feed is built from the working tree, committed or not.
                cargo package --allow-dirty --quiet
                if ($LASTEXITCODE) { throw 'cargo package failed' }
            } finally {
                Pop-Location
            }
            $crate = Join-Path $feed "suiterun-$version.crate"
            Copy-Item (Join-Path $repo "runtimes/rust/target/package/suiterun-$version.crate") $crate
            & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Test-PackageContents.ps1') -Package $crate
            if ($LASTEXITCODE) { throw "suiterun-$version.crate does not hold what packaging/suiterun.files.txt lists" }
            $stream = [IO.File]::OpenRead($crate)
            try {
                [Formats.Tar.TarFile]::ExtractToDirectory([IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionMode]::Decompress), $feed, $true)
            } finally {
                $stream.Dispose()
            }
            Write-Output "cargo feed: $feed"
        }
        'typescript' {
            $feed = Join-Path $Out 'npm'
            New-Item -ItemType Directory -Force -Path $feed | Out-Null
            Get-ChildItem $feed -Filter 'bdd-suite-runtime-*.tgz' | Remove-Item -Force
            Push-Location (Join-Path $repo 'runtimes/typescript')
            try {
                npm pack --pack-destination $feed --silent | Out-Null
                if ($LASTEXITCODE) { throw 'npm pack failed' }
            } finally {
                Pop-Location
            }
            foreach ($package in Get-ChildItem $feed -Filter '*.tgz') {
                & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Test-PackageContents.ps1') -Package $package.FullName
                if ($LASTEXITCODE) { throw "$($package.Name) does not hold what packaging/ lists" }
            }
            Write-Output "npm feed: $feed"
        }
        'powershell' {
            $feed = Join-Path $Out 'psresource'
            New-Item -ItemType Directory -Force -Path $feed | Out-Null
            Get-ChildItem $feed -Filter '*.nupkg' | Remove-Item -Force
            # A repository registered for this pack alone, under a name no one else uses.
            $name = 'bdd-suite-local-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
            Register-PSResourceRepository -Name $name -Uri $feed -Trusted
            try {
                Publish-PSResource -Path (Join-Path $repo 'runtimes/powershell/BddSuite') -Repository $name -SkipDependenciesCheck
                # The YAML reader BddSuite requires, from this machine, so the
                # feed alone installs the module as the Gallery would.
                $manifest = Import-PowerShellDataFile (Join-Path $repo 'runtimes/powershell/BddSuite/BddSuite.psd1')
                $yaml = $manifest.RequiredModules | Where-Object { $_.ModuleName -eq 'powershell-yaml' }
                $installed = Get-Module powershell-yaml -ListAvailable | Where-Object { $_.Version -ge [version]$yaml.ModuleVersion } |
                    Sort-Object Version -Descending | Select-Object -First 1
                if (-not $installed) { throw "powershell-yaml $($yaml.ModuleVersion) or later is not installed: Install-PSResource powershell-yaml" }
                Publish-PSResource -Path $installed.ModuleBase -Repository $name -SkipDependenciesCheck
            } finally {
                Unregister-PSResourceRepository -Name $name
            }
            $version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
            & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Test-PackageContents.ps1') -Package (Join-Path $feed "BddSuite.$version.nupkg")
            if ($LASTEXITCODE) { throw "BddSuite.$version.nupkg does not hold what packaging/BddSuite.files.txt lists" }
            Write-Output "psresource feed: $feed"
        }
    }
}
