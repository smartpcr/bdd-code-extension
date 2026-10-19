Describe 'Teardown fails' {
    BeforeAll { }
    AfterAll { throw 'suite teardown boom' }
    It 'passes one' { 1 | Should -Be 1 }
    It 'passes two' { 2 | Should -Be 2 }
}
