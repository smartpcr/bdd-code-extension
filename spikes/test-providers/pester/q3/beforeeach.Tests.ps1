Describe 'Case setup fails' {
    BeforeEach { if ($____Pester.CurrentTest.Name -eq 'case x') { throw 'case setup boom' } }
    AfterEach { Write-Host "MARKER: AfterEach ran for $($____Pester.CurrentTest.Name)" }
    AfterAll { Write-Host 'MARKER: AfterAll ran (BeforeEach suite)' }
    It 'case x' { Write-Host 'MARKER: case x body ran'; 1 | Should -Be 1 }
    It 'case y' { Write-Host 'MARKER: case y body ran'; 1 | Should -Be 1 }
}
