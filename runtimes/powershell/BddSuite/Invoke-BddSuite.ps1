<#
.SYNOPSIS
    Lint and run BDD suites from the command line: the PowerShell runtime's
    suiterun.

.DESCRIPTION
    A thin entry over BddSuite's Invoke-BddSuite, which does the work. It
    exists for a caller that runs a script rather than importing a module (a
    CI step, `pwsh -File`), and it sets the process exit code: 0 when every
    selected case passed, 1 when one failed, 2 when the lint refused a suite or
    the run could not start.

    -Option takes name=value, repeatable, because a hashtable cannot cross
    `pwsh -File`; it becomes Invoke-BddSuite's -Option @{ name = value }.
    -Json prints the lint's diagnostics as the one document on standard
    output (spec/diagnostic.schema.json), and nothing else.

.EXAMPLE
    pwsh -File runtimes/powershell/BddSuite/Invoke-BddSuite.ps1 -Path suites/*.yml -SchemaRoot schema -Lint

.EXAMPLE
    pwsh -File runtimes/powershell/BddSuite/Invoke-BddSuite.ps1 -Path suites/echo.yml -SchemaRoot schema `
        -Extension example/BddSuite.Example.psm1 -Option region=eu
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string[]]$Path,
    [string]$Tags = '',
    [string]$TestName = '',
    [string]$ResultsFile = 'test-results.xml',
    [ValidateSet('NUnit3', 'JUnit')][string]$ReportFormat = 'NUnit3',
    [switch]$DryRun,
    [switch]$Lint,
    [switch]$Strict,
    [switch]$Json,
    [string[]]$Param = @(),
    [string]$TraceFile = '',
    [string]$TimingFile = '',
    [string]$StopFile = '',
    [string]$SchemaRoot,
    [string[]]$ActionPath = @(),
    [string[]]$Extension = @(),
    [string[]]$Option = @(),
    [string]$Binding = 'powershell',
    [switch]$BindingCheck
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BddSuite.psd1') -Force -DisableNameChecking

$options = @{}
foreach ($pair in @($Option)) {
    if ($pair -notmatch '^([A-Za-z][A-Za-z0-9]*)=(.*)$') {
        Write-Host "[HARNESS ERROR] -Option takes name=value; got '$pair'." -ForegroundColor Red
        exit 2
    }
    $options[$Matches[1]] = $Matches[2]
}
$arguments = @{} + $PSBoundParameters
$arguments['Option'] = $options

$outcome = Invoke-BddSuite @arguments
if ($Json) {
    # One document on standard output, and nothing else. Passing the array
    # through -InputObject keeps it an array: no findings is [], one finding is
    # a one-element array.
    if ($outcome.Error) { [Console]::Error.WriteLine("[HARNESS ERROR] $($outcome.Error)") }
    # Each finding with its keys in the order diagnostic.schema.json lists them.
    $findings = @(foreach ($finding in @($outcome.Diagnostics)) {
            if ($null -eq $finding) { continue }
            $ordered = [ordered]@{}
            foreach ($key in @('code', 'severity', 'file', 'line', 'column', 'message', 'suggestion')) {
                if ($finding.Contains($key) -and $null -ne $finding[$key]) { $ordered[$key] = $finding[$key] }
            }
            $ordered
        })
    $document = ConvertTo-Json -InputObject $findings -Depth 6
    if (-not $findings.Count) { $document = '[]' }
    Write-Output $document
}
exit $outcome.ExitCode
