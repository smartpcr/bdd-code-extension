<#
.SYNOPSIS
    Restores the packages packages.psd1 names into .modules\, this workspace's
    own module path (README.md, step 3).

.DESCRIPTION
    For each package, at its exact version:

      * Nupkg: the .nupkg is downloaded into .packages\ (or taken from -Source
        when that folder holds it), .packages\ is registered as a temporary
        PSResource repository, and Save-PSResource installs it from there.
      * Repository: Save-PSResource installs it from that repository.

    A package already in .modules\ at its version is left as it is. Nothing is
    installed into the user's or the machine's module path: suiterun.ps1 and
    Invoke-Tests.ps1 put .modules\ first on PSModulePath for their own process.

.PARAMETER Source
    A folder that already holds the .nupkg files, used instead of downloading
    them (a machine with no access to GitHub, or an internal mirror).

.PARAMETER Force
    Restore every package again, even one already in .modules\.

.EXAMPLE
    pwsh -File restore.ps1
#>
[CmdletBinding()]
param([string]$Source, [switch]$Force)

$ErrorActionPreference = 'Stop'
$packages = Import-PowerShellDataFile (Join-Path $PSScriptRoot 'packages.psd1')
$modules = Join-Path $PSScriptRoot '.modules'
$feed = Join-Path $PSScriptRoot '.packages'
New-Item -ItemType Directory -Force -Path $modules, $feed | Out-Null

# The repository-backed packages first, so BddSuite's dependency is there when it is saved.
$ordered = $packages.GetEnumerator() | Sort-Object { [bool]$_.Value.Nupkg }, Name
foreach ($entry in $ordered) {
    $name = $entry.Name
    $version = $entry.Value.Version
    if (-not $Force -and (Test-Path (Join-Path $modules "$name/$version"))) {
        Write-Output "  ok    $name $version (already in .modules)"
        continue
    }
    if ($entry.Value.Nupkg) {
        $file = Join-Path $feed "$name.$version.nupkg"
        $local = if ($Source) { Join-Path $Source "$name.$version.nupkg" }
        if ($local -and (Test-Path $local)) {
            Copy-Item $local $file -Force
        } elseif (Test-Path $entry.Value.Nupkg) {
            Copy-Item $entry.Value.Nupkg $file -Force
        } else {
            Write-Output "  get   $($entry.Value.Nupkg)"
            Invoke-WebRequest -Uri $entry.Value.Nupkg -OutFile $file
        }
        # A repository of this run's own, removed again whatever happens.
        $repository = 'bdd-suite-e2e-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
        Register-PSResourceRepository -Name $repository -Uri $feed -Trusted
        try {
            # Its dependencies come from their own entries above, not from this feed.
            Save-PSResource -Name $name -Version $version -Repository $repository -Path $modules -SkipDependencyCheck -TrustRepository -Quiet
        } finally {
            Unregister-PSResourceRepository -Name $repository
        }
    } else {
        Save-PSResource -Name $name -Version $version -Repository $entry.Value.Repository -Path $modules -TrustRepository -Quiet
    }
    if (-not (Test-Path (Join-Path $modules "$name/$version"))) { throw "$name $version was not restored into $modules." }
    Write-Output "  ok    $name $version"
}
