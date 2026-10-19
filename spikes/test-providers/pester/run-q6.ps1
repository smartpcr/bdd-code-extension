Import-Module Pester -MinimumVersion 5.0
$c = New-PesterConfiguration
$c.Run.Path = @("$PSScriptRoot\q6\a.Tests.ps1", "$PSScriptRoot\q6\b.Tests.ps1")
$c.Run.PassThru = $true
$c.Output.Verbosity = 'Detailed'
$r = Invoke-Pester -Configuration $c
"Result=$($r.Result) Passed=$($r.PassedCount) Failed=$($r.FailedCount)"
"Module still loaded after Invoke-Pester (caller session): $([bool](Get-Module RunState))"
if (Get-Module RunState) { "State after run: id=$((Get-RunState).Id) hits=$((Get-RunState).Hits -join ',')" }
