Describe 'Skips' {
    BeforeEach { if ($____Pester.CurrentTest.Name -like 'skip in BeforeEach*') { Set-ItResult -Skipped -Because 'reason from BeforeEach' } }
    It 'skip in It' { Set-ItResult -Skipped -Because 'reason from It'; throw 'should not reach' }
    It 'skip in BeforeEach' { Write-Host 'MARKER: body after BeforeEach skip ran'; 1 | Should -Be 1 }
    It 'inconclusive' { Set-ItResult -Inconclusive -Because 'inc reason' }
}
