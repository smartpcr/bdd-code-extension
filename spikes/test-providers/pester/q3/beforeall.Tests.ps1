Describe 'Setup fails' {
    BeforeAll { throw 'suite setup boom' }
    AfterAll { Write-Host 'MARKER: AfterAll ran after BeforeAll failure'; Set-Content -Path "$PSScriptRoot/../out/afterall-ran.txt" -Value 'yes' }
    It 'case a' { Write-Host 'MARKER: case a body ran'; 1 | Should -Be 1 }
    It 'case b' { 1 | Should -Be 1 }
}
