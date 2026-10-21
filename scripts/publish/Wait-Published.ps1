<#
.SYNOPSIS
    Waits until a public registry serves this release's package to installers
    (docs/packages, E11, DEC-P10).

.DESCRIPTION
    A registry takes a version before it serves it: nuget.org indexes for
    minutes to tens of minutes, and proxy.golang.org fetches a module version
    on its first request. The address polled is the one each installer reads,
    not the registry's web page:

      nuget      the flat container dotnet restore downloads from
                 (Smartpcr.BddSuite and Smartpcr.BddSuite.Testing)
      npm        the package document npm install reads (not the version's
                 own, which a new package serves first)
      crates     the sparse index cargo reads (index.crates.io)
      psgallery  the Gallery's package endpoint PSResourceGet saves from
      go         proxy.golang.org's .info for the module version (the tag)

    Polls every -IntervalSec until every address answers, or fails after
    -TimeoutMinutes (60, E11's limit). Exits 0 when served, 1 on timeout.

.EXAMPLE
    pwsh -File scripts/publish/Wait-Published.ps1 -Registry nuget
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('nuget', 'npm', 'crates', 'psgallery', 'go')][string]$Registry,
    [int]$TimeoutMinutes = 60,
    [int]$IntervalSec = 30
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$agent = 'bdd-code-extension-release (https://github.com/smartpcr/bdd-code-extension)'

# Each address, and whether its answer shows the version.
$probes = switch ($Registry) {
    'nuget' {
        foreach ($id in 'smartpcr.bddsuite', 'smartpcr.bddsuite.testing') {
            @{ Uri = "https://api.nuget.org/v3-flatcontainer/$id/index.json"; Served = { param($r) @($r.versions) -contains $version } }
        }
    }
    # The package document npm install reads, not the version's own: for a new
    # package the version's answers first, and an install in between fails E404 (0.7.4).
    'npm' { @{ Uri = 'https://registry.npmjs.org/@bdd-suite%2fruntime'; Served = { param($r) @($r.versions.PSObject.Properties.Name) -contains $version } } }
    'crates' {
        # One JSON object per line, one line per version.
        @{ Uri = 'https://index.crates.io/su/it/suiterun'; Served = { param($r) @("$r" -split "`n" | Where-Object { $_ } | ForEach-Object { ($_ | ConvertFrom-Json).vers }) -contains $version } }
    }
    'psgallery' { @{ Uri = "https://www.powershellgallery.com/api/v2/package/BddSuite/$version"; Served = { param($r) $true } } }
    'go' { @{ Uri = "https://proxy.golang.org/github.com/smartpcr/bdd-code-extension/runtimes/go/@v/v$version.info"; Served = { param($r) $r.Version -eq "v$version" } } }
}

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$started = Get-Date
foreach ($probe in $probes) {
    for (;;) {
        $served = $false
        try {
            $answer = Invoke-RestMethod -Uri $probe.Uri -UserAgent $agent -TimeoutSec 30
            $served = [bool](& $probe.Served $answer)
            $why = if ($served) { 'served' } else { 'not yet listed' }
        } catch {
            $why = $_.Exception.Message
        }
        if ($served) {
            Write-Output ("{0} {1}: served after {2:N0} s ({3})" -f $Registry, $version, ((Get-Date) - $started).TotalSeconds, $probe.Uri)
            break
        }
        if ((Get-Date) -gt $deadline) {
            Write-Output "$Registry ${version}: not served within $TimeoutMinutes minutes ($($probe.Uri): $why)"
            exit 1
        }
        Write-Output "$Registry ${version}: waiting ($why)"
        Start-Sleep -Seconds $IntervalSec
    }
}
