<#
.SYNOPSIS
    The PowerShell runtime's own tests (D7): the module surface, the extension
    API, the runner, the lint without product rules, the Test-Json fix and the
    generic helpers carried over from os-context's SuiteLint.Tests.ps1.
.DESCRIPTION
    Pester 5. Nothing here needs a lab or a network. The corpus itself is
    Conformance.Tests.ps1 beside this file.
#>

BeforeAll {
    $script:runtimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $script:repoRoot = [IO.Path]::GetFullPath((Join-Path $script:runtimeRoot '../..'))
    $script:specRoot = Join-Path $script:repoRoot 'spec'
    $script:corpusRoot = Join-Path $script:repoRoot 'conformance'
    $script:corpusSchema = Join-Path $script:corpusRoot 'schema'
    $script:cli = Join-Path $script:runtimeRoot 'Invoke-BddSuite.ps1'
    Import-Module powershell-yaml -ErrorAction Stop
    Import-Module (Join-Path $script:runtimeRoot 'BddSuite/BddSuite.psd1') -Force -DisableNameChecking

    # A workspace of the tests' own: the core, imported by an absolute path,
    # and four probe actions only these tests register.
    $script:schemaRoot = Join-Path $TestDrive 'schema'
    $null = New-Item -ItemType Directory -Path $script:schemaRoot -Force
    $coreCatalog = (Join-Path $script:specRoot 'core.catalog.yaml') -replace '\\', '/'
    $probe = @'
  - name: {0}
    summary: Probe.
    bindings: [powershell]
    interruptible: true
    params:
      - {{ name: text, type: string }}
    captures: {{ type: object, additionalProperties: true }}
'@
    $entries = (@('probe.echo', 'probe.helper', 'probe.state', 'probe.unregistered') | ForEach-Object { $probe -f $_ }) -join "`n"
    $catalog = "catalogVersion: 1`nimports:`n  - '$coreCatalog'`nsuiteSchema:`n  - probe.suite.json`nbindings: [powershell]`nactions:`n" + $entries
    Set-Content -LiteralPath (Join-Path $script:schemaRoot 'actions.catalog.yaml') -Value $catalog
    # Two defaults fields, as a workspace's suite-schema extension adds them,
    # so a context key can take its value from the suite's defaults.
    Set-Content -LiteralPath (Join-Path $script:schemaRoot 'probe.suite.json') -Value '{ "defaults": { "zone": { "type": "string" }, "other": { "type": "string" } } }'
    $built = & pwsh -NoProfile -File (Join-Path $script:specRoot 'Build-Schema.ps1') -Catalog (Join-Path $script:schemaRoot 'actions.catalog.yaml') 2>&1
    if ($LASTEXITCODE -ne 0) { throw "The probe schema would not generate: $built" }

    $script:counter = 0
    function New-TestFile {
        # A file under TestDrive with the given text; the folder is made.
        param([string]$Relative, [string]$Text)
        $path = Join-Path $TestDrive $Relative
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force
        Set-Content -LiteralPath $path -Value $Text
        return $path
    }
    function New-TestExtension {
        # An extension module: Get-SuiteExtension returns the hashtable text
        # given; action files, when given, go in an actions folder beside it.
        param([string]$Name, [string]$Description, [hashtable]$Actions = @{}, [string]$Extra = '')
        $script:counter++
        $folder = "ext$($script:counter)-$Name"
        foreach ($file in @($Actions.Keys)) { $null = New-TestFile "$folder/actions/$file" $Actions[$file] }
        return New-TestFile "$folder/$Name.psm1" ("$Extra`nfunction Get-SuiteExtension {`n    return $Description`n}`nExport-ModuleMember -Function * `n")
    }
    function New-TestSuite {
        param([string]$Name, [string]$Text)
        $script:counter++
        return New-TestFile "suites$($script:counter)/$Name.yml" $Text
    }
    function Invoke-Probe {
        # Invoke-BddSuite against the probe workspace, quietly, with a report
        # and a trace in TestDrive.
        param([string]$Suite, [hashtable]$More = @{})
        $script:counter++
        $arguments = @{
            Path        = @($Suite)
            SchemaRoot  = $script:schemaRoot
            ResultsFile = (Join-Path $TestDrive "r$($script:counter).xml")
            TraceFile   = (Join-Path $TestDrive "t$($script:counter).json")
            Json        = $true
        }
        foreach ($key in @($More.Keys)) { $arguments[$key] = $More[$key] }
        $outcome = Invoke-BddSuite @arguments
        $outcome | Add-Member -NotePropertyName Report -NotePropertyValue $arguments.ResultsFile
        return $outcome
    }
    function Get-Finding {
        param($Diagnostics)
        return @(@($Diagnostics) | Where-Object { $null -ne $_ } | ForEach-Object { "$($_.code)@$($_.line):$($_.column)" })
    }
}

Describe 'D7 the module surface' {
    It 'exports the registry under its new names and keeps the old ones as aliases' {
        foreach ($name in @('Register-SuiteAction', 'Get-SuiteActionNames', 'Invoke-SuiteLint', 'Invoke-BddSuite', 'New-SuiteDiagnostic')) {
            (Get-Command $name -ErrorAction Stop).Source | Should -Be 'BddSuite'
        }
        (Get-Alias Register-LabAction).Definition | Should -Be 'Register-SuiteAction'
        (Get-Alias Get-LabActionNames).Definition | Should -Be 'Get-SuiteActionNames'
    }

    It 'registers the core actions, and only them, when nothing else is loaded' {
        $null = New-SuiteComposite
        (Get-SuiteActionNames) -join ',' | Should -Be 'core.fail,core.noop,core.record,core.set,core.skip,core.sleep,wait'
        Get-SuiteActionOwner -Name 'wait' | Should -Be 'the core'
    }

    It 'refuses a second registration of one name, naming both owners' {
        $null = New-SuiteComposite
        { Register-SuiteAction -Name 'core.noop' -Handler { 1 } -Owner 'mine' } | Should -Throw 'Action core.noop is defined by both the core and mine.'
        Register-LabAction -Name 'probe.alias' -Handler { 1 } -Owner 'mine'
        Get-LabActionNames | Should -Contain 'probe.alias'
        $null = New-SuiteComposite
        Get-SuiteActionNames | Should -Not -Contain 'probe.alias'
    }
}

Describe 'D7 composing extensions (DEC-S03)' {
    It 'refuses two extensions that define one action, before anything runs' {
        $action = @{ 'Echo.ps1' = "Register-SuiteAction -Name 'probe.echo' -Handler { param(`$Step, `$Ctx) 'x' }" }
        $one = New-TestExtension -Name 'one' -Description "@{ Name = 'one'; ActionPath = @('actions') }" -Actions $action
        $two = New-TestExtension -Name 'two' -Description "@{ Name = 'two'; ActionPath = @('actions') }" -Actions $action
        $suite = New-TestSuite 'noop' "suite: s`ntests:`n  - name: c`n    steps:`n      - action: core.noop`n"
        $outcome = Invoke-Probe $suite @{ Extension = @($one, $two) }
        $outcome.ExitCode | Should -Be 2
        $outcome.Error | Should -Be 'Action probe.echo is defined by both one and two.'
        @($outcome.Trace).Count | Should -Be 0
    }

    It 'refuses a context key, an option or a prefix two of them define, and what the core already owns' {
        $a = Import-SuiteExtension -Path (New-TestExtension -Name 'a' -Description "@{ Name = 'a'; ContextKeys = @('zone'); Options = @(@{ Name = 'zone'; Description = 'z' }); EnvPrefix = 'A_' }")
        $b = Import-SuiteExtension -Path (New-TestExtension -Name 'b' -Description "@{ Name = 'b'; ContextKeys = @('zone') }")
        $c = Import-SuiteExtension -Path (New-TestExtension -Name 'c' -Description "@{ Name = 'c'; Options = @(@{ Name = 'zone'; Description = 'z' }) }")
        $d = Import-SuiteExtension -Path (New-TestExtension -Name 'd' -Description "@{ Name = 'd'; EnvPrefix = 'D_' }")
        $e = Import-SuiteExtension -Path (New-TestExtension -Name 'e' -Description "@{ Name = 'e'; ContextKeys = @('capture') }")
        $f = Import-SuiteExtension -Path (New-TestExtension -Name 'f' -Description "@{ Name = 'f'; Options = @(@{ Name = 'path'; Description = 'p' }) }")
        { New-SuiteComposite -Extension @($a, $b) } | Should -Throw 'Context key zone is defined by both a and b.'
        { New-SuiteComposite -Extension @($a, $c) } | Should -Throw 'Option zone is defined by both a and c.'
        { New-SuiteComposite -Extension @($a, $d) } | Should -Throw 'a sets the environment prefix A_ and d sets D_.'
        { New-SuiteComposite -Extension @($e) } | Should -Throw 'Context key capture is defined by both the core and e.'
        { New-SuiteComposite -Extension @($f) } | Should -Throw 'Option path is defined by both the core and f.'
        $composite = New-SuiteComposite -Extension @($a)
        $composite.Roots -join ',' | Should -Be 'capture,param,var,row,timeoutSec,defaults,zone'
        $composite.EnvPrefix | Should -Be 'A_'
        (New-SuiteComposite).EnvPrefix | Should -Be 'BDD_SUITE_'
    }

    It 'refuses an extension module that describes nothing, or describes a part that does not exist' {
        $none = New-TestFile 'bare/Bare.psm1' "function Get-Other { 1 }`nExport-ModuleMember -Function Get-Other"
        { Import-SuiteExtension -Path $none } | Should -Throw '*exports no Get-SuiteExtension*'
        { Import-SuiteExtension -Path (New-TestExtension -Name 'odd' -Description "@{ Name = 'odd'; Lifetime = 1 }") } | Should -Throw '*declares Lifetime*'
        { Import-SuiteExtension -Path (Join-Path $TestDrive 'missing.psm1') } | Should -Throw '*does not exist*'
    }

    It 'refuses an option no extension declares' {
        $suite = New-TestSuite 'noop' "suite: s`ntests:`n  - name: c`n    steps:`n      - action: core.noop`n"
        $outcome = Invoke-Probe $suite @{ Option = @{ region = 'eu' } }
        $outcome.ExitCode | Should -Be 2
        $outcome.Error | Should -Be 'Invoke-BddSuite does not take the option region: no extension of this run declares it.'
    }
}

Describe 'D7 a run with extensions' {
    It 'reads a context key from Start first, then the suite defaults, then as empty' {
        $ext = New-TestExtension -Name 'zones' -Description @'
@{
    Name = 'zones'; ContextKeys = @('zone', 'other', 'third'); Options = @(@{ Name = 'zone'; Description = 'z' })
    Start = { param($Options) if ($Options.ContainsKey('zone')) { @{ Context = @{ zone = $Options.zone } } } else { @{} } }
}
'@
        $suite = New-TestSuite 'zones' @'
suite: zones
defaults:
  zone: from-defaults
  other: other-default
tests:
  - name: reads
    steps:
      - action: core.set
        value: '${zone}|${other}|${third}|${timeoutSec}'
        captureAs: v
    asserts:
      - { var: v, equals: '${zone}|other-default||600' }
'@
        $given = Invoke-Probe $suite @{ Extension = @($ext); Option = @{ zone = 'from-start' } }
        $given.ExitCode | Should -Be 0
        $given.Suites[0].tests[0].stdout | Should -Match 'from-start\|other-default\|\|600'
        $fallback = Invoke-Probe $suite @{ Extension = @($ext) }
        $fallback.ExitCode | Should -Be 0
        $fallback.Suites[0].tests[0].stdout | Should -Match 'from-defaults\|other-default\|\|600'
        $without = Invoke-Probe $suite
        $without.ExitCode | Should -Be 2
        @($without.Diagnostics | ForEach-Object { $_.code } | Sort-Object -Unique) | Should -Be @('E301')
    }

    It 'loads action files in the step runspace with their helpers, the extension module, and each owner''s state' {
        $ext = New-TestExtension -Name 'helpers' -Extra 'function Get-ProbeGreeting { param($Name) "hello $Name" }' -Description @'
@{
    Name = 'helpers'; ActionPath = @('actions')
    Start = { param($Options) @{ State = @{ value = 'state-of-helpers' } } }
}
'@ -Actions @{ 'Probe.ps1' = @'
function Get-ProbeSuffix { return '!' }
Register-SuiteAction -Name 'probe.helper' -Handler {
    param($Step, $Ctx)
    return @{ said = (Get-ProbeGreeting $Step.text) + (Get-ProbeSuffix) }
}
Register-SuiteAction -Name 'probe.state' -Handler {
    param($Step, $Ctx)
    return @{ state = [string]$Ctx.state.value }
}
'@ }
        $folder = Split-Path -Parent (New-TestFile 'loose/actions/Loose.ps1' @'
function Get-LooseValue { return 'loose' }
Register-LabAction -Name 'probe.echo' -Handler { param($Step, $Ctx) @{ echoed = (Get-LooseValue) + ':' + $Step.text + ':' + [string]$Ctx.state } }
'@)
        $suite = New-TestSuite 'helpers' @'
suite: helpers
tests:
  - name: helpers
    steps:
      - { action: probe.helper, text: world, captureAs: h }
      - { action: probe.state, captureAs: s }
      - { action: probe.echo, text: x, captureAs: e }
    asserts:
      - { var: h.said, equals: 'hello world!' }
      - { var: s.state, equals: state-of-helpers }
      - { var: e.echoed, equals: 'loose:x:' }
'@
        $outcome = Invoke-Probe $suite @{ Extension = @($ext); ActionPath = @($folder) }
        $outcome.Error | Should -BeNullOrEmpty
        $outcome.Suites[0].tests[0].message | Should -BeNullOrEmpty
        $outcome.ExitCode | Should -Be 0
        Get-SuiteActionOwner -Name 'probe.echo' | Should -Be ([IO.Path]::GetFullPath($folder))
        Get-SuiteActionOwner -Name 'probe.state' | Should -Be 'helpers'
    }

    It 'fails a step whose action no extension registers, with the message every runtime uses' {
        $suite = New-TestSuite 'unregistered' "suite: s`ntests:`n  - name: c`n    steps:`n      - { action: probe.unregistered, text: x }`n"
        $outcome = Invoke-Probe $suite
        $outcome.ExitCode | Should -Be 1
        $outcome.Suites[0].tests[0].message | Should -Be 'Unknown action: probe.unregistered. No extension of this runtime registers it.'
        $dry = Invoke-Probe $suite @{ DryRun = $true }
        $dry.ExitCode | Should -Be 1
    }

    It 'runs a case within the composite CaseLimitSec, whatever it declares' {
        $ext = New-TestExtension -Name 'ceiling' -Description "@{ Name = 'ceiling'; Rules = @{ CaseLimitSec = { param(`$Suite, `$Declared) [math]::Min(`$Declared, 1) } } }"
        $suite = New-TestSuite 'ceiling' "suite: s`ntests:`n  - name: c`n    timeoutSec: 30`n    steps:`n      - { action: core.sleep, seconds: 4 }`n"
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $outcome = Invoke-Probe $suite @{ Extension = @($ext) }
        $watch.Stop()
        $outcome.ExitCode | Should -Be 1
        $watch.Elapsed.TotalSeconds | Should -BeLessThan 3.9
        $outcome.Suites[0].tests[0].message | Should -Match 'Case exceeded its 1s budget'
        ($outcome.Trace | Where-Object { $_.phase -eq 'case' }).reason | Should -Be 'timeout'
    }

    It 'applies every extension''s redaction to report texts and output' {
        $ext = New-TestExtension -Name 'secret' -Description "@{ Name = 'secret'; Start = { param(`$o) @{ Redact = { param(`$t) `$t -replace 'hunter2', '[redacted]' } } } }"
        $suite = New-TestSuite 'secret' @'
suite: secret
tests:
  - name: leaks
    steps:
      - { action: core.set, value: 'the password is hunter2', captureAs: v }
      - { action: core.fail, message: 'failed with hunter2' }
'@
        $outcome = Invoke-Probe $suite @{ Extension = @($ext) }
        $outcome.ExitCode | Should -Be 1
        $report = Get-Content -LiteralPath $outcome.Report -Raw
        $report | Should -Not -Match 'hunter2'
        $report | Should -Match 'failed with \[redacted\]'
        $report | Should -Match 'the password is \[redacted\]'
        $outcome.Suites[0].tests[0].message | Should -Not -Match 'hunter2'
    }

    It 'reads parameters and the record path under the composite environment prefix' {
        $record = Join-Path $TestDrive 'record.txt'
        $suite = New-TestSuite 'prefix' @'
suite: prefix
params:
  - { name: greeting }
tests:
  - name: c
    steps:
      - { action: core.record, marker: '${param.greeting}' }
'@
        $ext = New-TestExtension -Name 'prefix' -Description "@{ Name = 'prefix'; EnvPrefix = 'PROBE_' }"
        try {
            $env:BDD_SUITE_PARAM_GREETING = 'from-default-prefix'
            $env:BDD_SUITE_RECORD_PATH = $record
            (Invoke-Probe $suite).ExitCode | Should -Be 0
            (Get-Content -LiteralPath $record) | Should -Be 'from-default-prefix'
            Remove-Item -LiteralPath $record
            $refused = Invoke-Probe $suite @{ Extension = @($ext) }
            Get-Finding $refused.Diagnostics | Should -Be @('E210@3:5')
            $env:PROBE_PARAM_GREETING = 'from-probe-prefix'
            $env:PROBE_RECORD_PATH = $record
            (Invoke-Probe $suite @{ Extension = @($ext) }).ExitCode | Should -Be 0
            (Get-Content -LiteralPath $record) | Should -Be 'from-probe-prefix'
        } finally {
            Remove-Item env:BDD_SUITE_PARAM_GREETING, env:BDD_SUITE_RECORD_PATH, env:PROBE_PARAM_GREETING, env:PROBE_RECORD_PATH -ErrorAction SilentlyContinue
        }
    }

    It 'writes the timings beside the trace, and only validates under -DryRun' {
        $suite = New-TestSuite 'timed' "suite: timed`ntests:`n  - name: c`n    steps:`n      - action: core.noop`n"
        $timings = Join-Path $TestDrive 'timings.json'
        $outcome = Invoke-Probe $suite @{ TimingFile = $timings }
        $outcome.ExitCode | Should -Be 0
        $document = Get-Content -LiteralPath $timings -Raw | ConvertFrom-Json
        $document.schema | Should -Be 'bdd.suite.timings.v1'
        @($document.cases).case | Should -Be @('c')
        @($document.steps).action | Should -Be @('core.noop')
        @($outcome.Trace | ForEach-Object { "$($_.phase):$($_.status)" }) | Should -Be @('step:passed', 'case:passed')
        $dry = Invoke-Probe $suite @{ DryRun = $true }
        $dry.ExitCode | Should -Be 0
        $dry.Suites[0].tests[0].status | Should -Be 'skipped'
        # A dry run validates and runs nothing, so it traces nothing either
        # (spec/session.md, rule 10), as every other runtime's dry run.
        @($dry.Trace).Count | Should -Be 0
    }

    It 'runs one named case, and stops between cases when the stop file appears' {
        $suite = New-TestSuite 'two' "suite: s`ntests:`n  - name: first`n    steps:`n      - action: core.noop`n  - name: second`n    steps:`n      - action: core.noop`n"
        $one = Invoke-Probe $suite @{ TestName = 'second' }
        $one.ExitCode | Should -Be 0
        @($one.Suites[0].tests).name | Should -Be @('second')
        $stop = New-TestFile 'stop.flag' 'stop'
        $stopped = Invoke-Probe $suite @{ StopFile = $stop }
        $stopped.ExitCode | Should -Be 1
        @($stopped.Suites[0].tests).Count | Should -Be 0
    }
}

Describe 'The Cases part: case hooks (PowerShell only)' {
    BeforeEach { $global:CaseHookLog = [Collections.Generic.List[string]]::new() }
    AfterAll { Remove-Variable -Name CaseHookLog, CaseHookSites -Scope Global -ErrorAction SilentlyContinue }

    It 'refuses a hook it does not know, or one that is no scriptblock' {
        { Import-SuiteExtension -Path (New-TestExtension -Name 'badhook' -Description "@{ Name = 'badhook'; Cases = @{ BeforeAll = { 1 } } }") } |
            Should -Throw 'Extension badhook declares the case hook BeforeAll; a case hook is SkipCase, CaseContext, CheckStep, SkipStep, WorkStarted, AfterStep, WorkFinished, CaseFinally, AfterCase, AfterSuiteHook, AfterTeardown.'
        { Import-SuiteExtension -Path (New-TestExtension -Name 'texthook' -Description "@{ Name = 'texthook'; Cases = @{ AfterCase = 'no' } }") } |
            Should -Throw 'Extension texthook declares the case hook AfterCase as something other than a scriptblock.'
        { Import-SuiteExtension -Path (New-TestExtension -Name 'listhook' -Description "@{ Name = 'listhook'; Cases = 'no' }") } |
            Should -Throw 'Extension listhook declares Cases as something other than a hashtable of hooks.'
    }

    It 'calls every hook at its point of a case, in order, with its own extension''s State' {
        $ext = New-TestExtension -Name 'order' -Description @'
@{
    Name = 'order'; ContextKeys = @('zone')
    Start = { param($Options) @{ State = 'order-state' } }
    Cases = @{
        SkipCase       = { param($In) $global:CaseHookLog.Add("SkipCase $($In.CaseName) $($In.State) $($In.SuiteName) $($In.DryRun)") }
        CaseContext    = { param($In) $global:CaseHookLog.Add("CaseContext $(if ($In.Case) { $In.Case.name } else { '(suite)' })") }
        CheckStep      = { param($In) $global:CaseHookLog.Add("CheckStep $($In.Step.value)") }
        SkipStep       = { param($In) $global:CaseHookLog.Add("SkipStep $($In.Phase) $($In.CaseName)") }
        WorkStarted    = { param($In) $global:CaseHookLog.Add("WorkStarted $($In.CaseName)") }
        AfterStep      = { param($In) $global:CaseHookLog.Add("AfterStep $($In.Step.value)") }
        WorkFinished   = { param($In) $global:CaseHookLog.Add("WorkFinished $($In.CaseName) $($In.Status) $($In.WorkSec -ge 0)") }
        CaseFinally    = { param($In) $global:CaseHookLog.Add("CaseFinally $($In.CaseName) $($In.Status)") }
        AfterCase      = { param($In) $global:CaseHookLog.Add("AfterCase $($In.CaseName) $($In.Status) $($null -ne $In.SuiteCtx)") }
        AfterSuiteHook = { param($In) $global:CaseHookLog.Add("AfterSuiteHook $($In.Hook) $($In.Ctx.zone -eq '')") }
        AfterTeardown  = { param($In) $global:CaseHookLog.Add("AfterTeardown $($null -ne $In.Ctx)") }
    }
}
'@
        $suite = New-TestSuite 'order' @'
suite: order
setup: [ { action: core.set, value: suite-setup } ]
beforeEach: [ { action: core.set, value: before-each } ]
afterEach: [ { action: core.set, value: after-each } ]
teardown: [ { action: core.set, value: teardown } ]
tests:
  - name: c
    setup: [ { action: core.set, value: case-setup } ]
    steps: [ { action: core.set, value: step } ]
    cleanup: [ { action: core.set, value: cleanup } ]
'@
        $outcome = Invoke-Probe $suite @{ Extension = @($ext) }
        $outcome.ExitCode | Should -Be 0
        @($global:CaseHookLog) | Should -Be @(
            'CaseContext (suite)', 'SkipStep suite-setup ', 'AfterSuiteHook setup True',
            'SkipCase c order-state order False', 'CaseContext c',
            'CheckStep suite-setup', 'CheckStep before-each', 'CheckStep case-setup', 'CheckStep step', 'CheckStep cleanup', 'CheckStep after-each', 'CheckStep teardown',
            'SkipStep before-each c', 'SkipStep case-setup c', 'WorkStarted c', 'SkipStep step c', 'AfterStep step', 'WorkFinished c passed True',
            'SkipStep case-cleanup c', 'SkipStep after-each c', 'CaseFinally c passed', 'AfterCase c passed True',
            'SkipStep suite-teardown ', 'AfterSuiteHook teardown True', 'AfterTeardown True')
    }

    It 'skips a case before any of its steps (SkipCase), with the sentence and the reason, the first extension deciding' {
        $first = New-TestExtension -Name 'skipfirst' -Description @'
@{ Name = 'skipfirst'; Cases = @{ SkipCase = { param($In)
    if ($In.Case.name -eq 'plain') { 'Not for this run.' }
    elseif ($In.Case.name -eq 'named') { @{ Message = 'Named skip.'; Reason = 'probe-reason' } } } } }
'@
        $second = New-TestExtension -Name 'skipsecond' -Description @'
@{ Name = 'skipsecond'; Cases = @{ SkipCase = { param($In) $global:CaseHookLog.Add("asked $($In.CaseName)") } } }
'@
        $suite = New-TestSuite 'skipcase' @'
suite: skipcase
setup: [ { action: core.fail, message: the setup broke } ]
tests:
  - name: plain
    steps: [ { action: core.fail, message: must not run } ]
  - name: named
    steps: [ { action: core.fail, message: must not run } ]
  - name: runs
    steps: [ { action: core.noop } ]
'@
        $timings = Join-Path $TestDrive 'skipcase-timings.json'
        $outcome = Invoke-Probe $suite @{ Extension = @($first, $second); TimingFile = $timings }
        $tests = @($outcome.Suites[0].tests)
        $tests[0].status | Should -Be 'skipped'
        $tests[0].message | Should -Be 'Not for this run.'
        $tests[1].status | Should -Be 'skipped'
        $tests[1].message | Should -Be 'Named skip.'
        # A skipped case is not charged with the failed suite setup; the case
        # that is not skipped is.
        $tests[2].status | Should -Be 'error'
        @($outcome.Trace | Where-Object { $_.phase -eq 'case' } | ForEach-Object { "$($_.case):$($_.status):$($_.reason)" }) |
            Should -Be @('plain:skipped:not-applicable', 'named:skipped:probe-reason', 'runs:error:suite-setup')
        @($global:CaseHookLog) | Should -Be @('asked runs')
        (Get-Content -LiteralPath $outcome.Report -Raw) | Should -Match 'Not for this run\.'
        @((Get-Content -LiteralPath $timings -Raw | ConvertFrom-Json).cases | ForEach-Object { $_.case }) | Should -Be @('runs')
    }

    It 'skips a step in any phase (SkipStep): the trace takes the reason, the timings and the step event the sentence' {
        $ext = New-TestExtension -Name 'skipstep' -Description @'
@{ Name = 'skipstep'; Cases = @{ SkipStep = { param($In)
    $sites = @($In.Step.__useSites | Where-Object { $_ })
    if ($sites.Count) { $global:CaseHookSites = @($sites | ForEach-Object { [string]$_.given }) }
    if ($In.Step.message -eq 'skip me') { 'Skipped by the probe.' }
    elseif (@($sites | Where-Object { $_.given -eq 'a group to skip' }).Count) { @{ Message = 'Skipped by its use site.'; Reason = 'probe-site' } } } } }
'@
        $suite = New-TestSuite 'skipstep' @'
suite: skipstep
metaSteps:
  - name: inner
    steps:
      - { action: core.fail, message: the inner group ran }
  - name: outer
    steps:
      - given: the inner group
        meta: inner
tests:
  - name: c
    setup: [ { action: core.fail, message: skip me } ]
    steps:
      - { action: core.fail, message: skip me }
      - given: a group to skip
        meta: outer
      - { action: core.set, value: ran, captureAs: v }
    cleanup: [ { action: core.fail, message: skip me } ]
'@
        $timings = Join-Path $TestDrive 'skipstep-timings.json'
        $outcome = Invoke-Probe $suite @{ Extension = @($ext); TimingFile = $timings }
        $outcome.ExitCode | Should -Be 0
        $outcome.Suites[0].tests[0].stdout | Should -Match 'ran'
        @($outcome.Trace | ForEach-Object { "$($_.phase):$($_.status):$($_.reason)" }) | Should -Be @(
            'case-setup:skipped:not-applicable', 'step:skipped:not-applicable', 'step:skipped:probe-site', 'step:passed:', 'case-cleanup:skipped:not-applicable', 'case:passed:')
        $rows = @((Get-Content -LiteralPath $timings -Raw | ConvertFrom-Json).steps)
        @($rows | ForEach-Object { "$($_.phase):$($_.status):$($_.reason)" }) | Should -Be @(
            'case-setup:skipped:Skipped by the probe.', 'step:skipped:Skipped by the probe.', 'step:skipped:Skipped by its use site.', 'step:passed:', 'case-cleanup:skipped:Skipped by the probe.')
        # Each step a use site stands for carries the use sites it came
        # through, innermost first, without the meta fields the core consumed.
        $global:CaseHookSites | Should -Be @('the inner group', 'a group to skip')
    }

    It 'adds each extension''s own context keys to a case and a suite hook context (CaseContext), before the vars' {
        $ext = New-TestExtension -Name 'ctxhook' -Description @'
@{
    Name = 'ctxhook'; ContextKeys = @('zone')
    Cases = @{ CaseContext = { param($In)
        $In.Ctx['probeField'] = 'added'
        @{ zone = $(if ($In.Case) { "zone-of-$($In.Case.name)" } else { "suite-zone-$($In.Ctx.zone)" }); capture = 'not its key' } } }
}
'@
        $other = New-TestExtension -Name 'ctxother' -Description "@{ Name = 'ctxother'; ContextKeys = @('other') }"
        $suite = New-TestSuite 'ctxhook' @'
suite: ctxhook
defaults:
  zone: from-defaults
  other: other-default
setup: [ { action: core.set, value: '${zone}', captureAs: suiteZone } ]
vars:
  seen: '${zone}|${other}'
tests:
  - name: c
    steps:
      - { action: core.set, value: '${var.seen}|${capture.suiteZone}', captureAs: v }
    asserts:
      - { var: v, equals: 'zone-of-c|other-default|suite-zone-from-defaults' }
'@
        $outcome = Invoke-Probe $suite @{ Extension = @($ext, $other) }
        $outcome.Suites[0].tests[0].message | Should -BeNullOrEmpty
        $outcome.ExitCode | Should -Be 0
    }

    It 'fails a case whose step an extension refuses (CheckStep), under -DryRun too, before anything runs' {
        $ext = New-TestExtension -Name 'check' -Description @'
@{ Name = 'check'; Cases = @{ CheckStep = { param($In) if ($In.Step.value -eq 'refused') { throw "The probe refuses $($In.Step.value) in $($In.CaseName)." } } } }
'@
        $suite = New-TestSuite 'check' @'
suite: check
tests:
  - name: c
    steps:
      - { action: core.record, marker: must-not-run }
      - { action: core.set, value: refused }
'@
        $record = Join-Path $TestDrive 'check-record.txt'
        try {
            $env:BDD_SUITE_RECORD_PATH = $record
            $outcome = Invoke-Probe $suite @{ Extension = @($ext) }
            $dry = Invoke-Probe $suite @{ Extension = @($ext); DryRun = $true }
        } finally { Remove-Item env:BDD_SUITE_RECORD_PATH -ErrorAction SilentlyContinue }
        foreach ($run in @($outcome, $dry)) {
            $run.ExitCode | Should -Be 1
            $run.Suites[0].tests[0].message | Should -Be 'The probe refuses refused in c.'
        }
        Test-Path -LiteralPath $record | Should -BeFalse
        @($outcome.Trace | ForEach-Object { "$($_.phase):$($_.status)" }) | Should -Be @('case:failed')
    }

    It 'fails a case after a step that passed (AfterStep), and its cleanup still runs' {
        $ext = New-TestExtension -Name 'afterstep' -Description @'
@{ Name = 'afterstep'; Cases = @{ AfterStep = { param($In) if ($In.Step.value -eq 'first') { 'The probe saw something wrong; cleanup will still run.' } } } }
'@
        $suite = New-TestSuite 'afterstep' @'
suite: afterstep
tests:
  - name: c
    steps:
      - { action: core.set, value: first }
      - { action: core.set, value: second }
    cleanup:
      - { action: core.noop }
'@
        $outcome = Invoke-Probe $suite @{ Extension = @($ext) }
        $outcome.ExitCode | Should -Be 1
        $outcome.Suites[0].tests[0].message | Should -Be 'The probe saw something wrong; cleanup will still run.'
        @($outcome.Trace | ForEach-Object { "$($_.phase):$($_.status)" }) | Should -Be @('step:passed', 'case-cleanup:passed', 'case:failed')
    }

    It 'runs WorkFinished and CaseFinally for a case that failed, and WorkStarted only once its hooks passed' {
        $ext = New-TestExtension -Name 'work' -Description @'
@{ Name = 'work'; Cases = @{
    WorkStarted  = { param($In) $global:CaseHookLog.Add("started $($In.CaseName)") }
    WorkFinished = { param($In) $global:CaseHookLog.Add("finished $($In.CaseName) $($In.Status)") }
    CaseFinally  = { param($In) $global:CaseHookLog.Add("finally $($In.CaseName) $($In.Status) $($In.Ctx.capture.cleaned)") } } }
'@
        $suite = New-TestSuite 'work' @'
suite: work
tests:
  - name: setup-fails
    setup: [ { action: core.fail, message: no } ]
    steps: [ { action: core.noop } ]
    cleanup: [ { action: core.set, value: yes, captureAs: cleaned } ]
  - name: step-fails
    steps: [ { action: core.fail, message: no } ]
    cleanup: [ { action: core.set, value: yes, captureAs: cleaned } ]
'@
        $outcome = Invoke-Probe $suite @{ Extension = @($ext) }
        $outcome.ExitCode | Should -Be 1
        @($global:CaseHookLog) | Should -Be @(
            'finished setup-fails failed', 'finally setup-fails failed yes',
            'started step-fails', 'finished step-fails failed', 'finally step-fails failed yes')
    }

    It 'fails a case with every AfterCase failure, appended in order, each hook seeing the status before it' {
        $first = New-TestExtension -Name 'aftercase1' -Description @'
@{ Name = 'aftercase1'; Cases = @{ AfterCase = { param($In)
    if ($In.Case.name -eq 'fails') { @{ Message = 'First failure.'; Reason = 'probe-evidence'; Line = 'first failure, briefly.' }; 'Second failure.' } } } }
'@
        $second = New-TestExtension -Name 'aftercase2' -Description @'
@{ Name = 'aftercase2'; Cases = @{ AfterCase = { param($In) $global:CaseHookLog.Add("$($In.CaseName) $($In.Status)") } } }
'@
        $suite = New-TestSuite 'aftercase' @'
suite: aftercase
tests:
  - name: fails
    steps: [ { action: core.noop } ]
  - name: passes
    steps: [ { action: core.noop } ]
'@
        $timings = Join-Path $TestDrive 'aftercase-timings.json'
        $outcome = Invoke-Probe $suite @{ Extension = @($first, $second); TimingFile = $timings }
        $outcome.ExitCode | Should -Be 1
        $outcome.Suites[0].tests[0].status | Should -Be 'failed'
        $outcome.Suites[0].tests[0].message | Should -Be ' First failure. Second failure.'
        $outcome.Suites[0].tests[1].status | Should -Be 'passed'
        @($outcome.Trace | Where-Object { $_.phase -eq 'case' } | ForEach-Object { "$($_.case):$($_.status):$($_.reason)" }) | Should -Be @('fails:failed:hook', 'passes:passed:')
        @($global:CaseHookLog) | Should -Be @('fails failed', 'passes passed')
        @((Get-Content -LiteralPath $timings -Raw | ConvertFrom-Json).cases | ForEach-Object { $_.status }) | Should -Be @('failed', 'passed')
        $named = New-TestExtension -Name 'aftercase3' -Description "@{ Name = 'aftercase3'; Cases = @{ AfterCase = { param(`$In) @{ Message = 'Named.'; Reason = 'probe-evidence' } } } }"
        $once = Invoke-Probe $suite @{ Extension = @($named); TestName = 'passes' }
        @($once.Trace | Where-Object { $_.phase -eq 'case' } | ForEach-Object { "$($_.status):$($_.reason)" }) | Should -Be @('failed:probe-evidence')
        $once.Suites[0].tests[0].message | Should -Be ' Named.'
    }

    It 'refuses a suite setup or teardown whose steps passed (AfterSuiteHook), and calls AfterTeardown after every teardown' {
        $ext = New-TestExtension -Name 'suitehook' -Description @'
@{ Name = 'suitehook'; Cases = @{
    AfterSuiteHook = { param($In) if ($In.Ctx.capture.refuse -eq $In.Hook) { "The probe refuses the suite $($In.Hook)." } }
    AfterTeardown  = { param($In) $global:CaseHookLog.Add("after teardown $($In.Ctx.capture.refuse)") } } }
'@
        $setup = New-TestSuite 'suitehook-setup' @'
suite: suitehook-setup
setup: [ { action: core.set, value: setup, captureAs: refuse } ]
tests:
  - name: c
    steps: [ { action: core.noop } ]
'@
        $refused = Invoke-Probe $setup @{ Extension = @($ext) }
        $refused.ExitCode | Should -Be 1
        $refused.Suites[0].tests[0].status | Should -Be 'error'
        $refused.Suites[0].tests[0].message | Should -Be 'Suite setup failed: The probe refuses the suite setup.'
        @($global:CaseHookLog).Count | Should -Be 0 -Because 'a suite with no teardown has no AfterTeardown'
        $teardown = New-TestSuite 'suitehook-teardown' @'
suite: suitehook-teardown
setup: [ { action: core.set, value: teardown, captureAs: refuse } ]
teardown: [ { action: core.noop } ]
tests:
  - name: c
    steps: [ { action: core.noop } ]
'@
        $failed = Invoke-Probe $teardown @{ Extension = @($ext) }
        $failed.ExitCode | Should -Be 1
        @($failed.Suites[0].tests | ForEach-Object { "$($_.name):$($_.status)" }) | Should -Be @('c:passed', 'teardown:failed')
        $failed.Suites[0].tests[1].message | Should -Be 'The probe refuses the suite teardown.'
        @($global:CaseHookLog) | Should -Be @('after teardown teardown')
    }
}

Describe 'D7 lint: no product rules in the core, extension rules after it' {
    It 'reports nothing for a suite tagged lifecycle that the old core rule refused' {
        $suite = New-TestSuite 'tagged' "suite: s`ntags: [lifecycle]`ndefaults:`n  timeoutSec: 1200`ntests:`n  - name: c`n    steps:`n      - action: core.noop`n"
        @(Invoke-SuiteLintFile -FilePath $suite -SchemaRoot $script:schemaRoot | Where-Object { $_ }).Count | Should -Be 0
    }

    It 'reports nothing for a suite that imports a library named shared-checks.yml and calls none of it (E214 left the core)' {
        $null = New-TestFile 'shared/shared-checks.yml' "metaSteps:`n  - name: check-r1-preview`n    steps:`n      - action: core.noop`n"
        $suite = New-TestFile 'shared/uses.yml' "suite: s`nimports: ['shared-checks.yml']`ntests:`n  - name: c`n    steps:`n      - action: core.noop`n"
        @(Invoke-SuiteLintFile -FilePath $suite -SchemaRoot $script:schemaRoot | Where-Object { $_ }).Count | Should -Be 0
    }

    It 'gives an extension rule the parsed file, its positions and the import list, and keeps what it reports' {
        $null = New-TestFile 'rule/lib.yml' "vars:`n  shared: 1`n"
        $suite = New-TestFile 'rule/uses.yml' "suite: s`nimports: ['lib.yml']`ntests:`n  - name: c`n    steps:`n      - action: core.noop`n"
        $ext = Import-SuiteExtension -Path (New-TestExtension -Name 'rule' -Description @'
@{
    Name = 'rule'
    Rules = @{ Lint = { param($In)
        foreach ($import in $In.Imports) {
            New-SuiteDiagnostic -Code 'W303' -Severity warning -File $In.File -Position $In.Positions[$import.pointer] -At value -Message "imports $($import.import) at $([IO.Path]::GetFileName($import.path))"
        }
    } }
}
'@)
        $composite = New-SuiteComposite -Extension @($ext)
        $found = @(Invoke-SuiteLintFile -FilePath $suite -SchemaRoot $script:schemaRoot -Composite $composite | Where-Object { $_ })
        Get-Finding $found | Should -Be @('W303@2:11')
        $found[0].message | Should -Be 'imports lib.yml at lib.yml'
    }

    It 'knows a context key only when an extension declares it' {
        $suite = New-TestSuite 'key' "suite: s`ntests:`n  - name: c`n    steps:`n      - { action: core.set, value: '`${zone}', captureAs: v }`n    asserts:`n      - { var: v, equals: x }`n"
        $found = @(Invoke-SuiteLintFile -FilePath $suite -SchemaRoot $script:schemaRoot | Where-Object { $_ })
        @($found | ForEach-Object { "$($_.code)@$($_.line)" }) | Should -Be @('E301@5')
        $composite = New-SuiteComposite -Extension @(Import-SuiteExtension -Path (New-TestExtension -Name 'zone' -Description "@{ Name = 'zone'; ContextKeys = @('zone') }"))
        @(Invoke-SuiteLintFile -FilePath $suite -SchemaRoot $script:schemaRoot -Composite $composite | Where-Object { $_ }).Count | Should -Be 0
    }

    It 'resolves an expression root from the scope it is given' {
        { Invoke-SuiteExpression -Text 'zone' -Scope @{ zone = 'x' } } | Should -Throw 'E301:*'
        Invoke-SuiteExpression -Text 'zone' -Scope @{ zone = 'x'; __roots = @('zone') } | Should -Be 'x'
        (Get-ExpressionRoot -Scope @{}) -join ',' | Should -Be 'capture,param,var,row,timeoutSec,defaults'
    }
}

Describe 'D7 the Test-Json defect and its fix' {
    It 'finds every structural failure of validate/typos.yml, where Test-Json on 7.6.7 found none' {
        $schema = Import-SuiteSchema -SchemaRoot $script:corpusSchema -Force
        $model = ConvertFrom-SuiteYaml (Get-Content -LiteralPath (Join-Path $script:corpusRoot 'validate/typos.yml') -Raw)
        $json = ConvertTo-Json -InputObject $model -Depth 64
        $failures = @(Invoke-SchemaValidation -Json $json -Schema $schema.lintSchemaText)
        @($failures | ForEach-Object { "$($_.pointer)|$($_.body)" }) | Should -Be @(
            '/tests/0/timeout|All values fail against the false schema',
            '/tests/0/assert|All values fail against the false schema')
        $found = Invoke-SuiteLintFile -FilePath (Join-Path $script:corpusRoot 'validate/typos.yml') -SchemaRoot $script:corpusSchema -RepositoryRoot $script:corpusRoot
        Get-Finding $found | Should -Be @('E101@4:5', 'E104@6:17', 'E101@8:5')
    }

    It 'maps required, type and unknown keys with the pointer the old Test-Json text carried' {
        $schema = '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["name","tests"],"additionalProperties":false,"properties":{"name":{"type":"string"},"a~b/c":{"type":"string"},"tests":{"type":"array"}}}'
        $failures = @(Invoke-SchemaValidation -Json '{"name":5,"a~b/c":1,"extra":true}' -Schema $schema)
        $failures | ForEach-Object { "$($_.pointer)|$($_.body)" } | Should -Be @(
            '|Required properties ["tests"] are not present',
            '/name|Value is "integer" but should be "string"',
            '/a~0b~1c|Value is "integer" but should be "string"',
            '/extra|All values fail against the false schema')
        $failed = $null
        Test-SuiteJson -Json '{"name":"x","tests":[]}' -Schema $schema | Should -BeTrue
        Test-SuiteJson -Json '{"name":"x"}' -Schema $schema -Failure ([ref]$failed) | Should -BeFalse
        $failed[0].body | Should -Match 'Required properties'
    }
}

Describe 'D7 where the schema is' {
    It 'refuses to guess a workspace with no test/e2e/schema above it, and uses -SchemaRoot as given' {
        $alone = Join-Path $TestDrive 'alone'
        $null = New-Item -ItemType Directory -Path $alone -Force
        $suite = New-TestFile 'alone/a.yml' "suite: s`ntests:`n  - name: c`n    steps:`n      - action: core.noop`n"
        Push-Location $alone
        try {
            if (Get-SuiteWorkspaceRoot) { Set-ItResult -Skipped -Because 'a folder above TestDrive holds test/e2e/schema' ; return }
            $refused = Invoke-BddSuite -Path 'a.yml' -Json
            $refused.ExitCode | Should -Be 2
            $refused.Error | Should -Be 'the workspace root cannot be found from this directory (no test/e2e/schema above it); pass -SchemaRoot.'
            $given = Invoke-BddSuite -Path 'a.yml' -SchemaRoot $script:schemaRoot -Lint -Json
            $given.ExitCode | Should -Be 0
        } finally { Pop-Location }
    }

    It 'finds the workspace root by walking up to test/e2e/schema, and reports paths relative to it' {
        $workspace = Join-Path $TestDrive 'ws'
        $null = New-Item -ItemType Directory -Path (Join-Path $workspace 'test/e2e') -Force
        Copy-Item -LiteralPath $script:schemaRoot -Destination (Join-Path $workspace 'test/e2e/schema') -Recurse
        $null = New-TestFile 'ws/suites/bad.yml' "suite: s`ntests:`n  - name: c`n    stepz:`n      - action: core.noop`n"
        Push-Location (Join-Path $workspace 'suites')
        try {
            $outcome = Invoke-BddSuite -Path 'bad.yml' -Lint -Json
            $outcome.ExitCode | Should -Be 2
            @($outcome.Diagnostics)[0].file | Should -Be 'suites/bad.yml'
        } finally { Pop-Location }
    }
}

Describe 'D7 linting many files' {
    It 'lints every file a glob matches, against the given schema, with the given extensions' {
        $null = New-TestFile 'many/a.yml' "suite: a`ntests:`n  - name: c`n    stepz:`n      - action: core.noop`n"
        $null = New-TestFile 'many/b.yml' "suite: b`ntests:`n  - name: c`n    steps:`n      - { action: core.set, value: '`${zone}', captureAs: v }`n    asserts:`n      - { var: v, equals: x }`n"
        Push-Location (Join-Path $TestDrive 'many')
        try {
            $found = @(Invoke-SuiteLint -Path '*.yml' -SchemaRoot $script:schemaRoot)
            @($found | ForEach-Object { "$($_.file):$($_.code)" }) | Should -Be @('a.yml:E102', 'a.yml:E101', 'b.yml:E301')
            $composite = New-SuiteComposite -Extension @(Import-SuiteExtension -Path (New-TestExtension -Name 'zone2' -Description "@{ Name = 'zone2'; ContextKeys = @('zone') }"))
            @(Invoke-SuiteLint -Path '*.yml' -SchemaRoot $script:schemaRoot -Composite $composite | ForEach-Object { "$($_.file):$($_.code)" }) | Should -Be @('a.yml:E102', 'a.yml:E101')
            { Invoke-SuiteLint -Path 'nothing-*.yml' -SchemaRoot $script:schemaRoot } | Should -Throw 'No suite files matched*'
        } finally { Pop-Location }
    }
}

Describe 'D7 catalog imports (DEC-S10)' {
    It 'reads imports depth first in listed order, relative to the importing file' {
        $null = New-TestFile 'cat1/sub/d.yaml' "actions:`n  - name: d.one`n"
        $null = New-TestFile 'cat1/b.yaml' "imports: ['sub/d.yaml']`nactions:`n  - name: b.one`n"
        $null = New-TestFile 'cat1/c.yaml' "actions:`n  - name: c.one`n"
        $root = New-TestFile 'cat1/a.yaml' "imports: ['b.yaml', 'c.yaml']`nactions:`n  - name: a.one`n"
        @(Read-SuiteCatalog -Path $root | ForEach-Object { $_.action.name }) | Should -Be @('d.one', 'b.one', 'c.one', 'a.one')
    }

    It 'refuses a name declared twice, naming both files, an import cycle and a missing import' {
        $null = New-TestFile 'cat2/b.yaml' "actions:`n  - name: same`n"
        $null = New-TestFile 'cat2/c.yaml' "actions:`n  - name: same`n"
        $twice = New-TestFile 'cat2/a.yaml' "imports: ['b.yaml', 'c.yaml']`n"
        $b = [IO.Path]::GetFullPath((Join-Path $TestDrive 'cat2/b.yaml'))
        $c = [IO.Path]::GetFullPath((Join-Path $TestDrive 'cat2/c.yaml'))
        { Read-SuiteCatalog -Path $twice } | Should -Throw "Action same is declared twice: in $b and in $c."
        $null = New-TestFile 'cat3/b.yaml' "imports: ['a.yaml']`n"
        $cycle = New-TestFile 'cat3/a.yaml' "imports: ['b.yaml']`n"
        { Read-SuiteCatalog -Path $cycle } | Should -Throw 'Catalog import cycle: *a.yaml -> *b.yaml -> *a.yaml'
        $missing = New-TestFile 'cat4/a.yaml' "imports: ['nowhere.yaml']`n"
        { Read-SuiteCatalog -Path $missing } | Should -Throw '*imports nowhere.yaml, which does not exist*'
    }

    It 'lints against a catalog that imports the core' {
        $schema = Import-SuiteSchema -SchemaRoot $script:schemaRoot -Force
        $schema.actions.Keys | Should -Contain 'core.noop'
        $schema.actions.Keys | Should -Contain 'probe.echo'
        $schema.declaredIn['wait'] | Should -Be ([IO.Path]::GetFullPath((Join-Path $script:specRoot 'core.catalog.yaml')))
    }
}

Describe 'D7 the command line' {
    BeforeAll {
        $script:typos = Join-Path $script:corpusRoot 'validate/typos.yml'
        $script:unread = Join-Path $script:corpusRoot 'validate/unread.yml'
        $script:clean = New-TestSuite 'clean' "suite: s`ntests:`n  - name: c`n    steps:`n      - action: core.noop`n"
        $script:diagnosticSchema = Join-Path $script:specRoot 'diagnostic.schema.json'
    }

    It 'refuses a suite that does not lint, runs nothing and writes no report' {
        $report = Join-Path $TestDrive 'gate.xml'
        $output = (& pwsh -NoProfile -File $script:cli -Path $script:typos -SchemaRoot $script:corpusSchema -ResultsFile $report 2>&1) -join "`n"
        $LASTEXITCODE | Should -Be 2
        $output | Should -Match 'E104'
        $output | Should -Not -Match '\[RUN \]'
        Test-Path -LiteralPath $report | Should -BeFalse
    }

    It 'makes a warning fail the lint only under -Strict' {
        $null = & pwsh -NoProfile -File $script:cli -Path $script:unread -SchemaRoot $script:corpusSchema -Lint -Strict 2>&1
        $LASTEXITCODE | Should -Be 2
        $null = & pwsh -NoProfile -File $script:cli -Path $script:unread -SchemaRoot $script:corpusSchema -Lint 2>&1
        $LASTEXITCODE | Should -Be 0
    }

    It 'writes one document under -Json: the diagnostics diagnostic.schema.json defines, an array whatever the count' {
        $text = (& pwsh -NoProfile -File $script:cli -Path $script:typos -SchemaRoot $script:corpusSchema -Lint -Json) -join "`n"
        $LASTEXITCODE | Should -Be 2
        @($text | ConvertFrom-Json).Count | Should -Be 3
        Test-SuiteJson -Json $text -SchemaFile $script:diagnosticSchema | Should -BeTrue
        $clean = (& pwsh -NoProfile -File $script:cli -Path $script:clean -SchemaRoot $script:schemaRoot -Lint -Json) -join "`n"
        $LASTEXITCODE | Should -Be 0
        $clean.Trim() | Should -Be '[]'
        $one = (& pwsh -NoProfile -File $script:cli -Path $script:unread -SchemaRoot $script:corpusSchema -Lint -Json) -join "`n"
        $one.TrimStart() | Should -Match '^\['
        Test-SuiteJson -Json $one -SchemaFile $script:diagnosticSchema | Should -BeTrue
    }

    It 'takes -Option as name=value and refuses anything else' {
        $output = (& pwsh -NoProfile -File $script:cli -Path $script:clean -SchemaRoot $script:schemaRoot -Option 'not a pair' 2>&1) -join "`n"
        $LASTEXITCODE | Should -Be 2
        $output | Should -Match '-Option takes name=value'
    }
}

Describe 'D7 generic helpers carried over from SuiteLint.Tests.ps1' {
    It 'reads YAML exactly as ConvertFrom-Yaml -Ordered does' {
        function Format-YamlShape($Value) {
            if ($null -eq $Value) { return 'null' }
            $type = $Value.GetType().FullName
            if ($Value -is [System.Collections.IDictionary]) { return "{$type|" + (@($Value.Keys | ForEach-Object { "[$_]=" + (Format-YamlShape $Value[$_]) }) -join ',') + '}' }
            if ($Value -is [System.Collections.IList]) { return "[$type|" + (@($Value | ForEach-Object { Format-YamlShape $_ }) -join ',') + ']' }
            return "$type=$Value"
        }
        $samples = @(
            "a: word`nb: 'quoted'`nc: `"12`"`nd: true`ne: False`nf: 42`ng: 3000000000`nh: 123456789012345678901234567890`ni: 1.5`nj: -2e3`nk: .inf`nl: Infinity`nm: -Infinity`nn: NaN`no: nan`np: null`nq: ~`nr:`ns: Null`nt: nothing`nu: tomorrow`nv: fixture`nw: in`nx: +7`ny: 0x1F`nz: 0o17",
            "a: !!str 5`nb: !!int 0x1F`nc: !!int 0o17`nd: !!int 12`ne: !!float 2.5`nf: !!float -.inf`ng: !!null x`nh: !!bool true`ni: !!timestamp 2026-09-25T10:00:00Z`nj: !custom 7`nk: !!str`n",
            "- just`n- 1`n- [2, three, 'four']`n- { five: 5 }",
            "tests:`n  - name: a`n    steps: [ { given: x, why: y } ]`n"
        )
        foreach ($sample in $samples) {
            Format-YamlShape (ConvertFrom-SuiteYaml $sample) | Should -BeExactly (Format-YamlShape (ConvertFrom-Yaml $sample -Ordered))
        }
        $expected = ''; try { $null = ConvertFrom-Yaml 'a: [unclosed' -Ordered } catch { $expected = $_.Exception.Message }
        { ConvertFrom-SuiteYaml 'a: [unclosed' } | Should -Throw $expected
        ConvertFrom-SuiteYaml '' | Should -BeNullOrEmpty
    }

    It 'prunes schema definitions to what is reachable, cycles included' {
        $lint = (Get-Module BddSuite).NestedModules | Where-Object { $_.Name -eq 'SuiteLint' }
        $pruned = & $lint {
            Get-SuiteReferencedDefinitions -Definitions @{
                first  = '{"type":"object","properties":{"child":{"$ref":"#/$defs/second"}}}'
                second = '{"type":"object","properties":{"parent":{"$ref":"#/$defs/first"}},"required":["parent"]}'
                unused = '{"type":"string"}'
            } -Document '{"$ref":"#/$defs/first"}'
        } | ConvertFrom-Json -AsHashtable
        @($pruned.Keys | Sort-Object) | Should -Be @('first', 'second')
        $pruned.second.required[0] | Should -Be 'parent'
    }

    It 'sorts findings totally, positions them at the key or the value, and drops an exact duplicate' {
        $tied = @(
            (New-SuiteDiagnostic -Code 'E103' -File 'b.yml' -Message 'second file' -Position @{ keyLine = 1; keyColumn = 1 }),
            (New-SuiteDiagnostic -Code 'E102' -File 'a.yml' -Message 'same place, lower code' -Position @{ keyLine = 7; keyColumn = 3 }),
            (New-SuiteDiagnostic -Code 'E101' -File 'a.yml' -Message 'same place, higher code' -Position @{ keyLine = 7; keyColumn = 3 }),
            (New-SuiteDiagnostic -Code 'E101' -File 'a.yml' -Message 'a second message at the same place' -Position @{ keyLine = 7; keyColumn = 3 }),
            (New-SuiteDiagnostic -Code 'E101' -File 'a.yml' -Message 'earlier line' -Position @{ keyLine = 2; keyColumn = 9 })
        )
        $sorted = Get-SortedSuiteDiagnostic -Diagnostic $tied
        @($sorted | ForEach-Object { "$($_.file):$($_.line):$($_.code)" }) -join ',' | Should -Be 'a.yml:2:E101,a.yml:7:E101,a.yml:7:E101,a.yml:7:E102,b.yml:1:E103'
        @(Get-SortedSuiteDiagnostic -Diagnostic (@($tied[0]) + @($tied[0]))).Count | Should -Be 1
        $yaml = Get-SuiteNodePosition -Text "suite: x`ntests:`n  - name: y"
        $onKey = New-SuiteDiagnostic -Code 'E101' -File 'a.yml' -Message 'key' -Position $yaml['/tests']
        $onValue = New-SuiteDiagnostic -Code 'E301' -File 'a.yml' -Message 'value' -Position $yaml['/suite'] -At value
        $onItem = New-SuiteDiagnostic -Code 'E103' -File 'a.yml' -Message 'item' -Position $yaml['/tests/0'] -At value
        "$($onKey.line):$($onKey.column) $($onValue.line):$($onValue.column) $($onItem.line):$($onItem.column)" | Should -Be '2:1 1:8 3:5'
        Test-SuiteJson -Json (ConvertTo-Json -InputObject @($sorted) -Depth 6) -SchemaFile (Join-Path $script:specRoot 'diagnostic.schema.json') | Should -BeTrue
    }

    It 'suggests the nearest spelling and formats a finding for a reader' {
        Get-EditDistance -Left 'asserts' -Right 'assert' | Should -Be 1
        Get-EditDistance -Left 'same' -Right 'SAME' | Should -Be 0
        Get-NearestSpelling -Word 'assert' -Candidates @('asserts', 'steps') | Should -Be 'asserts'
        Get-NearestSpelling -Word 'timeout' -Candidates @('timeoutSec', 'steps') | Should -Be 'timeoutSec'
        Get-NearestSpelling -Word 'completelyelsewhere' -Candidates @('asserts') | Should -BeNullOrEmpty
        $formatted = Format-SuiteDiagnostic (New-SuiteDiagnostic -Code 'E101' -File 'f.yml' -Message 'a message' -Suggestion 'a suggestion' -Position @{ keyLine = 3; keyColumn = 7 })
        $formatted | Should -Match '^f\.yml:3:7  E101  a message'
        $formatted | Should -Match '(?m)^    a suggestion$'
        (Split-SchemaErrorPointer -Text "The JSON is not valid with the schema: Bad at '/a/b'").pointer | Should -Be '/a/b'
        { Import-SuiteSchema -SchemaRoot (Join-Path $TestDrive 'nowhere') -Force } | Should -Throw '*Suite schema not found*'
    }
}

Describe 'D7 no product vocabulary in the runtime' {
    It 'names no os-context concept outside the corpus extension, the handover note and the tests that prove the removals' {
        $allowed = @('HANDOVER.md', 'BddSuite.Tests.ps1', 'BddSuite.Corpus.psm1')
        $pattern = '(?i)lifecycle|labId|apiUrl|HCI_|cluster\.(state|suspend)|os-context'
        $hits = foreach ($file in Get-ChildItem -LiteralPath $script:runtimeRoot -Recurse -File) {
            if ($allowed -contains $file.Name -or $file.Extension -notin @('.ps1', '.psm1', '.psd1', '.yml', '.yaml', '.json', '.md')) { continue }
            foreach ($match in Select-String -LiteralPath $file.FullName -Pattern $pattern) {
                # A line that only says where a piece came from, or what stayed
                # behind, is allowed: it names the source, not a concept.
                $stripped = $match.Line -replace '(?i)os-context', ''
                if ($stripped -notmatch $pattern -and $match.Line -match '(?i)copied|moved|stayed|7633e176|HANDOVER') { continue }
                "$($file.Name):$($match.LineNumber): $($match.Line.Trim())"
            }
        }
        @($hits) | Should -BeNullOrEmpty
    }
}
