<#
.SYNOPSIS
    The session (spec/session.md): one test per rule on small suites, the run
    context a test process reads from its environment, the Pester glue, and
    E1 (docs/test-providers): every execute entry through the session in file
    order and reversed.
#>

BeforeAll {
    $script:runtimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $script:corpusRoot = [IO.Path]::GetFullPath((Join-Path $script:runtimeRoot '../../conformance'))
    $script:corpusSchema = Join-Path $script:corpusRoot 'schema'
    $script:corpusExtension = Join-Path $PSScriptRoot 'CorpusExtension/BddSuite.Corpus.psm1'
    Import-Module powershell-yaml -ErrorAction Stop
    Import-Module (Join-Path $script:runtimeRoot 'BddSuite/BddSuite.psd1') -Force -DisableNameChecking

    $script:counter = 0
    function New-Context {
        param([hashtable]$Environment = @{})
        return New-BddSuiteRunContext -SchemaRoot $script:corpusSchema -Extension $script:corpusExtension -Environment $Environment
    }
    function Open-Suite {
        param([string]$Text, [hashtable]$Context = (New-Context), [switch]$Guarded)
        $script:counter++
        $path = Join-Path $TestDrive "s$($script:counter)/suite.yml"
        $null = New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force
        Set-Content -LiteralPath $path -Value $Text
        return Open-BddSuiteSession -Path $path -Context $Context -Guarded:$Guarded -NoLint
    }
    function Invoke-One {
        param([hashtable]$Session, $Case)
        Invoke-BddSuiteBeforeEach -Session $Session -Case $Case
        $ran = Invoke-BddSuiteCase -Session $Session -Case $Case
        $settled = Invoke-BddSuiteAfterEach -Session $Session -Case $Case
        return @{ Ran = $ran; Settled = $settled }
    }
    function Get-Phases {
        # The trace as 'phase case status' lines, steps left out.
        param([hashtable]$Session)
        return @($Session.Context.trace | Where-Object { $_.phase -ne 'step' } | ForEach-Object { ("$($_.phase) $($_.case) $($_.status)" -replace '  ', ' ').Trim() })
    }
    $script:hooked = @'
suite: hooked
setup: [ { action: core.noop } ]
beforeEach: [ { action: core.noop } ]
afterEach: [ { action: core.noop } ]
teardown: [ { action: core.noop } ]
tests:
  - name: one
    tags: [a]
    steps: [ { when: it works, action: core.noop } ]
  - name: two
    tags: [b]
    steps: [ { when: it works, action: core.noop } ]
'@
}

Describe 'the session (spec/session.md)' {
    It 'rule 1: operations out of order are refused, and a case never run still settles' {
        $s = Open-Suite $script:hooked
        { Invoke-BddSuiteCase -Session $s -Case 'one' } | Should -Throw '*needs Invoke-BddSuiteBeforeEach first*'
        { Invoke-BddSuiteAfterEach -Session $s -Case 'one' } | Should -Throw '*needs Invoke-BddSuiteBeforeEach first*'
        { Invoke-BddSuiteBeforeEach -Session $s -Case 'three' } | Should -Throw "*has no case named 'three'*"
        { Invoke-BddSuiteBeforeEach -Session $s -Case 9 } | Should -Throw '*has no case number 9*'
        Invoke-BddSuiteBeforeEach -Session $s -Case 'one'
        { Invoke-BddSuiteBeforeEach -Session $s -Case 'one' } | Should -Throw '*was called twice*'
        (Invoke-BddSuiteCase -Session $s -Case 'one').status | Should -Be 'passed'
        { Invoke-BddSuiteCase -Session $s -Case 'one' } | Should -Throw '*was called twice*'
        (Invoke-BddSuiteAfterEach -Session $s -Case 'one').status | Should -Be 'passed'
        Invoke-BddSuiteBeforeEach -Session $s -Case 'two'
        $settled = Invoke-BddSuiteAfterEach -Session $s -Case 'two'
        $settled.status, $settled.reason | Should -Be @('failed', 'hook')
        $settled.message | Should -BeLike "*beforeEach but not the case itself*"
    }

    It 'rule 2: setup runs once however often it is called, and beforeEach runs it' {
        $s = Open-Suite $script:hooked
        $null = Invoke-One $s 'one'
        Invoke-BddSuiteSetup -Session $s
        Invoke-BddSuiteSetup -Session $s
        @(Get-Phases $s | Where-Object { $_ -like 'suite-setup*' }).Count | Should -Be 1
    }

    It 'rule 2: nothing selected runs neither setup nor teardown' {
        $s = Open-Suite $script:hooked (New-Context @{ BDD_SUITE_TAGS = 'none' })
        Invoke-BddSuiteSetup -Session $s
        foreach ($name in 'one', 'two') {
            $r = (Invoke-One $s $name).Settled
            $r.status, $r.reason, $r.message | Should -Be @('skipped', 'tag', 'tag filter')
        }
        (Invoke-BddSuiteTeardown -Session $s).Ran | Should -BeFalse
        Get-Phases $s | Should -Be @('case one skipped', 'case two skipped')
    }

    It 'rule 3: a failed setup is recorded, every case reports it, and the teardown still runs' {
        $s = Open-Suite "suite: s`nsetup: [ { action: core.fail, message: no lab } ]`nteardown: [ { action: core.noop } ]`ntests:`n  - name: one`n    steps: [ { action: core.noop } ]`n"
        Invoke-BddSuiteSetup -Session $s
        $r = (Invoke-One $s 'one').Ran
        $r.status, $r.reason | Should -Be @('error', 'suite-setup')
        $r.message | Should -BeLike 'Suite setup failed: suite setup*'
        (Invoke-BddSuiteTeardown -Session $s).Ran | Should -BeTrue
    }

    It 'rule 3: a failed beforeEach is recorded and the case still cleans up' {
        $s = Open-Suite "suite: s`nbeforeEach: [ { action: core.fail, message: not ready } ]`nafterEach: [ { action: core.noop } ]`ntests:`n  - name: one`n    steps: [ { when: never, action: core.noop } ]`n    cleanup: [ { action: core.noop } ]`n"
        $r = Invoke-One $s 'one'
        $r.Ran.status, $r.Ran.reason | Should -Be @('failed', 'hook')
        $r.Settled.afterEachFailed | Should -BeFalse
        Get-Phases $s | Should -Be @('before-each one failed', 'case-cleanup one passed', 'after-each one passed', 'case one failed')
    }

    It 'rule 4: a failed afterEach settles the case and says so' {
        $s = Open-Suite "suite: s`nafterEach: [ { action: core.fail, message: could not reset } ]`ntests:`n  - name: one`n    steps: [ { action: core.noop } ]`n"
        $r = Invoke-One $s 'one'
        $r.Ran.status | Should -Be 'passed'
        $r.Settled.afterEachFailed | Should -BeTrue
        $r.Settled.status, $r.Settled.reason | Should -Be @('failed', 'hook')
        $r.Settled.message | Should -BeLike '*afterEach failed:*'
    }

    It 'rule 5: a deep copy of the bag keeps every collection''s type and shares nothing' {
        $list = [Collections.Generic.List[object]]::new(); $list.Add('a')
        $bag = @{ items = $list; nested = [ordered]@{ deep = @(1, @{ k = 'v' }) } }
        $copy = Copy-SuiteBagValue $bag
        $copy | Should -BeOfType [hashtable]
        $copy.items.GetType().Name | Should -Be 'List`1'
        $copy.nested | Should -BeOfType [System.Collections.Specialized.OrderedDictionary]
        $copy.items.Add('b')
        $copy.nested.deep[1].k = 'changed'
        $bag.items.Count | Should -Be 1
        $bag.nested.deep[1].k | Should -Be 'v'
    }

    It 'rule 6: teardown runs once and only after a setup; its failure is returned' {
        $s = Open-Suite $script:hooked
        (Invoke-BddSuiteTeardown -Session $s).Ran | Should -BeFalse
        Invoke-BddSuiteSetup -Session $s
        $first = Invoke-BddSuiteTeardown -Session $s
        $first.Ran, $first.Failed | Should -Be @($true, $false)
        (Invoke-BddSuiteTeardown -Session $s).Ran | Should -BeFalse
        $f = Open-Suite "suite: s`nteardown: [ { action: core.fail, message: left a mess } ]`ntests:`n  - name: one`n    steps: [ { action: core.noop } ]`n"
        (Invoke-One $f 'one').Settled.status | Should -Be 'passed'
        $t = Invoke-BddSuiteTeardown -Session $f
        $t.Ran, $t.Failed | Should -Be @($true, $true)
        $t.Message | Should -BeLike '*left a mess*'
        $t.Entry.name | Should -Be 'teardown'
    }

    It 'rule 9: a guarded suite skips unless the run allows it' {
        $s = Open-Suite $script:hooked (New-Context) -Guarded
        Invoke-BddSuiteSetup -Session $s
        $r = (Invoke-One $s 'one').Settled
        $r.status, $r.reason, $r.message | Should -Be @('skipped', 'guard', 'guarded suite: set BDD_SUITE_ALLOW_GUARDED=1 to run it')
        (Invoke-BddSuiteTeardown -Session $s).Ran | Should -BeFalse
        Get-Phases $s | Should -Be @('case one skipped')
        $allowed = Open-Suite $script:hooked (New-Context @{ BDD_SUITE_ALLOW_GUARDED = '1' }) -Guarded
        (Invoke-One $allowed 'one').Settled.status | Should -Be 'passed'
    }

    It 'rule 10: a dry run validates and traces nothing' {
        $s = Open-Suite $script:hooked (New-Context @{ BDD_SUITE_DRY_RUN = '1' })
        Invoke-BddSuiteSetup -Session $s
        (Invoke-One $s 'one').Settled.status | Should -Be 'skipped'
        (Invoke-BddSuiteTeardown -Session $s).Ran | Should -BeFalse
        @($s.Context.trace).Count | Should -Be 0
    }

    It 'a test process reads its options, tags and switches from the environment under the prefix' {
        $context = New-BddSuiteRunContext -SchemaRoot $script:corpusSchema -Extension (Join-Path $PSScriptRoot '../../../samples/workspace/scripts/e2e/Workspace.Extension.psm1') -Environment @{
            BDD_SUITE_OPTION_STORE = 'outlet-7'; BDD_SUITE_TAGS = ' smoke, ,lab '; BDD_SUITE_DRY_RUN = '1'; BDD_SUITE_ALLOW_GUARDED = '1'
            BDD_SUITE_TRACE_FILE = 'out/trace.json'; BDD_SUITE_RECORD_PATH = 'out/record.txt'
        }
        $context.started.Context.store | Should -Be 'outlet-7'
        $context.tagFilter | Should -Be @('smoke', 'lab')
        $context.dryRun, $context.allowGuarded | Should -Be @($true, $true)
        $context.traceFile | Should -Be ([IO.Path]::GetFullPath('out/trace.json'))
        $context.recordPath | Should -Be 'out/record.txt'
        $quiet = New-Context
        @($quiet.tagFilter).Count | Should -Be 0
        $quiet.dryRun, $quiet.allowGuarded, $quiet.traceFile | Should -Be @($false, $false, '')
    }

    It 'a test process refuses a suite that does not lint clean, with its findings' {
        $path = Join-Path $TestDrive 'bad/bad.yml'
        $null = New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force
        Set-Content -LiteralPath $path -Value "suite: s`ntests:`n  - name: one`n    steps: [ { when: it works, action: core.nope } ]`n"
        { Open-BddSuiteSession -Path $path -Shown 'bad.yml' -Context (New-Context) } | Should -Throw '*bad.yml does not lint clean*E104*'
    }

    It 'the Pester glue: a failed case throws, a skipped one says so, a failed teardown throws after writing the trace' {
        $trace = Join-Path $TestDrive 'glue/trace.json'
        $s = Open-Suite "suite: s`nteardown: [ { action: core.fail, message: left a mess } ]`ntests:`n  - name: ok`n    steps: [ { action: core.noop } ]`n  - name: broken`n    steps: [ { action: core.fail, message: broken } ]`n  - name: other`n    tags: [x]`n    steps: [ { action: core.noop } ]`n" (New-Context @{ BDD_SUITE_TRACE_FILE = $trace; BDD_SUITE_TAGS = 'y,' })
        $s.Selected = @($true, $true, $false)
        (Invoke-BddSuiteTest -Session $s -Case 'ok').Skipped | Should -BeFalse
        { Invoke-BddSuiteTest -Session $s -Case 'broken' } | Should -Throw '*broken*'
        $skip = Invoke-BddSuiteTest -Session $s -Case 'other'
        $skip.Skipped, $skip.Message | Should -Be @($true, 'tag filter')
        { Complete-BddSuiteSession -Session $s } | Should -Throw '*The suite teardown of s failed*left a mess*'
        @((Get-Content -LiteralPath $trace -Raw) | ConvertFrom-Json).Count | Should -Be $s.Context.trace.Count
        { Complete-BddSuiteSession -Session $null } | Should -Not -Throw
        Write-BddSuiteTrace -Context (New-Context) -Path (Join-Path $TestDrive 'empty/trace.json')
        Get-Content -LiteralPath (Join-Path $TestDrive 'empty/trace.json') -Raw | Should -Match '^\[\]'
    }

    It 'one run context per schema root and extension list, until it is reset' {
        $one = Get-BddSuiteTestContext -SchemaRoot $script:corpusSchema -Extension $script:corpusExtension
        Get-BddSuiteTestContext -SchemaRoot $script:corpusSchema -Extension $script:corpusExtension | Should -Be $one
        Reset-BddSuiteTestContext
        [object]::ReferenceEquals((Get-BddSuiteTestContext -SchemaRoot $script:corpusSchema -Extension $script:corpusExtension), $one) | Should -BeFalse
        Reset-BddSuiteTestContext
    }
}

BeforeDiscovery {
    # Execute entries the manifest marks pendingIn powershell: each is its own
    # skipped test, never run and never counted as passed (conformance/README.md).
    Import-Module powershell-yaml -ErrorAction Stop
    $discoveryManifest = ConvertFrom-Yaml (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../../conformance/run-manifest.yaml') -Raw) -Ordered
    $script:pendingExecute = @(foreach ($entry in @($discoveryManifest.entries | Where-Object { $_.kind -eq 'execute' })) {
        if (@($entry.pendingIn) -contains 'powershell') { @{ Suite = [string]$entry.suite } }
    })
}

Describe 'E1: every execute entry through the session, in file order and reversed' {
    It 'pending for powershell: <Suite>' -ForEach $script:pendingExecute { Set-ItResult -Skipped -Because 'the manifest marks it pendingIn powershell' }

    It 'emits the expected trace both ways, and the results of the whole-file run' {
        $manifest = ConvertFrom-Yaml (Get-Content -LiteralPath (Join-Path $script:corpusRoot 'run-manifest.yaml') -Raw) -Ordered
        $line = { param($e) (@('phase', 'case', 'step', 'action', 'status', 'reason') | ForEach-Object { [string]$e[$_] }) -join ' | ' }
        $wrong = [Collections.Generic.List[string]]::new()
        $checked = 0
        foreach ($entry in @($manifest.entries | Where-Object { $_.kind -eq 'execute' })) {
            if (@($entry.pendingIn) -contains 'powershell') { continue }
            $file = Join-Path $script:corpusRoot $entry.suite
            $expected = @(((Get-Content -LiteralPath (Join-Path $script:corpusRoot $entry.expectation) -Raw) | ConvertFrom-Json -AsHashtable).trace)
            $environment = @{ BDD_SUITE_TAGS = [string]$entry.tags }
            $param = @(foreach ($name in @(if ($entry.params) { $entry.params.Keys } else { @() })) { "$name=$([string]$entry.params[$name])" })
            $drive = {
                param([bool]$Reversed)
                $context = New-Context $environment
                $context.allowGuarded = $true
                foreach ($pair in $param) { if ($pair -match '^([^=]+)=(.*)$') { $context.commandLineParam[$Matches[1]] = $Matches[2] } }
                $session = Open-BddSuiteSession -Path $file -Context $context -NoLint
                Invoke-BddSuiteSetup -Session $session
                $order = @(0..($session.Cases.Count - 1))
                if ($Reversed) { [Array]::Reverse($order) }
                $results = foreach ($index in $order) {
                    $settled = (Invoke-One $session $index).Settled
                    "$($settled.name)|$($settled.status)|$($settled.message)"
                }
                $null = Invoke-BddSuiteTeardown -Session $session
                Close-StepRunspace $context.stepRunspace
                return @{ Lines = @($context.trace | ForEach-Object { & $line $_ }); Results = @($results) }
            }
            $inOrder = & $drive $false
            $want = @($expected | ForEach-Object { & $line $_ })
            if (($inOrder.Lines -join "`n") -ne ($want -join "`n")) { $wrong.Add("$($entry.suite) (file order):`n$($inOrder.Lines -join "`n")") }
            # The expectation with its per-case groups reversed: setup first, teardown last.
            $setup = @($want | Where-Object { $_ -like 'suite-setup*' }); $teardown = @($want | Where-Object { $_ -like 'suite-teardown*' })
            $groups = [Collections.Generic.List[object]]::new()
            foreach ($e in @($expected | Where-Object { $_.phase -notin @('suite-setup', 'suite-teardown') })) {
                if ($groups.Count -and $groups[$groups.Count - 1].name -eq $e.case) { $groups[$groups.Count - 1].lines.Add((& $line $e)) }
                else { $g = @{ name = $e.case; lines = [Collections.Generic.List[string]]::new() }; $g.lines.Add((& $line $e)); $groups.Add($g) }
            }
            $groups.Reverse()
            $wantReversed = @($setup) + @($groups | ForEach-Object { $_.lines }) + @($teardown)
            $reversed = & $drive $true
            if (($reversed.Lines -join "`n") -ne ($wantReversed -join "`n")) { $wrong.Add("$($entry.suite) (reversed):`n$($reversed.Lines -join "`n")") }
            $whole = Invoke-BddSuite -Path $file -SchemaRoot $script:corpusSchema -Extension $script:corpusExtension -Tags ([string]$entry.tags) -Param $param -ResultsFile '' -Json
            $wholeResults = @($whole.Suites[0].tests | Where-Object { $_.name -ne 'teardown' } | ForEach-Object { "$($_.name)|$($_.status)|$($_.message)" })
            if (($wholeResults -join "`n") -ne ($inOrder.Results -join "`n")) { $wrong.Add("$($entry.suite): results differ from the whole-file run") }
            $checked++
        }
        $checked | Should -Be 14
        $wrong -join "`n`n" | Should -BeNullOrEmpty
    }
}
