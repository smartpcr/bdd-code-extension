<#
.SYNOPSIS
    The PowerShell runtime's suiterun command line (S5a.3, DEC-S11):
    Invoke-BddSuiteCli and the suiterun.ps1 entry, held to the verbs, flags,
    outputs and exit codes of runtimes/typescript/src/cli.ts and run.ts.
.DESCRIPTION
    Pester 5. A workspace of the tests' own under TestDrive, in the default
    layout (test/e2e/schema), so the schema root is found by the walk and by
    --schema-root alike. Nothing here needs a network.
#>

BeforeAll {
    $script:runtimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $script:repoRoot = [IO.Path]::GetFullPath((Join-Path $script:runtimeRoot '../..'))
    $script:entry = Join-Path $script:runtimeRoot 'suiterun.ps1'
    $script:example = Join-Path $script:runtimeRoot 'example/BddSuite.Example.psm1'
    Import-Module powershell-yaml -ErrorAction Stop
    Import-Module (Join-Path $script:runtimeRoot 'BddSuite/BddSuite.psd1') -Force -DisableNameChecking

    # The workspace: the core, imported by an absolute path; example.echo (the
    # example extension's action) and probe.only, which only powershell claims.
    $script:ws = Join-Path $TestDrive 'ws'
    $script:schema = Join-Path $script:ws 'test/e2e/schema'
    $null = New-Item -ItemType Directory -Path $script:schema -Force
    $core = (Join-Path $script:repoRoot 'spec/core.catalog.yaml') -replace '\\', '/'
    $catalog = @"
catalogVersion: 1
imports:
  - '$core'
bindings: [powershell, go]
actions:
  - name: example.echo
    summary: Echo.
    bindings: [powershell, go]
    interruptible: true
    params:
      - { name: text, type: string, required: true }
    captures:
      type: object
      additionalProperties: false
      properties:
        echoed: { type: string }
  - name: probe.only
    summary: Claimed by powershell alone.
    bindings: [powershell]
    interruptible: true
    captures: { type: object, additionalProperties: true }
"@
    Set-Content -LiteralPath (Join-Path $script:schema 'actions.catalog.yaml') -Value $catalog
    $built = & pwsh -NoProfile -File (Join-Path $script:repoRoot 'spec/Build-Schema.ps1') -Catalog (Join-Path $script:schema 'actions.catalog.yaml') 2>&1
    if ($LASTEXITCODE -ne 0) { throw "The test schema would not generate: $built" }

    function New-WsFile {
        param([string]$Relative, [string]$Text)
        $path = Join-Path $script:ws $Relative
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force
        Set-Content -LiteralPath $path -Value $Text
        return $path
    }
    $null = New-WsFile 'suites/pass.yml' @"
suite: pass
tags: [green]
params:
  - { name: who, type: string, default: nobody }
tests:
  - name: first
    steps:
      - when: a value is set
        action: core.set
        value: hello `${param.who}
        captureAs: v
      - then: it reads back
        action: core.noop
        asserts:
          - var: v
            equals: hello nobody
  - name: second
    tags: [extra]
    steps:
      - action: core.noop
  - name: rows
    examples:
      - { n: one }
      - { n: two }
    steps:
      - action: core.set
        value: `${row.n}
        captureAs: r
        asserts:
          - var: r
            equals: `${row.n}
"@
    $null = New-WsFile 'suites/fail.yml' "suite: fail`ntests:`n  - name: breaks`n    steps:`n      - { action: core.fail, message: on purpose }`n  - name: holds`n    steps:`n      - action: core.noop`n"
    $null = New-WsFile 'suites/warn.yml' "suite: warn`ntests:`n  - name: unread`n    steps:`n      - { action: core.set, value: 1, captureAs: unused }`n"
    $null = New-WsFile 'suites/only.yml' "suite: only`ntests:`n  - name: uses-probe`n    steps:`n      - action: probe.only`n"
    $null = New-WsFile 'suites/echo.yml' "suite: echo`ntests:`n  - name: echoes`n    steps:`n      - action: example.echo`n        text: hi`n        captureAs: e`n        asserts:`n          - { var: e.echoed, equals: 'eu:hi' }`n"
    $null = New-WsFile 'bad/typos.yml' "suite: typos`ntests:`n  - name: c`n    timeout: 30`n    steps:`n      - action: core.noop`n"
    $null = New-WsFile 'bad/notyaml.yml' "suite: [unclosed`n"

    function Invoke-Cli {
        # Invoke-BddSuiteCli from the workspace root, with both streams captured.
        param([string[]]$Arguments, [string[]]$Extension = @(), [string]$From = $script:ws)
        $out = [IO.StringWriter]::new()
        $err = [IO.StringWriter]::new()
        Push-Location $From
        try { $code = Invoke-BddSuiteCli -Arguments $Arguments -Extension $Extension -Out $out -ErrorOut $err }
        finally { Pop-Location }
        return [pscustomobject]@{ Code = $code; Out = $out.ToString(); Err = $err.ToString() }
    }
}

Describe 'S5a.3 suiterun: usage and refusals' {
    It 'needs a verb, and prints why and the usage on standard error with exit 2' {
        $r = Invoke-Cli -Arguments @()
        $r.Code | Should -Be 2
        $r.Out | Should -BeNullOrEmpty
        $r.Err | Should -BeLike "suiterun: a verb is needed.`nsuiterun lint    --path <glob>*"
        $r.Err | Should -Match '\[--test-name <case>\]'
    }

    It 'refuses an unknown verb, an unknown flag, and a valued flag with no value' {
        (Invoke-Cli -Arguments @('check')).Err | Should -BeLike 'suiterun: there is no verb called check.*'
        $r = Invoke-Cli -Arguments @('lint', '--path', 'x.yml', '--verbose')
        $r.Code | Should -Be 2
        $r.Err | Should -BeLike 'suiterun: lint does not take --verbose.*'
        (Invoke-Cli -Arguments @('run', '--path')).Err | Should -BeLike 'suiterun: --path needs a value after it.*'
        (Invoke-Cli -Arguments @('run', '--path', '--json')).Err | Should -BeLike 'suiterun: --path needs a value after it.*'
    }

    It 'refuses --format other than nunit3 or junit, and --param without name=value' {
        (Invoke-Cli -Arguments @('run', '--path', 'suites/pass.yml', '--format', 'xml')).Err | Should -BeLike 'suiterun: --format is nunit3 or junit, not xml.*'
        (Invoke-Cli -Arguments @('run', '--path', 'suites/pass.yml', '--param', '=x')).Err | Should -BeLike 'suiterun: --param takes name=value, and =x is not one.*'
    }

    It 'needs --path for lint, run and list, and not for actions' {
        foreach ($verb in @('lint', 'run', 'list')) {
            $r = Invoke-Cli -Arguments @($verb)
            $r.Code | Should -Be 2
            $r.Err | Should -BeLike "suiterun: $verb needs --path.*"
        }
        (Invoke-Cli -Arguments @('actions')).Code | Should -Be 0
    }

    It 'refuses a --path that names no file, as a refusal (2) and not a usage error' {
        $r = Invoke-Cli -Arguments @('lint', '--path', 'suites/none.yml')
        $r.Code | Should -Be 2
        $r.Err | Should -Be "suiterun: suites/none.yml names no file`n"
        (Invoke-Cli -Arguments @('lint', '--path', 'suites/zz*.yml')).Err | Should -Be "suiterun: suites/zz*.yml names no file`n"
    }

    It 'refuses to find the schema from outside a workspace without --schema-root' {
        $r = Invoke-Cli -Arguments @('lint', '--path', (Join-Path $script:ws 'suites/pass.yml')) -From $TestDrive
        $r.Code | Should -Be 2
        $r.Err | Should -Be "suiterun: the workspace root cannot be found from this directory (no test/e2e/schema above it); pass --schema-root.`n"
    }

    It 'adds each extension option to the usage, takes it as --<name> <value>, and refuses one that is not declared' {
        $r = Invoke-Cli -Arguments @('bogus') -Extension @($script:example)
        $r.Err | Should -Match "Options the extensions add, for run:`n\s+--region <value>  The region"
        (Invoke-Cli -Arguments @('run', '--path', 'suites/pass.yml', '--region', 'eu')).Err | Should -BeLike 'suiterun: run does not take --region.*'
    }

    It 'refuses an extension option that is a flag of the command line' {
        $folder = Join-Path $TestDrive 'clash'
        $null = New-Item -ItemType Directory -Path $folder -Force
        $module = Join-Path $folder 'Clash.psm1'
        Set-Content -LiteralPath $module -Value "function Get-SuiteExtension { @{ Name = 'clash'; Options = @(@{ Name = 'format'; Description = 'f' }) } }`nExport-ModuleMember -Function *"
        $r = Invoke-Cli -Arguments @('actions') -Extension @($module)
        $r.Code | Should -Be 2
        $r.Err | Should -Be "suiterun: Option format is defined by both the core and clash.`n"
    }

    It 'spells a camelCase option as lower-case words, as every program does: zoneName is --zone-name' {
        $folder = Join-Path $TestDrive 'kebab'
        $null = New-Item -ItemType Directory -Path $folder -Force
        $module = Join-Path $folder 'Kebab.psm1'
        Set-Content -LiteralPath $module -Value "function Get-SuiteExtension { @{ Name = 'kebab'; Options = @(@{ Name = 'zoneName'; Description = 'The zone' }) } }`nExport-ModuleMember -Function *"
        (Invoke-Cli -Arguments @('bogus') -Extension @($module)).Err | Should -Match "Options the extensions add, for run:`n\s+--zone-name <value>  The zone"
        (Invoke-Cli -Arguments @('lint', '--path', 'suites/pass.yml', '--zone-name', 'eu') -Extension @($module)).Code | Should -Be 0
        (Invoke-Cli -Arguments @('lint', '--path', 'suites/pass.yml', '--zoneName', 'eu') -Extension @($module)).Err | Should -BeLike 'suiterun: lint does not take --zoneName.*'
        Set-Content -LiteralPath $module -Value "function Get-SuiteExtension { @{ Name = 'kebab'; Options = @(@{ Name = 'testName'; Description = 't' }) } }`nExport-ModuleMember -Function *"
        (Invoke-Cli -Arguments @('actions') -Extension @($module)).Err | Should -Be "suiterun: Option testName is defined by both the core and kebab.`n"
    }
}

Describe 'S5a.3 suiterun actions' {
    It 'prints the core actions one per line, sorted ordinally' {
        $r = Invoke-Cli -Arguments @('actions')
        $r.Code | Should -Be 0
        $r.Out | Should -Be "core.fail`ncore.noop`ncore.record`ncore.set`ncore.skip`ncore.sleep`nwait`n"
    }

    It 'prints a JSON array with --json, including what an extension registers' {
        $r = Invoke-Cli -Arguments @('actions', '--json') -Extension @($script:example)
        $r.Code | Should -Be 0
        $names = $r.Out | ConvertFrom-Json
        $names | Should -Be @('core.fail', 'core.noop', 'core.record', 'core.set', 'core.skip', 'core.sleep', 'example.echo', 'wait')
        $r.Out.StartsWith("[`n  `"core.fail`",") | Should -BeTrue
    }
}

Describe 'S5a.3 suiterun lint' {
    It 'is clean (exit 0) on a clean suite, with the summary line' {
        $r = Invoke-Cli -Arguments @('lint', '--path', 'suites/pass.yml')
        $r.Code | Should -Be 0
        $r.Out | Should -Be "Lint clean: 1 suite file(s), 0 finding(s).`n"
        $r.Err | Should -BeNullOrEmpty
    }

    It 'prints each finding as a person reads it, and fails (exit 2) on an error' {
        $r = Invoke-Cli -Arguments @('lint', '--path', 'bad/typos.yml')
        $r.Code | Should -Be 2
        $r.Out | Should -Be "bad/typos.yml:4:5  E101  Unknown key timeout in the suite at /tests/0.`n    Did you mean timeoutSec`nLint failed: 1 suite file(s), 1 finding(s).`n"
    }

    It 'prints the diagnostic array alone with --json, keys in the schema''s order' {
        $r = Invoke-Cli -Arguments @('lint', '--path', 'bad/typos.yml', '--json')
        $r.Code | Should -Be 2
        $found = @($r.Out | ConvertFrom-Json)
        $found.Count | Should -Be 1
        @($found[0].PSObject.Properties.Name) -join ',' | Should -Be 'code,severity,file,line,column,message,suggestion'
        "$($found[0].code) $($found[0].file) $($found[0].line):$($found[0].column)" | Should -Be 'E101 bad/typos.yml 4:5'
        (Invoke-Cli -Arguments @('lint', '--path', 'suites/pass.yml', '--json')).Out | Should -Be "[]`n"
    }

    It 'reports a file that is not YAML as a finding, not a refusal' {
        $r = Invoke-Cli -Arguments @('lint', '--path', 'bad/notyaml.yml', '--json')
        $r.Code | Should -Be 2
        @($r.Out | ConvertFrom-Json)[0].code | Should -Be 'E100'
    }

    It 'passes a warning, and fails it with --strict' {
        $plain = Invoke-Cli -Arguments @('lint', '--path', 'suites/warn.yml', '--json')
        $plain.Code | Should -Be 0
        @($plain.Out | ConvertFrom-Json)[0].code | Should -Be 'W301'
        (Invoke-Cli -Arguments @('lint', '--path', 'suites/warn.yml', '--strict')).Code | Should -Be 2
    }

    It 'reports E201 for an action the --binding does not implement only with --binding-check' {
        (Invoke-Cli -Arguments @('lint', '--path', 'suites/only.yml', '--binding', 'go')).Code | Should -Be 0
        $r = Invoke-Cli -Arguments @('lint', '--path', 'suites/only.yml', '--json', '--binding-check', '--binding', 'go')
        $r.Code | Should -Be 2
        @($r.Out | ConvertFrom-Json)[0].code | Should -Be 'E201'
        (Invoke-Cli -Arguments @('lint', '--path', 'suites/only.yml', '--binding-check')).Code | Should -Be 0
    }

    It 'lints every file a glob names, in ordinal order, relative to the workspace root' {
        $r = Invoke-Cli -Arguments @('lint', '--path', 'bad/*.yml', '--json')
        @($r.Out | ConvertFrom-Json | ForEach-Object { $_.file }) | Should -Be @('bad/notyaml.yml', 'bad/typos.yml')
    }

    It 'reads the schema from --schema-root when given, from anywhere' {
        $r = Invoke-Cli -Arguments @('lint', '--path', (Join-Path $script:ws 'suites/pass.yml'), '--schema-root', $script:schema) -From $TestDrive
        $r.Code | Should -Be 0
        $r.Out | Should -Be "Lint clean: 1 suite file(s), 0 finding(s).`n"
    }

    It 'takes --param for the lint, so a value the suite does not declare is E210' {
        $r = Invoke-Cli -Arguments @('lint', '--path', 'suites/pass.yml', '--json', '--param', 'nobody=x')
        $r.Code | Should -Be 2
        @($r.Out | ConvertFrom-Json)[0].code | Should -Be 'E210'
    }
}

Describe 'S5a.3 suiterun run' {
    It 'runs every case, prints one line per case and the verdict, exit 0' {
        $r = Invoke-Cli -Arguments @('run', '--path', 'suites/pass.yml')
        $r.Code | Should -Be 0
        $r.Out | Should -Be ("=== Suite: pass.yml ===`n  [passed] first`n  [passed] second`n  [passed] rows [n=one]`n  [passed] rows [n=two]`n" +
            "All selected tests passed.`n")
        Test-Path (Join-Path $script:ws 'test-results.xml') | Should -BeFalse
    }

    It 'exits 1 when a case fails, and says so' {
        $r = Invoke-Cli -Arguments @('run', '--path', 'suites/fail.yml')
        $r.Code | Should -Be 1
        $r.Out | Should -Be "=== Suite: fail.yml ===`n  [failed] breaks`n  [passed] holds`nOne or more tests failed.`n"
    }

    It 'writes the report with --results, NUnit 3 by default and JUnit with --format junit' {
        $nunit = Join-Path $TestDrive 'out/r.xml'
        $junit = Join-Path $TestDrive 'out/j.xml'
        $r = Invoke-Cli -Arguments @('run', '--path', 'suites/pass.yml', '--results', $nunit)
        $r.Out | Should -Match ([regex]::Escape("Results written to $nunit"))
        ([xml](Get-Content -LiteralPath $nunit -Raw)).DocumentElement.Name | Should -Be 'test-run'
        $null = Invoke-Cli -Arguments @('run', '--path', 'suites/pass.yml', '--results', $junit, '--format', 'junit')
        ([xml](Get-Content -LiteralPath $junit -Raw)).DocumentElement.Name | Should -Be 'testsuites'
    }

    It 'writes the trace with --trace-file' {
        $trace = Join-Path $TestDrive 'out/t.json'
        $r = Invoke-Cli -Arguments @('run', '--path', 'suites/fail.yml', '--trace-file', $trace)
        $r.Out | Should -Match ([regex]::Escape("Trace written to $trace"))
        $cases = @(Get-Content -LiteralPath $trace -Raw | ConvertFrom-Json | Where-Object { $_.phase -eq 'case' } | ForEach-Object { "$($_.case)=$($_.status)" })
        $cases | Should -Be @('breaks=failed', 'holds=passed')
    }

    It 'skips the cases --tags does not select' {
        $r = Invoke-Cli -Arguments @('run', '--path', 'suites/pass.yml', '--tags', 'nothing,else')
        $r.Out | Should -Match '\[skipped\] first'
        $r.Code | Should -Be 0
        (Invoke-Cli -Arguments @('run', '--path', 'suites/pass.yml', '--tags', 'green')).Out | Should -Match '\[passed\] second'
    }

    It 'validates and runs nothing with --dry-run' {
        $r = Invoke-Cli -Arguments @('run', '--path', 'suites/fail.yml', '--dry-run')
        $r.Code | Should -Be 0
        $r.Out | Should -Match '\[skipped\] breaks'
        $r.Out | Should -Match 'Suite validation passed; live tests were not run.'
    }

    It 'gives a parameter its value with --param' {
        (Invoke-Cli -Arguments @('run', '--path', 'suites/pass.yml', '--param', 'who=somebody')).Code | Should -Be 1
        (Invoke-Cli -Arguments @('run', '--path', 'suites/pass.yml', '--param', 'who=nobody')).Code | Should -Be 0
    }

    It 'runs exactly one case with --test-name, every row of an outline, and refuses a name no case has' {
        $one = Invoke-Cli -Arguments @('run', '--path', 'suites/fail.yml', '--test-name', 'holds')
        $one.Code | Should -Be 0
        $one.Out | Should -Be "=== Suite: fail.yml ===`n  [passed] holds`nAll selected tests passed.`n"
        $rows = Invoke-Cli -Arguments @('run', '--path', 'suites/pass.yml', '--test-name', 'rows')
        $rows.Out | Should -Be "=== Suite: pass.yml ===`n  [passed] rows [n=one]`n  [passed] rows [n=two]`nAll selected tests passed.`n"
        $none = Invoke-Cli -Arguments @('run', '--path', 'suites/pass.yml', '--test-name', 'nope')
        $none.Code | Should -Be 2
        $none.Err | Should -Be "suiterun: Suite pass.yml does not declare exactly one case named 'nope'.`n"
    }

    It 'refuses (exit 2) a suite the lint refuses, running nothing' {
        $r = Invoke-Cli -Arguments @('run', '--path', 'bad/typos.yml')
        $r.Code | Should -Be 2
        $r.Out | Should -Match 'Lint found 1 error\(s\) and 0 warning\(s\)\. Nothing was executed\.'
    }

    It 'gives an extension its option, and the action reads it' {
        $r = Invoke-Cli -Arguments @('run', '--path', 'suites/echo.yml', '--region', 'eu') -Extension @($script:example)
        $r.Code | Should -Be 0
        $r.Out | Should -Match '\[passed\] echoes'
        (Invoke-Cli -Arguments @('run', '--path', 'suites/echo.yml', '--region', 'us') -Extension @($script:example)).Code | Should -Be 1
    }

    It 'traces each step a wait polls ahead of the wait, as every runtime does' {
        $null = New-WsFile 'suites/poll.yml' "suite: poll`ntests:`n  - name: polls`n    steps:`n      - action: wait`n        intervalSec: 1`n        timeoutSec: 5`n        forStep:`n          action: core.set`n          value: { State: Up }`n          captureAs: cs`n        until:`n          var: cs.State`n          equals: Up`n        captureAs: waited`n      - action: core.noop`n        asserts:`n          - { var: waited.waited, equals: true }`n"
        $trace = Join-Path $TestDrive 'out/poll.json'
        (Invoke-Cli -Arguments @('run', '--path', 'suites/poll.yml', '--trace-file', $trace)).Code | Should -Be 0
        $steps = @(Get-Content -LiteralPath $trace -Raw | ConvertFrom-Json | ForEach-Object { "$($_.phase):$($_.step):$($_.status)" })
        $steps | Should -Be @('step:step core.set:passed', 'step:step 1 (wait):passed', 'step:step 2 (core.noop):passed', 'case::passed')
    }

    It 'fails the case of an action no extension registers' {
        $r = Invoke-Cli -Arguments @('run', '--path', 'suites/only.yml')
        $r.Code | Should -Be 1
        $r.Out | Should -Match '\[failed\] uses-probe'
    }
}

Describe 'S5a.3 suiterun list' {
    It 'prints one line per case a run would select: file name, two spaces, case; outlines by row' {
        $r = Invoke-Cli -Arguments @('list', '--path', 'suites/pass.yml')
        $r.Code | Should -Be 0
        $r.Out | Should -Be "pass.yml  first`npass.yml  second`npass.yml  rows [n=one]`npass.yml  rows [n=two]`n"
    }

    It 'filters by --tags (a case''s own or its suite''s) and by --test-name' {
        (Invoke-Cli -Arguments @('list', '--path', 'suites/pass.yml', '--tags', 'extra')).Out | Should -Be "pass.yml  second`n"
        (Invoke-Cli -Arguments @('list', '--path', 'suites/*.yml', '--tags', 'green')).Out | Should -BeLike 'pass.yml  first*'
        (Invoke-Cli -Arguments @('list', '--path', 'suites/pass.yml', '--test-name', 'rows')).Out | Should -Be "pass.yml  rows [n=one]`npass.yml  rows [n=two]`n"
        $none = Invoke-Cli -Arguments @('list', '--path', 'suites/pass.yml', '--tags', 'nothing')
        $none.Code | Should -Be 0
        $none.Out | Should -BeNullOrEmpty
    }

    It 'refuses a file that is not YAML' {
        $r = Invoke-Cli -Arguments @('list', '--path', 'bad/notyaml.yml')
        $r.Code | Should -Be 2
        $r.Err | Should -BeLike 'suiterun: *notyaml.yml is not valid YAML*'
    }
}

Describe 'S5a.3 the suiterun.ps1 entry' {
    It 'sets the process exit code and writes to the standard streams' {
        Push-Location $script:ws
        try {
            $out = & pwsh -NoProfile -File $script:entry lint --path suites/pass.yml --json 2>$null
            $LASTEXITCODE | Should -Be 0
            ($out -join "`n") | Should -Be '[]'
            $null = & pwsh -NoProfile -File $script:entry run --path suites/fail.yml 2>$null
            $LASTEXITCODE | Should -Be 1
            $err = & pwsh -NoProfile -File $script:entry nonsense 2>&1
            $LASTEXITCODE | Should -Be 2
            ($err -join "`n") | Should -BeLike 'suiterun: there is no verb called nonsense.*'
        } finally { Pop-Location }
    }
}
