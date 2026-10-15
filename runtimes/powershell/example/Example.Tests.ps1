<#
.SYNOPSIS
    E3, the PowerShell part: an extension built outside the runtime, on its
    exported commands only, adds an action, a context key, an option and a
    rule; the plain runtime has none of them; two extensions cannot define one
    action.
.DESCRIPTION
    The PowerShell runner lints every suite before it runs anything (its
    contract since before it was copied here), so a suite the rule refuses is
    refused by the run too. The passing run is therefore the same suite with
    its case within the ceiling; echo.yml as it stands proves the lint half
    and the refusal.
#>

BeforeAll {
    $script:example = $PSScriptRoot
    $script:runtimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $script:schemaRoot = Join-Path $script:example 'schema'
    $script:suite = Join-Path $script:example 'suites/echo.yml'
    $script:extension = Join-Path $script:example 'BddSuite.Example.psm1'
    $script:cli = Join-Path $script:runtimeRoot 'Invoke-BddSuite.ps1'
    Import-Module (Join-Path $script:runtimeRoot 'BddSuite/BddSuite.psd1') -Force -DisableNameChecking

    $text = Get-Content -LiteralPath $script:suite -Raw
    # The same suite with its case within the slow ceiling, so the lint passes
    # and the run shows the action, the context key and the option.
    $script:within = Join-Path $TestDrive 'echo-within.yml'
    Set-Content -LiteralPath $script:within -Value ($text -replace 'timeoutSec: 30', 'timeoutSec: 10')
    # The same suite without ${region}, so it lints clean with no extension and
    # its run reaches the action nobody registers.
    $script:plain = Join-Path $TestDrive 'echo-plain.yml'
    Set-Content -LiteralPath $script:plain -Value ($text -replace '\$\{region\}', 'nowhere' -replace "'eu:hello from eu'", "'eu:hello from nowhere'")
    # A slow suite whose case declares no limit (the rule does not flag it)
    # and sleeps past the ceiling: only the run-time limit can stop it.
    $script:sleepy = Join-Path $TestDrive 'sleepy.yml'
    Set-Content -LiteralPath $script:sleepy -Value "suite: sleepy`ntags: [slow]`ntests:`n  - name: sleeps-past-the-ceiling`n    steps:`n      - { action: core.sleep, seconds: 14 }`n"

    function Invoke-Example {
        param([string]$Path, [string[]]$Extension = @($script:extension), [hashtable]$More = @{})
        $arguments = @{
            Path        = @($Path)
            SchemaRoot  = $script:schemaRoot
            Extension   = $Extension
            ResultsFile = (Join-Path $TestDrive "results-$([guid]::NewGuid().ToString('N')).xml")
            Json        = $true
        }
        foreach ($key in @($More.Keys)) { $arguments[$key] = $More[$key] }
        return Invoke-BddSuite @arguments
    }
    function Get-Finding {
        param($Diagnostics)
        return @(@($Diagnostics) | Where-Object { $null -ne $_ } | ForEach-Object { "$($_.code) $($_.line):$($_.column)" })
    }
}

Describe 'E3 with the extension' {
    It 'lint reports only the rule: timeoutSec 30 in a suite tagged slow is E205 5:17' {
        $lint = Invoke-Example -Path $script:suite -More @{ Lint = $true }
        $lint.ExitCode | Should -Be 2
        Get-Finding $lint.Diagnostics | Should -Be @('E205 5:17')
    }

    It 'runs the action, and ${region} reads the option' {
        $run = Invoke-Example -Path $script:within -More @{ Option = @{ region = 'eu' } }
        $run.Error | Should -BeNullOrEmpty
        $run.ExitCode | Should -Be 0
        $run.Suites[0].tests[0].name | Should -Be 'echoes-with-the-region'
        $run.Suites[0].tests[0].status | Should -Be 'passed'
        $run.Suites[0].tests[0].stdout | Should -Match '"echoed":"eu:hello from eu"'
        Get-SuiteActionNames | Should -Contain 'example.echo'
        Get-SuiteActionOwner -Name 'example.echo' | Should -Be 'example'
    }

    It 'refuses to run echo.yml as it stands, because the run lints first and the rule refuses it' {
        $run = Invoke-Example -Path $script:suite -More @{ Option = @{ region = 'eu' } }
        $run.ExitCode | Should -Be 2
        Get-Finding $run.Diagnostics | Should -Be @('E205 5:17')
        @($run.Trace).Count | Should -Be 0
    }

    It 'holds a slow case to the ceiling at run time, whatever it declares' {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $run = Invoke-Example -Path $script:sleepy
        $watch.Stop()
        $run.ExitCode | Should -Be 1
        $run.Suites[0].tests[0].message | Should -Match 'Case exceeded its 10s budget'
        $watch.Elapsed.TotalSeconds | Should -BeLessThan 13.5
    }

    It 'is its own program: the command line runs it with -Extension and -Option name=value' {
        $results = Join-Path $TestDrive 'cli.xml'
        $output = (& pwsh -NoProfile -File $script:cli -Path $script:within -SchemaRoot $script:schemaRoot -Extension $script:extension `
                -Option region=eu -ResultsFile $results 2>&1) -join "`n"
        $LASTEXITCODE | Should -Be 0
        $output | Should -Match '\[PASS\] echoes-with-the-region'
    }

    It 'is built only on BddSuite''s exported commands' {
        $exported = @((Get-Module BddSuite).ExportedCommands.Keys)
        foreach ($file in @($script:extension, (Join-Path $script:example 'actions/Echo.ps1'))) {
            $tokens = $null; $parseErrors = $null
            $ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$parseErrors)
            $used = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() } | Where-Object { $_ -like '*-Suite*' })
            foreach ($name in $used) {
                if ($name -in @('Get-SuiteExtension', 'Test-SlowSuite')) { continue }
                $exported | Should -Contain $name -Because "$([IO.Path]::GetFileName($file)) calls $name"
            }
            (Get-Content -LiteralPath $file -Raw) | Should -Not -Match 'Import-Module'
        }
    }
}

Describe 'E3 without the extension' {
    It 'lint reports only E301 9:15: the context key is unknown, and the slow rule is not there' {
        $lint = Invoke-Example -Path $script:suite -Extension @() -More @{ Lint = $true }
        $lint.ExitCode | Should -Be 2
        Get-Finding $lint.Diagnostics | Should -Be @('E301 9:15')
    }

    It 'refuses the region option as one nobody declares' {
        $run = Invoke-Example -Path $script:suite -Extension @() -More @{ Option = @{ region = 'eu' } }
        $run.ExitCode | Should -Be 2
        $run.Error | Should -Be 'Invoke-BddSuite does not take the option region: no extension of this run declares it.'
        $output = (& pwsh -NoProfile -File $script:cli -Path $script:suite -SchemaRoot $script:schemaRoot -Option region=eu 2>&1) -join "`n"
        $LASTEXITCODE | Should -Be 2
        $output | Should -Match 'does not take the option region'
    }

    It 'does not run the case: echo.yml is refused at lint, and a ${region}-free copy fails on the unregistered action' {
        $refused = Invoke-Example -Path $script:suite -Extension @()
        $refused.ExitCode | Should -Be 2
        @($refused.Trace).Count | Should -Be 0
        $failed = Invoke-Example -Path $script:plain -Extension @()
        Get-Finding $failed.Diagnostics | Should -BeNullOrEmpty -Because 'lint follows the catalog, which declares example.echo'
        $failed.ExitCode | Should -Be 1
        $failed.Suites[0].tests[0].status | Should -Be 'failed'
        $failed.Suites[0].tests[0].message | Should -Be 'Unknown action: example.echo. No extension of this runtime registers it.'
    }
}

Describe 'E3 two extensions defining one action' {
    It 'are refused before anything runs' {
        $twin = Join-Path $TestDrive 'twin'
        $null = New-Item -ItemType Directory -Path (Join-Path $twin 'actions') -Force
        Set-Content -LiteralPath (Join-Path $twin 'actions/Echo.ps1') -Value "Register-SuiteAction -Name 'example.echo' -Handler { param(`$Step, `$Ctx) `$null }"
        Set-Content -LiteralPath (Join-Path $twin 'Twin.psm1') -Value "function Get-SuiteExtension { @{ Name = 'twin'; ActionPath = @('actions') } }`nExport-ModuleMember -Function Get-SuiteExtension"
        $run = Invoke-Example -Path $script:within -Extension @($script:extension, (Join-Path $twin 'Twin.psm1')) -More @{ Option = @{ region = 'eu' } }
        $run.ExitCode | Should -Be 2
        $run.Error | Should -Be 'Action example.echo is defined by both example and twin.'
        @($run.Trace).Count | Should -Be 0
    }
}
