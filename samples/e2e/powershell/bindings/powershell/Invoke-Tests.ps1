<#
.SYNOPSIS
    Runs the generated Pester tests (tests/) and writes the NUnit3 report
    (README.md, step 3 and 4).

.DESCRIPTION
    Pester and BddSuite come from .modules/ at the workspace root, at the
    versions packages.psd1 names; .modules/ is put first on this process's
    PSModulePath only. The run inputs the generated tests read come from the
    environment; the switches below set them for this run:

      -AllowGuarded  BDD_SUITE_ALLOW_GUARDED=1: run the guarded suites too
      -TraceFile     BDD_SUITE_TRACE_FILE: the run's trace, as suiterun --trace-file writes it
      -Tags          BDD_SUITE_TAGS: the suite tag filter (Pester's -TagFilter also works)

    Exits with the number of failed tests (0 when all passed or skipped).

.EXAMPLE
    pwsh -File bindings/powershell/Invoke-Tests.ps1
    pwsh -File bindings/powershell/Invoke-Tests.ps1 -FullName '*ships-in-parts'
    pwsh -File bindings/powershell/Invoke-Tests.ps1 -AllowGuarded -TraceFile out/pester-trace.json
#>
[CmdletBinding()]
param(
    [string[]]$FullName,
    [string[]]$TagFilter,
    [string]$Tags,
    [switch]$AllowGuarded,
    [string]$TraceFile,
    [string]$Results = 'out/pester-results.xml'
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$packages = Import-PowerShellDataFile (Join-Path $workspace 'packages.psd1')
$env:PSModulePath = (Join-Path $workspace '.modules') + [IO.Path]::PathSeparator + $env:PSModulePath
Import-Module Pester -RequiredVersion $packages.Pester.Version
# The generated files import BddSuite by name only when it is not loaded already: load the pinned one.
Import-Module BddSuite -RequiredVersion $packages.BddSuite.Version -DisableNameChecking

$tests = Join-Path $PSScriptRoot 'tests'
if (-not (Test-Path $tests)) { throw "No generated tests in $tests; run suiterun.ps1 generate first (README.md, step 3)." }

$set = @{}
if ($AllowGuarded) { $set.BDD_SUITE_ALLOW_GUARDED = '1' }
if ($TraceFile) { $set.BDD_SUITE_TRACE_FILE = [IO.Path]::GetFullPath($TraceFile, $workspace) }
if ($Tags) { $set.BDD_SUITE_TAGS = $Tags }
foreach ($key in $set.Keys) { Set-Item "env:$key" $set[$key] }
try {
    $config = New-PesterConfiguration
    $config.Run.Path = $tests
    $config.Run.PassThru = $true
    $config.Output.Verbosity = 'Detailed'
    $config.TestResult.Enabled = $true
    # NUnit 2.5 shows a failed suite teardown as a success; NUnit3 does not.
    $config.TestResult.OutputFormat = 'NUnit3'
    $config.TestResult.OutputPath = [IO.Path]::GetFullPath($Results, $workspace)
    if ($FullName) { $config.Filter.FullName = $FullName }
    if ($TagFilter) { $config.Filter.Tag = $TagFilter }
    $run = Invoke-Pester -Configuration $config
    Write-Output "Results written to $($config.TestResult.OutputPath.Value)"
    if ($TraceFile) { Write-Output "Trace written to $($set.BDD_SUITE_TRACE_FILE)" }
} finally {
    foreach ($key in $set.Keys) { Remove-Item "env:$key" -ErrorAction SilentlyContinue }
    # The run context outlives one Invoke-Pester otherwise.
    Reset-BddSuiteTestContext
}
exit $run.FailedCount
