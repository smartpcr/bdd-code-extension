<#
.SYNOPSIS
    Runs the generated Pester tests: imports the BddSuite runtime (which the
    generated files expect to find loaded), runs Invoke-Pester, and forgets
    the run context afterwards (T0: a module's state outlives one run).

.DESCRIPTION
    pwsh -File Invoke-Tests.ps1 [-Path shop,corpus] [-FullNameFilter <name>] [-TagFilter <tag>]
                                [-ResultsFile results.xml] [-Output Detailed] [-SkipRun]

    The run context reads the environment (spec/session.md): BDD_SUITE_TAGS,
    BDD_SUITE_ALLOW_GUARDED=1, BDD_SUITE_TRACE_FILE, BDD_SUITE_RECORD_PATH,
    BDD_SUITE_OPTION_STORE, BDD_SUITE_PARAM_<NAME>. -ResultsFile writes NUnit3,
    the format that shows a failed teardown (NUnit 2.5 shows it as a
    success). Exit 0 when everything passed, 1 otherwise. -SkipRun is
    discovery only, and prints each test's full name.
#>
param(
    [string[]]$Path = @('shop', 'corpus'),
    [string[]]$FullNameFilter = @(),
    [string[]]$TagFilter = @(),
    [string]$ResultsFile = '',
    [ValidateSet('None', 'Normal', 'Detailed', 'Diagnostic')][string]$Output = 'Normal',
    [switch]$SkipRun
)
$ErrorActionPreference = 'Stop'
# pwsh -File passes a list as one string: a,b is two paths (a full name may
# hold a comma, so -FullNameFilter is one name).
$Path = @($Path | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$TagFilter = @($TagFilter | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
Import-Module Pester -MinimumVersion 5.0 -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot '../../../../runtimes/powershell/BddSuite/BddSuite.psd1') -DisableNameChecking

$configuration = New-PesterConfiguration
$configuration.Run.Path = @($Path | ForEach-Object { Join-Path $PSScriptRoot $_ })
$configuration.Run.PassThru = $true
$configuration.Run.SkipRun = [bool]$SkipRun
$configuration.Output.Verbosity = $Output
if ($FullNameFilter.Count) { $configuration.Filter.FullName = $FullNameFilter }
if ($TagFilter.Count) { $configuration.Filter.Tag = $TagFilter }
if ($ResultsFile) {
    $configuration.TestResult.Enabled = $true
    $configuration.TestResult.OutputFormat = 'NUnit3'
    $configuration.TestResult.OutputPath = $ResultsFile
}
try {
    $result = Invoke-Pester -Configuration $configuration
} finally {
    Reset-BddSuiteTestContext
}
if ($SkipRun) {
    foreach ($test in @($result.Tests)) { Write-Output $test.ExpandedPath }
    exit 0
}
exit $(if ($result.Result -eq 'Passed') { 0 } else { 1 })
