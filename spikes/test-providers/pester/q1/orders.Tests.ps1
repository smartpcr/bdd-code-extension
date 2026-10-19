# Generated-style file: Describe per suite, It per case, It -ForEach for examples rows.
Describe 'Orders suite [v=1]' -Tag 'orders' {
    BeforeAll { $script:log = [System.Collections.Generic.List[string]]::new(); $script:log.Add('BeforeAll') }
    AfterAll  { Write-Host "AfterAll ran (orders)" }
    BeforeEach { $script:log.Add('BeforeEach') }
    AfterEach  { $script:log.Add('AfterEach') }

    It 'accepts a good order [qty=1]' -Tag 'smoke' { 1 | Should -Be 1 }
    It 'rejects a bad quantity [qty=0]' -Tag 'neg' { 0 | Should -Be 0 }

    It '<name>' -Tag 'rows' -ForEach @(
        @{ name = 'rejects [qty=0]';  qty = 0 }
        @{ name = 'rejects [qty=-1]'; qty = -1 }
        @{ name = 'name with * and ? and `backtick';  qty = -2 }
    ) {
        $qty | Should -BeLessOrEqual 0
    }
}
