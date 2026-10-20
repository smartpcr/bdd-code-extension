<#
.SYNOPSIS
    Writes (or, with -Check, checks) the Pester tests generated from this
    sample's two configs, each beside its config.

.DESCRIPTION
    pwsh -File generate.ps1 [-Check]

    The generated *.Bdd.Tests.ps1 files are committed; -Check exits 1 naming
    each one that is stale (docs/test-providers, DEC-T10).
#>
param([switch]$Check)
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot '../../../../runtimes/powershell/BddSuite/BddSuite.psd1'
Import-Module $runtime -DisableNameChecking
$code = 0
foreach ($config in @('shop', 'corpus')) {
    $outcome = Invoke-BddSuiteGenerate -Config (Join-Path $PSScriptRoot "$config/bddsuite.tests.yaml") -Check:$Check
    if ($outcome.Out) { Write-Output $outcome.Out }
    if ($outcome.Errors) { [Console]::Error.WriteLine("suiterun: $($outcome.Errors)") }
    $code = [Math]::Max($code, [int]$outcome.Code)
}
exit $code
