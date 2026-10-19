Describe 'Angle brackets' {
    It 'literal <qty> placeholder without data' { 1 | Should -Be 1 }
    It 'compares a < b and c > d' { 1 | Should -Be 1 }
    It '<name>' -ForEach @(@{ name = 'data contains <qty> token'; qty = 5 }) { 1 | Should -Be 1 }
    It 'literal escaped `<qty`> with data' -ForEach @(@{ qty = 5 }) { 1 | Should -Be 1 }
}
