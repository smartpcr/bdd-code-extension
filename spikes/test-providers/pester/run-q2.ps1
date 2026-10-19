param([string]$Path = "$PSScriptRoot\q2", [string]$Xml = "$PSScriptRoot\out\q2.xml", [string]$Format = 'NUnitXml')
Import-Module Pester -MinimumVersion 5.0
$c = New-PesterConfiguration
$c.Run.Path = $Path
$c.Run.PassThru = $true
$c.Output.Verbosity = 'Detailed'
$c.TestResult.Enabled = $true
$c.TestResult.OutputFormat = $Format
$c.TestResult.OutputPath = $Xml
$r = Invoke-Pester -Configuration $c
"--- result object"
"Result=$($r.Result) Passed=$($r.PassedCount) Failed=$($r.FailedCount) FailedBlocksCount=$($r.FailedBlocksCount) FailedContainersCount=$($r.FailedContainersCount) NotRun=$($r.NotRunCount) Skipped=$($r.SkippedCount)"
$r.Tests | ForEach-Object { "test: $($_.ExpandedPath) => $($_.Result) Executed=$($_.Executed) Skip=$($_.Skip) ErrorRecord=$($_.ErrorRecord.Exception.Message)" }
$r.Containers | ForEach-Object { "container: $($_.Item) => Result=$($_.Result) Passed=$($_.Passed) ErrorRecord=$($_.ErrorRecord.Exception.Message)" }
$r.FailedBlocks | ForEach-Object { "failedBlock: $($_.ExpandedPath) => Result=$($_.Result) ErrorRecord=$($_.ErrorRecord.Exception.Message)" }
