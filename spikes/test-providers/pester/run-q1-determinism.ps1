Import-Module Pester -MinimumVersion 5.0
$root = $PSScriptRoot
$names = foreach ($i in 1..3) {
    $c = New-PesterConfiguration
    $c.Run.Path = "$root\q1"
    $c.Run.SkipRun = $true      # discovery only
    $c.Run.PassThru = $true
    $c.Output.Verbosity = 'None'
    $r = Invoke-Pester -Configuration $c
    ($r.Tests | ForEach-Object { $_.ExpandedPath }) -join "`n"
}
"discovery runs identical: $(($names | Select-Object -Unique).Count -eq 1)"
$names[0]
