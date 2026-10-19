BeforeAll {
    Import-Module "$PSScriptRoot/RunState.psm1"
}
Describe 'Container B' {
    It 'sees state created by A' {
        $s = Get-RunState
        $s.Hits.Add('B')
        Write-Host "MARKER: B sees id=$($s.Id) hits=$($s.Hits -join ',') script_var='$script:script_var' global='$global:SpikeGlobal'"
        $s.Hits | Should -Contain 'A'
    }
}
