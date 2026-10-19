Describe 'Suite with smoke' {
    BeforeAll { Write-Host 'MARKER: BeforeAll A' }
    AfterAll  { Write-Host 'MARKER: AfterAll A' }
    It 'smoke case' -Tag 'smoke' { 1 | Should -Be 1 }
    It 'slow case' -Tag 'slow' { 1 | Should -Be 1 }
}
Describe 'Suite without smoke' {
    BeforeAll { Write-Host 'MARKER: BeforeAll B' }
    AfterAll  { Write-Host 'MARKER: AfterAll B' }
    It 'slow only' -Tag 'slow' { 1 | Should -Be 1 }
}
Describe 'Suite tagged at Describe' -Tag 'smoke' {
    BeforeAll { Write-Host 'MARKER: BeforeAll C' }
    It 'untagged It inherits' { 1 | Should -Be 1 }
}
