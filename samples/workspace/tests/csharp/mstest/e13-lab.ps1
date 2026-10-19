<#
.SYNOPSIS
    E13 for MSTest (docs/test-providers/design.md): a guarded suite runs against
    a real lab through generated MSTest tests, and its results equal suiterun's.

.DESCRIPTION
    Remote acceptance, stage T9. Run it on the controller that reaches the lab
    through os-context's documented jump path. Nothing here is committed with lab
    values: the API URL, lab id and connection file are parameters given at run
    time, passed to both runs as options, and never written to a file except the
    evidence summary, which names the lab id and nothing secret.

    Steps:
      1. suiterun (the os-context C# binding) runs the suite once: the reference.
      2. dotnet test runs the same suite's generated MSTest tests with
         BDD_SUITE_ALLOW_GUARDED=1 and the options from the environment.
      3. The per-case statuses and the trace's phase order are compared.
    os-context's own teardown and cleanup evidence are its own (its runbook);
    if the teardown fails, keep the evidence and the lab state and leave the
    scenario open.

.EXAMPLE
    ./e13-lab.ps1 -TestProject E:\work\os\os-context-pin\test\e2e\tests\mstest `
        -Suite E:\work\os\os-context-pin\test\e2e\suites\stage0\portable.yml `
        -Suiterun E:\work\os\os-context-pin\test\e2e\bindings\dotnet\artifacts\bin\Suite.Cli\Debug\net10.0\suiterun.dll `
        -SchemaRoot E:\work\os\os-context-pin\test\e2e\schema `
        -ApiUrl https://<lab>/api -LabId <lab-id> -ConnectionFile <path> -Evidence .\e13-mstest
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $TestProject,
    [Parameter(Mandatory)] [string] $Suite,
    [Parameter(Mandatory)] [string] $Suiterun,
    [Parameter(Mandatory)] [string] $SchemaRoot,
    [Parameter(Mandatory)] [string] $ApiUrl,
    [Parameter(Mandatory)] [string] $LabId,
    [Parameter(Mandatory)] [string] $ConnectionFile,
    [Parameter(Mandatory)] [string] $Evidence,
    # The generated class's namespace and the suite's plan id (suiterun generate --plan).
    [string] $ClassFilter = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
$referenceTrace = Join-Path $Evidence 'reference.trace.json'
$mstestTrace = Join-Path $Evidence 'mstest.trace.json'

# 1. The reference run.
$reference = & dotnet $Suiterun run --schema-root $SchemaRoot --path $Suite --trace-file $referenceTrace `
    --api-url $ApiUrl --lab-id $LabId --connection-file $ConnectionFile 2>&1
$reference | Set-Content (Join-Path $Evidence 'reference.out.txt')

# 2. The same suite through MSTest.
$environment = @{
    BDD_SUITE_ALLOW_GUARDED          = '1'
    BDD_SUITE_OPTION_API_URL         = $ApiUrl
    BDD_SUITE_OPTION_LAB_ID          = $LabId
    BDD_SUITE_OPTION_CONNECTION_FILE = $ConnectionFile
    BDD_SUITE_TRACE_FILE             = $mstestTrace
}
foreach ($name in $environment.Keys) { Set-Item -Path "Env:$name" -Value $environment[$name] }
try {
    $arguments = @('test', $TestProject, '--logger', 'trx;LogFileName=mstest.trx', '--results-directory', $Evidence)
    if ($ClassFilter) { $arguments += @('--filter', "FullyQualifiedName~$ClassFilter.") }
    & dotnet @arguments 2>&1 | Set-Content (Join-Path $Evidence 'mstest.out.txt')
}
finally {
    foreach ($name in $environment.Keys) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue }
}

# 3. Compare.
function Get-CaseLine([object[]] $trace) {
    $trace | Where-Object { $_.phase -eq 'case' } | ForEach-Object { '{0} => {1}' -f $_.case, $_.status } | Sort-Object
}
function Get-PhaseLine([object[]] $trace) {
    $trace | ForEach-Object { '{0}|{1}' -f $_.phase, $_.case }
}
$referenceEntries = @(Get-Content $referenceTrace -Raw | ConvertFrom-Json)
$mstestEntries = @(Get-Content $mstestTrace -Raw | ConvertFrom-Json)
$sameCases = (@(Get-CaseLine $referenceEntries) -join "`n") -eq (@(Get-CaseLine $mstestEntries) -join "`n")
$samePhases = (@(Get-PhaseLine $referenceEntries) -join "`n") -eq (@(Get-PhaseLine $mstestEntries) -join "`n")

$summary = [ordered]@{
    scenario   = 'E13 (MSTest)'
    labId      = $LabId
    suite      = $Suite
    sameCases  = $sameCases
    samePhases = $samePhases
    cases      = @(Get-CaseLine $mstestEntries)
    recordedAt = (Get-Date).ToString('o')
}
$summary | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Evidence 'summary.json')
if (-not ($sameCases -and $samePhases)) {
    Write-Error "E13 (MSTest) differs from the suiterun reference; see $Evidence."
}
Write-Output "E13 (MSTest): cases and phase order equal the suiterun reference. Record os-context's cleanup evidence beside $Evidence."
