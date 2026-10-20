<#
.SYNOPSIS
    The suite session (spec/session.md). Dot-sourced by BddSuite.psm1.

.DESCRIPTION
    One suite file run a phase at a time, so a test framework (Pester) can
    call the suite setup, one case and the teardown when it chooses:

        Open-BddSuiteSession, Invoke-BddSuiteSetup, Invoke-BddSuiteBeforeEach,
        Invoke-BddSuiteCase, Invoke-BddSuiteAfterEach, Invoke-BddSuiteTeardown

    Invoke-BddSuite's whole-file run is these same calls in order, so a Pester
    run and a suiterun run of the same file give the same results and trace.

    A session is a hashtable; the run context it runs in is the hashtable
    Invoke-BddSuite keeps in $script:RunState for a whole-file run, and that
    New-BddSuiteRunContext builds for a test process. Each operation makes its
    session's context the current $script:RunState before it calls the
    runner's step and hook helpers, which read it. PowerShell runs one
    operation at a time, so one case of a session runs at a time (rule 7)
    without a lock; an operation called out of order is refused (rule 1).

    The operations return results and never throw for a step: setup and
    beforeEach record a failure and the case reports it (rule 3). Every case
    starts from a deep copy of the setup's bag (rule 5).
#>

$script:GuardedMessage = 'guarded suite: set BDD_SUITE_ALLOW_GUARDED=1 to run it'

# A test process's run contexts, by extension list and schema root, kept for
# the whole Invoke-Pester run (the module stays imported across containers).
$script:TestRunContexts = @{}

function Copy-SuiteBagValue {
    <#
    .SYNOPSIS
        A deep copy of a captured value that keeps each collection's type: a
        hashtable stays a hashtable, an ordered dictionary ordered, a list a
        list, an array an array.
    #>
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [hashtable]) {
        $copy = @{}
        foreach ($key in @($Value.Keys)) { $copy[$key] = Copy-SuiteBagValue $Value[$key] }
        return $copy
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($key in @($Value.Keys)) { $copy[$key] = Copy-SuiteBagValue $Value[$key] }
        return $copy
    }
    if ($Value -is [array]) {
        $items = [object[]]::new($Value.Count)
        for ($i = 0; $i -lt $Value.Count; $i++) { $items[$i] = Copy-SuiteBagValue $Value[$i] }
        return , $items
    }
    if ($Value -is [System.Collections.IList]) {
        $list = [Collections.Generic.List[object]]::new()
        foreach ($item in $Value) { $list.Add((Copy-SuiteBagValue $item)) }
        return , $list
    }
    return $Value
}

function Get-BddSuiteOptionVariable {
    <#
    .SYNOPSIS
        The variable-name part of an option: its flag without dashes, upper
        case, - as _ (zoneName is --zone-name, so ZONE_NAME).
    #>
    param([Parameter(Mandatory)][string]$Name)
    return (ConvertTo-BddSuiteOptionFlag $Name).TrimStart('-').ToUpperInvariant().Replace('-', '_')
}

function New-BddSuiteRunContext {
    <#
    .SYNOPSIS
        What one test process shares (spec/session.md, "run context"): the
        extensions composed and started once, the schema, the tag filter, the
        dry-run flag, whether guarded suites may run, and the trace.
    .DESCRIPTION
        Read from the environment under the extensions' prefix (BDD_SUITE_ by
        default): OPTION_<NAME>, TAGS, DRY_RUN, ALLOW_GUARDED, TRACE_FILE and
        RECORD_PATH. Suite parameters keep coming from PARAM_<NAME>, which the
        runtime already reads. -Environment replaces the process's environment,
        for a test.
    .PARAMETER SchemaRoot
        Where suite.schema.json and actions.catalog.yaml are.
    .PARAMETER Extension
        Extension module paths.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SchemaRoot,
        [string[]]$Extension = @(),
        [string[]]$ActionPath = @(),
        [hashtable]$Environment
    )
    $described = @(foreach ($one in @($Extension)) { if ($one) { Import-SuiteExtension -Path $one } })
    $composite = New-SuiteComposite -Extension $described -ActionPath $ActionPath
    $read = {
        param([string]$Name)
        $key = "$($composite.EnvPrefix)$Name"
        $value = if ($Environment) { $Environment[$key] } else { [Environment]::GetEnvironmentVariable($key) }
        return $(if ($null -eq $value) { '' } else { ([string]$value).Trim() })
    }
    $option = @{}
    foreach ($o in @($composite.Options)) {
        $given = & $read "OPTION_$(Get-BddSuiteOptionVariable -Name $o.Name)"
        if ($given) { $option[$o.Name] = $given }
    }
    $roots = Resolve-SuiteRoot -SchemaRoot $SchemaRoot
    $traceFile = & $read 'TRACE_FILE'
    return @{
        quiet             = $true
        started           = Start-SuiteExtension -Composite $composite -Option $option
        composite         = $composite
        schema            = Import-SuiteSchema -SchemaRoot $roots.schemaRoot -Force
        schemaRoot        = $roots.schemaRoot
        repositoryRoot    = $roots.root
        stepRunspace      = $null
        stopFile          = ''
        recordPath        = & $read 'RECORD_PATH'
        currentSuite      = ''
        currentSuiteModel = $null
        dryRun            = ((& $read 'DRY_RUN') -eq '1')
        tagFilter         = @((& $read 'TAGS') -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        commandLineParam  = @{}
        allowGuarded      = ((& $read 'ALLOW_GUARDED') -eq '1')
        traceFile         = $(if ($traceFile) { [IO.Path]::GetFullPath($traceFile) } else { '' })
        trace             = [Collections.Generic.List[object]]::new()
        suiteTimings      = [Collections.Generic.List[object]]::new()
        stepTimings       = [Collections.Generic.List[object]]::new()
    }
}

function Get-BddSuiteTestContext {
    <#
    .SYNOPSIS
        This test process's run context for an extension list and schema
        root: built from the environment the first time, then the same one for
        every container of the run (DEC-T08).
    .DESCRIPTION
        A generated Pester file calls it in its BeforeAll. The module stays
        imported across Invoke-Pester's containers, so the extensions start
        once per run; Reset-BddSuiteTestContext forgets the contexts, for a
        second run in the same session.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$SchemaRoot, [string[]]$Extension = @())
    $key = (@([IO.Path]::GetFullPath($SchemaRoot)) + @($Extension | ForEach-Object { [IO.Path]::GetFullPath($_) })) -join "`n"
    if (-not $script:TestRunContexts.ContainsKey($key)) {
        $script:TestRunContexts[$key] = New-BddSuiteRunContext -SchemaRoot $SchemaRoot -Extension $Extension
    }
    return $script:TestRunContexts[$key]
}

function Reset-BddSuiteTestContext {
    <#
    .SYNOPSIS
        Forget this process's test run contexts, closing their step
        runspaces: what a driver calls after Invoke-Pester (T0).
    #>
    [CmdletBinding()]
    param()
    foreach ($context in @($script:TestRunContexts.Values)) { Close-StepRunspace $context.stepRunspace }
    $script:TestRunContexts = @{}
}

function Write-BddSuiteTrace {
    <#
    .SYNOPSIS
        Write a run context's trace, every entry so far, to its trace file (or
        -Path). An array even when the run did one thing, and [] when none.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Context, [string]$Path)
    $target = if ($Path) { $Path } else { [string]$Context.traceFile }
    if (-not $target) { return }
    $folder = Split-Path $target -Parent
    if ($folder -and -not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
    $json = if ($Context.trace.Count) { ConvertTo-Json -InputObject @($Context.trace.ToArray()) -Depth 6 } else { '[]' }
    Set-Content -LiteralPath $target -Value $json
}

function Enter-BddSuiteSession {
    # The session's context is the run the helpers read; its suite is the current one.
    param([hashtable]$Session)
    $script:RunState = $Session.Context
    $script:RunState.currentSuite = [string]$Session.Name
    $script:RunState.currentSuiteModel = $Session.Model
}

function Open-BddSuiteSession {
    <#
    .SYNOPSIS
        Open one suite file in a run context: parse it, resolve its imports
        and meta steps, and list its cases with outline rows expanded.
    .DESCRIPTION
        A test process lints the file first and refuses one that does not lint
        clean, with its findings, running nothing. -NoLint is the whole-file
        run's, which has linted every file before any runs.
    .PARAMETER Shown
        The path findings name.
    .PARAMETER Guarded
        The test plan marks the suite guarded (spec/session.md, rule 9).
    .PARAMETER TestName
        Keep one named case (an outline keeps every row), as -TestName does.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][hashtable]$Context,
        [string]$Shown,
        [switch]$Guarded,
        [switch]$NoLint,
        [string]$TestName = ''
    )
    $file = Get-Item -LiteralPath $Path -ErrorAction Stop
    $script:RunState = $Context
    if (-not $NoLint) {
        $findings = @(Invoke-SuiteLintFile -FilePath $file.FullName -Param $Context.commandLineParam -SchemaRoot $Context.schemaRoot `
                -RepositoryRoot $Context.repositoryRoot -Composite $Context.composite)
        $sorted = @(Get-SortedSuiteDiagnostic -Diagnostic $findings | Where-Object { $null -ne $_ })
        if (Test-SuiteDiagnosticFailure -Diagnostic $sorted) {
            $name = if ($Shown) { $Shown } else { $file.Name }
            $lines = @($sorted | ForEach-Object { (Format-SuiteDiagnostic $_) -replace "`r", '' })
            throw "$name does not lint clean, so none of its cases ran:`n$($lines -join "`n")"
        }
    }
    $suite = ConvertFrom-Yaml (Get-Content -LiteralPath $file.FullName -Raw) -Ordered
    if (-not $suite.tests) { throw "Suite $($file.Name) has no tests." }

    # Every meta use site becomes the steps it stands for, before anything
    # runs, so a case only ever sees a flat list and a failure can name which
    # step of which definition broke. Keywords resolve here too. What this
    # file imports is in scope before what it declares itself.
    $library = Import-SuiteLibrary -FilePath $file.FullName -Model $suite
    $metaDefinitions = Get-MetaStepDefinition -Model $suite -Imported $library.metaSteps
    foreach ($hook in @('setup', 'beforeEach', 'afterEach', 'teardown')) {
        if ($suite.$hook) {
            $suite[$hook] = Resolve-SuiteKeyword -Steps (Expand-SuiteStepList -Steps $suite.$hook `
                    -Definitions $metaDefinitions -Where "suite $($file.Name) $hook")
        }
    }
    $suite['tests'] = Expand-SuiteOutline -Cases $suite.tests
    foreach ($case in @($suite.tests)) {
        if ($null -eq $case) { continue }
        foreach ($phase in @('setup', 'steps', 'cleanup')) {
            if ($case.$phase) {
                $case[$phase] = Resolve-SuiteKeyword -Steps (Expand-SuiteStepList -Steps $case.$phase `
                        -Definitions $metaDefinitions -Where "case '$($case.name)' $phase")
            }
        }
    }
    if ($TestName) {
        $selected = @($suite.tests | Where-Object { $_.name -ceq $TestName })
        if (-not $selected.Count) { $selected = @($suite.tests | Where-Object { $_.name.StartsWith("$TestName [", [StringComparison]::Ordinal) }) }
        elseif ($selected.Count -ne 1) { throw "Suite $($file.Name) does not declare exactly one case named '$TestName'." }
        if (-not $selected.Count) { throw "Suite $($file.Name) does not declare exactly one case named '$TestName'." }
        $suite['tests'] = $selected
    }
    $cases = @($suite.tests | Where-Object { $null -ne $_ })
    $suiteTags = @($suite.tags)
    # An imported default is in scope, and a local one replaces it.
    $defaults = @{}
    foreach ($key in @($library.defaults.Keys)) { $defaults[$key] = $library.defaults[$key] }
    foreach ($key in @(if ($suite.defaults) { $suite.defaults.Keys } else { @() })) { $defaults[$key] = $suite.defaults[$key] }
    $selected = @(foreach ($case in $cases) { [bool](Test-TagsMatch (@($case.tags) + $suiteTags) $Context.tagFilter) })
    return @{
        Context        = $Context
        File           = $file.FullName
        FileName       = $file.Name
        Name           = $(if ($suite.suite) { [string]$suite.suite } elseif ($suite.name) { [string]$suite.name } else { [IO.Path]::GetFileNameWithoutExtension($file.Name) })
        Model          = $suite
        Library        = $library
        CaseModels     = $cases
        Cases          = @($cases | ForEach-Object { [string]$_.name })
        Selected       = $selected
        SuiteTags      = $suiteTags
        Defaults       = $defaults
        DefaultTimeout = $(if ($defaults.timeoutSec) { [int]$defaults.timeoutSec } else { 600 })
        Guarded        = [bool]$Guarded
        Bag            = @{}
        SetupRan       = $false
        SetupError     = $null
        HookCtx        = $null
        TornDown       = $false
        AnyFailures    = $false
        States         = @{}
    }
}

function Test-BddSuiteGuardRefused {
    param([hashtable]$Session)
    return ($Session.Guarded -and -not $Session.Context.allowGuarded)
}

function Get-BddSuiteCaseIndex {
    # A case by its exact name, or by its position.
    param([hashtable]$Session, $Case)
    if ($Case -is [int]) {
        if ($Case -lt 0 -or $Case -ge $Session.Cases.Count) { throw "$($Session.Name) has no case number $Case." }
        return $Case
    }
    $index = [Array]::IndexOf([string[]]$Session.Cases, [string]$Case)
    if ($index -lt 0) { throw "$($Session.Name) has no case named '$Case'." }
    return $index
}

function Invoke-BddSuiteSetup {
    <#
    .SYNOPSIS
        Run the suite setup, once (rule 2): only when a case is selected, the
        run is not a dry run and the suite is not a guarded one the context
        refuses. A failure is recorded, never thrown (rule 3).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Session)
    $S = $Session
    Enter-BddSuiteSession $S
    $run = $S.Context
    if ($S.SetupRan -or $run.dryRun -or -not ($S.Selected -contains $true) -or (Test-BddSuiteGuardRefused $S)) { return }
    $S.SetupRan = $true
    if (-not @($S.Model.setup | Where-Object { $null -ne $_ }).Count) { return }
    $S.HookCtx = New-SuiteRunContext -Defaults $S.Defaults -Capture $S.Bag -TimeoutSec $S.DefaultTimeout
    Add-CaseHookContext -Ctx $S.HookCtx -Case $null
    Write-RunHost '  [HOOK] suite setup' DarkCyan
    try {
        Invoke-HookList -Steps $S.Model.setup -Ctx $S.HookCtx -Label 'suite setup' `
            -TimeoutSec (Get-HookLimitSec -Suite $S.Model -Key 'setupTimeoutSec' -Default 300) -Phase 'suite-setup'
        # An extension may still refuse a setup whose steps passed.
        $hookFailure = Get-CaseHookMessage -Name 'AfterSuiteHook' -Values @{ Hook = 'setup'; Ctx = $S.HookCtx }
        if ($hookFailure) { throw $hookFailure }
    } catch {
        $S.SetupError = Protect-SuiteText -Text $_.Exception.Message -Started $run.started
        Write-RunHost "  [FAIL] suite setup: $($S.SetupError)" Red
        $S.AnyFailures = $true
    }
}

function Set-BddSuiteCaseFailure {
    # What a failure does to a case: failed, its reason and its message.
    param([hashtable]$State, [hashtable]$Session, $ErrorRecord)
    $run = $Session.Context
    $State.status = 'failed'
    $State.reason = Get-StepFailureReason -Failure $ErrorRecord.Exception
    $State.msg = Protect-SuiteText -Text $ErrorRecord.Exception.Message -Started $run.started
    $State.details = Protect-SuiteText -Text ($ErrorRecord | Out-String) -Started $run.started
    $Session.AnyFailures = $true
    Write-RunHost "  [FAIL] $($State.name): $($State.msg)" Red
}

function Invoke-BddSuiteBeforeEach {
    <#
    .SYNOPSIS
        Start one case: run the setup if it has not run, build the case's
        context from a deep copy of the setup's bag, and run beforeEach.
    .DESCRIPTION
        A case the tag filter does not select, one an extension skips, every
        case of a guarded suite without the opt-in and every case of a failed
        setup are settled without running. A failure is recorded for
        Invoke-BddSuiteCase to report; this throws only for a case the session
        does not have, one already in progress, or variables that cannot be
        expanded.
    .PARAMETER Case
        The case's exact name, or its position.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Session, [Parameter(Mandatory)]$Case)
    $S = $Session
    Enter-BddSuiteSession $S
    $run = $S.Context
    $index = Get-BddSuiteCaseIndex $S $Case
    if ($S.States.ContainsKey($index) -and $S.States[$index].stage -ne 'settled') {
        throw "Invoke-BddSuiteBeforeEach for '$($S.Cases[$index])' was called twice; call Invoke-BddSuiteAfterEach first."
    }
    $t = $S.CaseModels[$index]
    $state = @{
        name = [string]$t.name; kind = 'run'; stage = 'started'; status = 'passed'; msg = ''; details = ''; stdout = ''; reason = ''
        beforeEachFailed = $false; ctx = $null; caseLimit = 0; cleanupTimeout = 120; setupSec = 0.0; testStart = (Get-Date)
        sw = $null; workWatch = [Diagnostics.Stopwatch]::new(); cleanupWatch = [Diagnostics.Stopwatch]::new()
    }
    $S.States[$index] = $state
    $testTags = @($t.tags) + $S.SuiteTags
    if (-not $S.Selected[$index]) {
        Write-RunHost "  [SKIP] $($t.name) (tags: $($testTags -join ','))" DarkGray
        $state.kind = 'skipped'; $state.status = 'skipped'; $state.msg = 'tag filter'; $state.reason = 'tag'
        return
    }
    # A case an extension's SkipCase hook skips is reported skipped with its
    # sentence, before any of its steps and before a failed suite setup is
    # charged to it.
    $caseSkip = Get-CaseHookSkip -Name 'SkipCase' -Values @{ Case = $t; CaseName = [string]$t.name }
    if ($caseSkip) {
        Write-RunHost "  [SKIP] $($t.name) ($($caseSkip.Message))" DarkGray
        $state.kind = 'skipped'; $state.status = 'skipped'; $state.msg = $caseSkip.Message; $state.reason = $caseSkip.Reason
        return
    }
    if (Test-BddSuiteGuardRefused $S) {
        Write-RunHost "  [SKIP] $($t.name) ($($script:GuardedMessage))" DarkGray
        $state.kind = 'skipped'; $state.status = 'skipped'; $state.msg = $script:GuardedMessage; $state.reason = 'guard'
        return
    }
    Invoke-BddSuiteSetup -Session $S
    Enter-BddSuiteSession $S

    $declaredTimeout = if ($null -ne $t.timeoutSec) { [int]$t.timeoutSec } else { $S.DefaultTimeout }
    $state.caseLimit = Get-SuiteCaseLimitSec -Composite $run.composite -Suite $S.Model -DeclaredSec $declaredTimeout
    $ctx = New-SuiteRunContext -Defaults $S.Defaults -Capture (Copy-SuiteBagValue $S.Bag) -TimeoutSec $declaredTimeout
    $ctx.caseName = [string]$t.name
    $ctx.suiteName = [string]$S.Model.suite
    $ctx.caseLimitSec = $state.caseLimit
    # Read as ${param.<name>}, resolved highest source first.
    $ctx.param = (Resolve-SuiteParameter -Library $S.Library -Model $S.Model -Case $t -CommandLine $run.commandLineParam -EnvPrefix $run.composite.EnvPrefix)
    # The row an outline is running, bound for the whole case.
    $ctx.row = $t.__row
    # What the extensions add to this case's context, before its vars, which may read it.
    Add-CaseHookContext -Ctx $ctx -Case $t
    $ctx.var = [ordered]@{}
    foreach ($source in @($S.Library.vars, $S.Model.vars, $t.vars)) {
        foreach ($name in @(if ($source) { $source.Keys } else { @() })) {
            $ctx.var[$name] = Expand-SuiteExpression -Value $source[$name] -Scope $ctx
        }
    }
    $state.ctx = $ctx
    $state.sw = [Diagnostics.Stopwatch]::StartNew()
    $state.testStart = Get-Date

    # A suite setup that failed leaves no case runnable: every one of them is
    # errored with the setup's message, and none of their steps runs.
    if ($S.SetupError) {
        Write-RunHost "  [ERR ] $($t.name) (suite setup failed)" Red
        $state.kind = 'setup-failed'; $state.status = 'error'; $state.reason = 'suite-setup'; $state.msg = "Suite setup failed: $($S.SetupError)"
        return
    }
    try {
        $requested = if ($t.cleanupTimeoutSec) { [int]$t.cleanupTimeoutSec } elseif ($S.Defaults.cleanupTimeoutSec) { [int]$S.Defaults.cleanupTimeoutSec } else { 120 }
        if ($requested -lt 1 -or $requested -gt 14400) { throw 'cleanupTimeoutSec must be between 1 and 14400 seconds.' }
        $state.cleanupTimeout = $requested
        if (-not @($t.steps).Count) { throw 'Test must contain at least one step.' }
        foreach ($step in @($S.Model.setup) + @($S.Model.beforeEach) + @($t.setup) + @($t.steps) + @($t.cleanup) + @($S.Model.afterEach) + @($S.Model.teardown)) {
            if ($null -ne $step -and -not (Get-SuiteAction -Name ([string]$step.action))) {
                throw "Unknown action: $($step.action). No extension of this runtime registers it."
            }
            # An extension's own check of the step, before anything runs and
            # under a dry run too; what it throws fails the case.
            if ($null -ne $step) { Invoke-CaseHookList -Name 'CheckStep' -Values @{ Step = $step; Case = $t; CaseName = [string]$t.name } }
        }
        if ($run.dryRun) {
            Write-RunHost "  [DRY ] $($t.name)" DarkGray
            $state.kind = 'dry-run'; $state.status = 'skipped'; $state.msg = 'Validated only; live execution pending.'
        } elseif (Test-StopRequested) {
            # A stop asked for before this case starts ends the run here,
            # before anything is planted, rather than after.
            Write-RunHost "  [STOP] $($t.name) not started: the run was cancelled" Yellow
            $state.kind = 'stopped'
            $S.AnyFailures = $true
        } else {
            Write-RunHost "  [RUN ] $($t.name)" White
            try {
                Invoke-HookList -Steps $S.Model.beforeEach -Ctx $ctx -Label 'beforeEach' `
                    -TimeoutSec (Get-HookLimitSec -Suite $S.Model -Key 'beforeEachTimeoutSec' -Default 300) -Phase 'before-each' -CaseName ([string]$t.name)
            } catch {
                $state.beforeEachFailed = $true
                throw
            }
        }
    } catch {
        $state.beforeEachFailed = $true
        Set-BddSuiteCaseFailure -State $state -Session $S -ErrorRecord $_
    }
}

function Get-BddSuiteCaseState {
    # The state of a case beforeEach started and afterEach has not settled; any other order is refused (rule 1).
    param([hashtable]$Session, $Case, [string]$Operation)
    $index = Get-BddSuiteCaseIndex $Session $Case
    $state = $Session.States[$index]
    if (-not $state -or $state.stage -eq 'settled') { throw "$Operation for '$($Session.Cases[$index])' needs Invoke-BddSuiteBeforeEach first." }
    return @{ index = $index; state = $state }
}

function Complete-BddSuiteCaseWork {
    # After the case's work, whatever happened: the extensions hear it ended, and the case's cleanup runs in its own window.
    param([hashtable]$Session, [int]$Index, [hashtable]$State)
    $run = $Session.Context
    $t = $Session.CaseModels[$Index]
    if (-not $State.workWatch.IsRunning -and $State.workWatch.ElapsedTicks -eq 0) { $State.setupSec = $State.sw.Elapsed.TotalSeconds }
    $State.workWatch.Stop()
    Invoke-CaseHookList -Name 'WorkFinished' -Values @{ Ctx = $State.ctx; Case = $t; CaseName = $State.name; Status = $State.status; WorkSec = $State.workWatch.Elapsed.TotalSeconds }
    $State.cleanupWatch.Start()
    # Cleanup may decide what to keep from the complete work verdict.
    $State.ctx.caseWorkStatus = $State.status
    if ($State.kind -ne 'run' -or $run.dryRun) { return }
    # Cleanup gets its own bounded window even after a timeout.
    $State.ctx.deadline = [DateTime]::UtcNow.AddSeconds($State.cleanupTimeout)
    foreach ($step in @($t.cleanup)) {
        if ($null -eq $step) { continue }
        try { $null = Invoke-Step -Step $step -Ctx $State.ctx -Description "cleanup $(Format-StepLabel $step)" -Phase 'case-cleanup' -CaseName $State.name } catch {
            $State.status = 'failed'; $State.reason = 'cleanup'; $Session.AnyFailures = $true
            $cleanupError = Protect-SuiteText -Text $_.Exception.Message -Started $run.started
            $State.msg += " Cleanup failed: $cleanupError"
            Write-RunHost "  [FAIL] $($State.name) cleanup: $cleanupError" Red
        }
    }
}

function ConvertTo-BddSuiteCaseResult {
    # A case's result: the report's fields, and the trace's reason and whether afterEach failed.
    param([hashtable]$State, [bool]$AfterEachFailed = $false)
    $duration = if ($State.sw) { $State.sw.Elapsed.TotalSeconds } else { 0.0 }
    return @{
        name = $State.name; status = $State.status; durationSec = $(if ($State.kind -in @('run', 'dry-run')) { $duration } else { 0.0 })
        startTime = $State.testStart; endTime = $State.testStart.AddSeconds($(if ($State.kind -in @('run', 'dry-run')) { $duration } else { 0.0 }))
        message = $State.msg; details = $State.details; stdout = $State.stdout
        reason = $State.reason; afterEachFailed = $AfterEachFailed; stopped = ($State.kind -eq 'stopped')
    }
}

function Invoke-BddSuiteCase {
    <#
    .SYNOPSIS
        Run the case itself: its setup, steps and case-level asserts, then
        its cleanup, which runs even after a failure. A recorded setup or
        beforeEach failure is reported here as the case's result. The result
        is final only after Invoke-BddSuiteAfterEach.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Session, [Parameter(Mandatory)]$Case)
    $S = $Session
    Enter-BddSuiteSession $S
    $found = Get-BddSuiteCaseState $S $Case 'Invoke-BddSuiteCase'
    $state = $found.state
    if ($state.stage -ne 'started') { throw "Invoke-BddSuiteCase for '$($state.name)' was called twice; call Invoke-BddSuiteBeforeEach again to run it again." }
    $state.stage = 'ran'
    if ($state.kind -in @('run', 'dry-run', 'stopped')) {
        $t = $S.CaseModels[$found.index]
        if ($state.kind -eq 'run' -and -not $state.beforeEachFailed) {
            $ctx = $state.ctx
            try {
                Invoke-HookList -Steps $t.setup -Ctx $ctx -Label 'case setup' `
                    -TimeoutSec (Get-HookLimitSec -Suite $S.Model -Case $t -Key 'setupTimeoutSec' -Default 300) -Phase 'case-setup' -CaseName $state.name
                # The case's own limit starts here, after the hooks, because a
                # hook never draws on it.
                $ctx.deadline = [DateTime]::UtcNow.AddSeconds($state.caseLimit)
                $ctx.caseStartedUtc = [DateTime]::UtcNow
                $state.setupSec = $state.sw.Elapsed.TotalSeconds
                $state.workWatch.Start()
                Invoke-CaseHookList -Name 'WorkStarted' -Values @{ Ctx = $ctx; Case = $t; CaseName = $state.name }
                foreach ($step in @($t.steps)) {
                    # Between steps, so the throw lands where the case's own
                    # cleanup still runs and undoes what the steps so far planted.
                    if (Test-StopRequested) { throw 'The run was cancelled; the case stopped between steps and its cleanup will run.' }
                    $stepOut = Invoke-Step -Step $step -Ctx $ctx -Description (Format-StepLabel $step) -Phase 'step' -CaseName $state.name
                    if ($null -ne $stepOut) { $state.stdout += ((ConvertTo-Json -InputObject $stepOut -Depth 30 -Compress) + [Environment]::NewLine) }
                    # An extension may fail the case after a step that passed; the case's cleanup still runs.
                    $stepFailure = Get-CaseHookMessage -Name 'AfterStep' -Values @{ Step = $step; Ctx = $ctx; Case = $t; CaseName = $state.name }
                    if ($stepFailure) { throw $stepFailure }
                }
                foreach ($a in @($t.asserts)) { Test-Assertion -Assert $a -Ctx $ctx }
                if ($state.workWatch.Elapsed.TotalSeconds -gt $state.caseLimit) { throw (Get-CaseBudgetFailure -ElapsedSec $state.workWatch.Elapsed.TotalSeconds -BudgetSec $state.caseLimit) }
                Write-RunHost "  [PASS] $($state.name)" Green
            } catch {
                Set-BddSuiteCaseFailure -State $state -Session $S -ErrorRecord $_
            }
        }
        Complete-BddSuiteCaseWork -Session $S -Index $found.index -State $state
    }
    return (ConvertTo-BddSuiteCaseResult -State $state)
}

function Invoke-BddSuiteAfterEach {
    <#
    .SYNOPSIS
        Finish one case: run afterEach, settle its result (an afterEach failure
        makes it failed with reason hook), give the extensions their last word,
        and write its case trace entry (rule 4).
    .DESCRIPTION
        Returns the case's result: name, status, message, reason,
        afterEachFailed (whether the framework's per-test cleanup should fail)
        and the report's other fields. A case a stop ended before it started
        returns with stopped set, and is neither reported nor traced.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Session, [Parameter(Mandatory)]$Case)
    $S = $Session
    Enter-BddSuiteSession $S
    $run = $S.Context
    $found = Get-BddSuiteCaseState $S $Case 'Invoke-BddSuiteAfterEach'
    $state = $found.state
    $t = $S.CaseModels[$found.index]
    $afterEachFailed = $false
    if ($state.kind -in @('run', 'dry-run', 'stopped')) {
        if ($state.stage -eq 'started') {
            if ($state.kind -eq 'run' -and $state.status -eq 'passed') {
                # The framework ran beforeEach but never the case. Its cleanup
                # is still owed, and the case did not pass.
                $state.status = 'failed'; $state.reason = 'hook'; $S.AnyFailures = $true
                $state.msg = "The test framework ran this case's beforeEach but not the case itself."
            }
            Complete-BddSuiteCaseWork -Session $S -Index $found.index -State $state
        }
        if ($state.kind -eq 'run' -and -not $run.dryRun) {
            # afterEach runs even when the cleanup threw, because a suite-wide
            # restore still has to happen; its own failure is appended rather
            # than replacing what the case reported.
            try {
                Invoke-HookList -Steps $S.Model.afterEach -Ctx $state.ctx -Label 'afterEach' `
                    -TimeoutSec (Get-HookLimitSec -Suite $S.Model -Key 'afterEachTimeoutSec' -Default 300) -Phase 'after-each' -CaseName $state.name
            } catch {
                $state.status = 'failed'; $state.reason = 'hook'; $S.AnyFailures = $true; $afterEachFailed = $true
                $hookError = Protect-SuiteText -Text $_.Exception.Message -Started $run.started
                $state.msg += " afterEach failed: $hookError"
                Write-RunHost "  [FAIL] $($state.name) afterEach: $hookError" Red
            }
        }
        # After cleanup and afterEach, whatever the case did: what an extension
        # holds open for the case is released with it.
        Invoke-CaseHookList -Name 'CaseFinally' -Values @{ Ctx = $state.ctx; Case = $t; CaseName = $state.name; Status = $state.status }
        $state.stdout = Protect-SuiteText -Text $state.stdout -Started $run.started
        if ($state.kind -eq 'stopped') {
            $state.stage = 'settled'
            return (ConvertTo-BddSuiteCaseResult -State $state)
        }
        $state.sw.Stop()
        $state.cleanupWatch.Stop()
        # The extensions' last word on the case, after its cleanup and
        # afterEach and before its verdict is recorded.
        foreach ($entry in Get-CaseHook -Name 'AfterCase') {
            $answers = Invoke-CaseHook -Entry $entry -Values @{ Ctx = $state.ctx; Case = $t; CaseName = $state.name; Status = $state.status; SuiteCtx = $S.HookCtx }
            foreach ($failure in @($answers)) {
                $failMessage = if ($failure -is [System.Collections.IDictionary]) { [string]$failure.Message } else { [string]$failure }
                if (-not $failMessage) { continue }
                $state.status = 'failed'; $S.AnyFailures = $true
                $state.reason = if ($failure -is [System.Collections.IDictionary] -and $failure.Reason) { [string]$failure.Reason } else { 'hook' }
                $state.msg += ' ' + (Protect-SuiteText -Text $failMessage -Started $run.started)
                if ($failure -is [System.Collections.IDictionary] -and $failure.Line) { Write-RunHost "  [FAIL] $($state.name): $($failure.Line)" Red }
            }
        }
        $run.suiteTimings.Add(@{ suite = $S.Model.suite; case = $state.name; status = $state.status; timeoutSec = $state.caseLimit; workSec = $state.workWatch.Elapsed.TotalSeconds; setupSec = $state.setupSec; cleanupSec = $state.cleanupWatch.Elapsed.TotalSeconds; cleanupTimeoutSec = $state.cleanupTimeout; totalSec = $state.sw.Elapsed.TotalSeconds })
    } elseif ($state.kind -eq 'setup-failed') {
        $run.suiteTimings.Add(@{ suite = $S.Model.suite; case = $state.name; status = 'error'; timeoutSec = $state.caseLimit; workSec = 0.0; setupSec = 0.0; cleanupSec = 0.0; cleanupTimeoutSec = $state.cleanupTimeout; totalSec = 0.0 })
    }
    # The case's own result closes its part of the trace, after every step,
    # cleanup and afterEach that belongs to it. A dry run validates and runs
    # nothing, so it traces nothing either (rule 10).
    if ($state.kind -ne 'dry-run') { Add-SuiteTrace -Phase 'case' -CaseName $state.name -Status $state.status -Reason $state.reason }
    $state.stage = 'settled'
    return (ConvertTo-BddSuiteCaseResult -State $state -AfterEachFailed $afterEachFailed)
}

function Invoke-BddSuiteTeardown {
    <#
    .SYNOPSIS
        Run the suite teardown, once, on the setup's bag, if the setup ran
        (rule 6). Its failure is in the result, never thrown: Ran, Failed,
        Message and Entry (the report's teardown entry).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Session)
    $S = $Session
    Enter-BddSuiteSession $S
    $run = $S.Context
    $outcome = @{ Ran = $false; Failed = $false; Message = ''; Entry = $null }
    if ($S.TornDown -or -not $S.SetupRan) { return $outcome }
    $S.TornDown = $true
    $outcome.Ran = $true
    if (-not @($S.Model.teardown | Where-Object { $null -ne $_ }).Count) { return $outcome }
    # It reads the suite bag, not any case's copy, and its failure is its own
    # entry rather than being charged to the last case that ran.
    if (-not $S.HookCtx) {
        $S.HookCtx = New-SuiteRunContext -Defaults $S.Defaults -Capture $S.Bag -TimeoutSec $S.DefaultTimeout
        Add-CaseHookContext -Ctx $S.HookCtx -Case $null
    }
    Write-RunHost '  [HOOK] suite teardown' DarkCyan
    $teardownStart = Get-Date
    $teardownWatch = [Diagnostics.Stopwatch]::StartNew()
    try {
        Invoke-HookList -Steps $S.Model.teardown -Ctx $S.HookCtx -Label 'suite teardown' `
            -TimeoutSec (Get-HookLimitSec -Suite $S.Model -Key 'teardownTimeoutSec' -Default 300) -Phase 'suite-teardown'
        $hookFailure = Get-CaseHookMessage -Name 'AfterSuiteHook' -Values @{ Hook = 'teardown'; Ctx = $S.HookCtx }
        if ($hookFailure) { throw $hookFailure }
    } catch {
        $teardownError = Protect-SuiteText -Text $_.Exception.Message -Started $run.started
        Write-RunHost "  [FAIL] suite teardown: $teardownError" Red
        $S.AnyFailures = $true
        $teardownWatch.Stop()
        $outcome.Failed = $true
        $outcome.Message = $teardownError
        $outcome.Entry = @{
            name = 'teardown'; status = 'failed'; durationSec = $teardownWatch.Elapsed.TotalSeconds
            startTime = $teardownStart; endTime = $teardownStart.AddSeconds($teardownWatch.Elapsed.TotalSeconds)
            message = $teardownError; details = ''; stdout = ''
        }
    }
    # After the teardown, passed or failed, with the suite hooks' context.
    Invoke-CaseHookList -Name 'AfterTeardown' -Values @{ Ctx = $S.HookCtx }
    return $outcome
}

function Invoke-BddSuiteTest {
    <#
    .SYNOPSIS
        One case as one test of a framework: beforeEach, the case and
        afterEach. Throws the case's message when it did not pass; returns
        @{ Skipped; Message } so the test can mark itself skipped
        (Set-ItResult -Skipped -Because, which only an It may call).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Session, [Parameter(Mandatory)][string]$Case)
    Invoke-BddSuiteBeforeEach -Session $Session -Case $Case
    try {
        $null = Invoke-BddSuiteCase -Session $Session -Case $Case
    } finally {
        $settled = Invoke-BddSuiteAfterEach -Session $Session -Case $Case
    }
    if ($settled.status -in @('failed', 'error')) { throw $settled.message.Trim() }
    return @{ Skipped = ($settled.status -eq 'skipped'); Message = [string]$settled.message }
}

function Complete-BddSuiteSession {
    <#
    .SYNOPSIS
        The end of a suite in a framework: the teardown, then the run
        context's trace written (when it names a file). Throws when the
        teardown failed, so the framework fails its after-all block and not a
        test (rule 6).
    #>
    [CmdletBinding()]
    param([hashtable]$Session)
    if (-not $Session) { return }
    $teardown = Invoke-BddSuiteTeardown -Session $Session
    Write-BddSuiteTrace -Context $Session.Context
    if ($teardown.Failed) { throw "The suite teardown of $($Session.Name) failed: $($teardown.Message)" }
}
