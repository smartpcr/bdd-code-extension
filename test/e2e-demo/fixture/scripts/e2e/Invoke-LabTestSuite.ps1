# The demo's stand-in for os-context's suite runner. It takes the runner's
# parameters, so the extension's Test Explorer runs it as it would the real
# one, and hands them to tools/fake-run.mjs, which checks each step's action
# against scripts/e2e/actions and touches no lab. The lab parameters are
# accepted and ignored.
param(
    [Parameter(Mandatory)] [string] $Path,
    [string] $TraceFile,
    [string] $ResultsFile,
    [string] $Tags,
    [string] $TestName,
    [switch] $DryRun,
    [string] $ApiUrl,
    [string] $LabId,
    [string] $ConnectionFile
)

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$argv = @((Join-Path $root 'tools/fake-run.mjs'), '--path', $Path)
if ($TraceFile) { $argv += @('--trace-file', $TraceFile) }
if ($ResultsFile) { $argv += @('--results', $ResultsFile) }
if ($Tags) { $argv += @('--tags', $Tags) }
if ($TestName) { $argv += @('--test-name', $TestName) }
if ($DryRun) { $argv += '--dry-run' }

Push-Location $root
try {
    & node @argv
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
