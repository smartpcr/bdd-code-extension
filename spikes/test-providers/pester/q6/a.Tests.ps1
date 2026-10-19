BeforeAll {
    Import-Module "$PSScriptRoot/RunState.psm1"          # no -Force: reuse if already loaded
    $script:script_var = 'set in a'                       # container script scope - not shared
    $global:SpikeGlobal = 'set in a'
}
Describe 'Container A' {
    It 'records hit A' {
        $s = Get-RunState
        $s.Hits.Add('A')
        Write-Host "MARKER: A sees id=$($s.Id) hits=$($s.Hits -join ',')"
    }
}
