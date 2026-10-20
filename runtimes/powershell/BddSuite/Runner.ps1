<#
.SYNOPSIS
    Invoke-BddSuite: the generic runner. Dot-sourced by BddSuite.psm1.

.DESCRIPTION
    The generic half of os-context's Invoke-LabTestSuite.ps1 (copied at
    os-context 7633e176; HANDOVER.md lists the half that stayed there). It
    reads suites, lints every one before anything runs, executes the selected
    cases with their hooks, bounds every step by cancelling it, and writes a
    report (NUnit 3 or JUnit), a trace and a timings document.

    What a product adds - actions, context keys, options, rules, an
    environment prefix, redaction - comes from extensions (-Extension) and
    action folders (-ActionPath); nothing here names one.

    Exit codes: 0 when every selected case passed, 1 when one failed, 2 when
    the lint refused a suite or the run could not start.
#>

# Per run. Invoke-BddSuite resets them; the helpers below read them.
$script:RunState = $null

function Write-RunHost {
    <#
    .SYNOPSIS
        One line of the run's narration, redacted, unless -Json asked for the
        document alone.
    #>
    param([AllowEmptyString()][string]$Text, [string]$Colour = 'Gray')
    if ($script:RunState -and $script:RunState.quiet) { return }
    $line = if ($script:RunState) { Protect-SuiteText -Text $Text -Started $script:RunState.started } else { $Text }
    Write-Host $line -ForegroundColor $Colour
}

function Resolve-SuitePath {
    <#
    .SYNOPSIS
        The suite files one -Path names: a file, or a glob, relative to the
        current directory.
    #>
    param([string[]]$Pattern)
    $found = [Collections.Generic.List[object]]::new()
    $seen = @{}
    foreach ($one in @($Pattern)) {
        if (-not $one) { continue }
        $absolute = if ([IO.Path]::IsPathRooted($one)) { $one } else { Join-Path (Get-Location).Path $one }
        $items = @(Get-ChildItem -Path $absolute -File -ErrorAction SilentlyContinue)
        if (-not $items.Count) {
            $directory = Split-Path $absolute -Parent
            $leaf = Split-Path $absolute -Leaf
            if ($directory -and (Test-Path -LiteralPath $directory)) { $items = @(Get-ChildItem -LiteralPath $directory -Filter $leaf -File -ErrorAction SilentlyContinue) }
        }
        foreach ($item in @($items | Sort-Object FullName)) {
            if ($seen.ContainsKey($item.FullName)) { continue }
            $seen[$item.FullName] = $true
            $found.Add($item)
        }
    }
    return @($found.ToArray())
}

function Test-TagsMatch {
    param([string[]]$TestTags, [string[]]$Filter)
    if (-not $Filter -or $Filter.Count -eq 0) { return $true }
    foreach ($t in $TestTags) {
        if ($Filter -contains $t) { return $true }
    }
    return $false
}

function Get-StepRunspace {
    <#
    .SYNOPSIS
        The runspace every step runs in, created on first use.
    .DESCRIPTION
        One per run, not one per step: initialising it means importing the
        modules and the action files, which is a fifth of a second that a
        53-step suite should not pay 53 times.
    #>
    if (-not $script:RunState.stepRunspace) {
        $script:RunState.stepRunspace = New-StepRunspace -Load $script:RunState.composite.Load -RunspaceHost $Host
    }
    return $script:RunState.stepRunspace
}

function Reset-StepRunspace {
    <#
    .SYNOPSIS
        Throw away the step runspace, so the next step gets a clean one.
    .DESCRIPTION
        Called after a cancellation. Stopping a pipeline can leave a module
        half-written, and a later step failing for a reason nobody can see is a
        worse outcome than a fifth of a second.
    #>
    if (-not $script:RunState) { return }
    Close-StepRunspace $script:RunState.stepRunspace
    $script:RunState.stepRunspace = $null
}

function Test-StopRequested {
    <#
    .SYNOPSIS
        Whether something has asked this run to stop.
    .DESCRIPTION
        -StopFile names a file that does not exist while the run is wanted. Its
        appearance is the whole signal: no parsing, no content, nothing that can
        half-arrive. It exists for a caller that cannot send the signal a
        terminal uses (a scheduled task has no console). Checked between steps
        and between cases, so a stop always lands where the case's cleanup can
        still undo what it planted.
    #>
    $stopFile = $script:RunState.stopFile
    if (-not $stopFile) { return $false }
    return (Test-Path -LiteralPath $stopFile)
}

function Test-ActionInterruptible {
    <#
    .SYNOPSIS
        Whether the runner can cancel this action, from the catalog. An action
        the catalog does not mark is interruptible.
    #>
    param([string]$Name)
    $schema = $script:RunState.schema
    if ($Name -and $schema.actions.ContainsKey($Name) -and $schema.actions[$Name].Contains('interruptible')) {
        return [bool]$schema.actions[$Name].interruptible
    }
    return $true
}

function Add-SuiteTrace {
    <#
    .SYNOPSIS
        Record one thing the run did, in the order it did it.
    .DESCRIPTION
        Only the fields the conformance contract names are recorded. No
        durations and no messages: a trace the runtimes compare cannot hold a
        number that depends on the machine or a sentence they are free to word
        differently.
    #>
    param(
        [Parameter(Mandatory)][string]$Phase,
        [string]$CaseName,
        [string]$StepLabel,
        [string]$Action,
        [Parameter(Mandatory)][string]$Status,
        [string]$Reason
    )

    $entry = [ordered]@{ phase = $Phase }
    if ($CaseName) { $entry['case'] = $CaseName }
    if ($StepLabel) { $entry['step'] = $StepLabel }
    if ($Action) { $entry['action'] = $Action }
    $entry['status'] = $Status
    if ($Reason) { $entry['reason'] = $Reason }
    $script:RunState.trace.Add($entry)
}

function Get-StepIdentity {
    <#
    .SYNOPSIS
        Which authored step this is, and what it says.
    .DESCRIPTION
        index is the 0-based place of the authored step in its phase's list;
        subIndex is the 0-based place inside a meta expansion and is absent for
        a step that was not expanded from one. keyword and sentence are absent
        when the step has none. Kept out of the conformance trace on purpose.
    #>
    param([hashtable]$Step)
    $identity = [ordered]@{}
    if ($null -ne $Step.__index) { $identity['index'] = [int]$Step.__index }
    if ($null -ne $Step.__subIndex) { $identity['subIndex'] = [int]$Step.__subIndex }
    if ($Step.__keyword -and $Step.__sentence) {
        $identity['keyword'] = [string]$Step.__keyword
        $identity['sentence'] = [string]$Step.__sentence
    }
    return $identity
}

function Write-StepEvent {
    <#
    .SYNOPSIS
        Tell whoever reads the output that a step started or finished.
    .DESCRIPTION
        One line, `[STEP] ` and a JSON object, which a host can parse into a
        step event to mark the running step of a run in flight. JSON rather
        than words, because a sentence may hold anything and a reader must not
        guess where it ends. The line goes through the extensions' redaction
        like every other line the runner prints.
    #>
    param(
        [hashtable]$Step, [string]$Phase, [string]$CaseName, [string]$StepLabel, [string]$Status,
        [double]$DurationSec = -1, [string]$Reason
    )
    $stepEvent = [ordered]@{}
    if ($CaseName) { $stepEvent['case'] = $CaseName }
    $stepEvent['phase'] = $Phase
    $identity = Get-StepIdentity -Step $Step
    foreach ($key in @($identity.Keys)) { $stepEvent[$key] = $identity[$key] }
    if ($StepLabel) { $stepEvent['step'] = $StepLabel }
    $stepEvent['status'] = $Status
    if ($DurationSec -ge 0) { $stepEvent['durationSec'] = [Math]::Round($DurationSec, 3) }
    if ($Reason) { $stepEvent['reason'] = $Reason }
    Write-RunHost ('    [STEP] ' + (ConvertTo-Json -InputObject $stepEvent -Compress -Depth 4)) DarkGray
}

function Add-StepTiming {
    <#
    .SYNOPSIS
        Record how long one step took, and when it started.
    .DESCRIPTION
        Deliberately not part of the trace, which carries no durations because
        a number that depends on the machine cannot be compared between
        runtimes. This rides in the timings document instead (-TimingFile).
    #>
    param(
        [Parameter(Mandatory)][string]$Phase,
        [string]$Suite,
        [string]$CaseName,
        [string]$StepLabel,
        [string]$Action,
        [Parameter(Mandatory)][string]$Status,
        [DateTime]$StartedUtc,
        [double]$DurationSec,
        [string]$Reason,
        [hashtable]$Step
    )
    $entry = [ordered]@{ phase = $Phase }
    if ($Suite) { $entry['suite'] = $Suite }
    if ($CaseName) { $entry['case'] = $CaseName }
    if ($Step) {
        $identity = Get-StepIdentity -Step $Step
        foreach ($key in @($identity.Keys)) { $entry[$key] = $identity[$key] }
    }
    if ($StepLabel) { $entry['step'] = $StepLabel }
    if ($Action) { $entry['action'] = $Action }
    $entry['status'] = $Status
    $entry['startedUtc'] = $StartedUtc.ToString('o')
    $entry['durationSec'] = [Math]::Round($DurationSec, 3)
    if ($Reason) { $entry['reason'] = $Reason }
    $script:RunState.stepTimings.Add($entry)
}

function Get-CaseHook {
    <#
    .SYNOPSIS
        The hooks of one name across this run's extensions, in -Extension
        order, each @{ Owner; Keys; Hook }.
    #>
    param([Parameter(Mandatory)][string]$Name)
    if (-not $script:RunState -or -not $script:RunState.composite -or -not $script:RunState.composite.CaseHooks) { return @() }
    return @($script:RunState.composite.CaseHooks[$Name] | Where-Object { $null -ne $_ })
}

function Invoke-CaseHook {
    <#
    .SYNOPSIS
        Call one extension's case hook with $In: what the call site gives, and
        what every hook gets (State, Suite, SuiteName, DryRun).
    .DESCRIPTION
        State is the hook's own extension's, as Start returned it. Returns what
        the hook wrote, as an array, with nulls and empty strings left out.
    #>
    param([Parameter(Mandatory)][hashtable]$Entry, [hashtable]$Values = @{})
    $run = $script:RunState
    $in = @{
        State     = $(if ($run.started -and $run.started.States) { $run.started.States[$Entry.Owner] } else { $null })
        Suite     = $run.currentSuiteModel
        SuiteName = $run.currentSuite
        DryRun    = [bool]$run.dryRun
    }
    foreach ($key in @($Values.Keys)) { $in[$key] = $Values[$key] }
    return @(& $Entry.Hook $in | Where-Object { $null -ne $_ -and -not ($_ -is [string] -and $_ -eq '') })
}

function Get-CaseHookSkip {
    <#
    .SYNOPSIS
        Whether an extension skips a case or a step (SkipCase, SkipStep), and
        why: @{ Message; Reason }, or nothing when every hook lets it run.
    .DESCRIPTION
        A hook answers nothing to let it run, a sentence to skip it (the trace
        reason is then not-applicable), or @{ Message; Reason } to name the
        reason as well. The first extension that skips decides; later ones are
        not asked.
    #>
    param([Parameter(Mandatory)][string]$Name, [hashtable]$Values = @{})
    foreach ($entry in Get-CaseHook -Name $Name) {
        foreach ($answer in Invoke-CaseHook -Entry $entry -Values $Values) {
            if ($answer -is [System.Collections.IDictionary]) {
                if (-not $answer.Message) { continue }
                return @{ Message = [string]$answer.Message; Reason = $(if ($answer.Reason) { [string]$answer.Reason } else { 'not-applicable' }) }
            }
            return @{ Message = [string]$answer; Reason = 'not-applicable' }
        }
    }
    return $null
}

function Get-CaseHookMessage {
    <#
    .SYNOPSIS
        The first sentence any extension's hook of this name answers
        (AfterStep, AfterSuiteHook): why the case or the hook must fail.
    #>
    param([Parameter(Mandatory)][string]$Name, [hashtable]$Values = @{})
    foreach ($entry in Get-CaseHook -Name $Name) {
        foreach ($answer in Invoke-CaseHook -Entry $entry -Values $Values) { return [string]$answer }
    }
    return $null
}

function Invoke-CaseHookList {
    <#
    .SYNOPSIS
        Call every extension's hook of this name for what it does (WorkStarted,
        WorkFinished, CaseFinally, AfterTeardown, CheckStep), discarding its
        answers. What a hook throws reaches the caller.
    #>
    param([Parameter(Mandatory)][string]$Name, [hashtable]$Values = @{})
    foreach ($entry in Get-CaseHook -Name $Name) { $null = Invoke-CaseHook -Entry $entry -Values $Values }
}

function Add-CaseHookContext {
    <#
    .SYNOPSIS
        Every CaseContext hook's values for one case's context, or for a suite
        hook context (no case).
    .DESCRIPTION
        A hook returns a hashtable; of it, only the extension's own context
        keys are taken, in -Extension order, so a case-level field can
        override what Start or the suite's defaults gave. A hook may also add
        fields of its own to $In.Ctx, which an action reads as $Ctx.<field>.
    #>
    param([Parameter(Mandatory)][hashtable]$Ctx, $Case)
    foreach ($entry in Get-CaseHook -Name 'CaseContext') {
        $answers = @(Invoke-CaseHook -Entry $entry -Values @{ Ctx = $Ctx; Case = $Case; CaseName = $(if ($Case) { [string]$Case.name } else { '' }) })
        $values = @($answers | Where-Object { $_ -is [System.Collections.IDictionary] }) | Select-Object -Last 1
        if (-not $values) { continue }
        foreach ($key in @($values.Keys)) {
            if (@($entry.Keys) -ccontains [string]$key) { $Ctx[[string]$key] = $values[$key] }
        }
    }
}

function Get-CaseBudgetFailure {
    <#
    .SYNOPSIS
        Why a case ran out of its limit: the limit and the time it had taken.
    #>
    param([double]$ElapsedSec, [int]$BudgetSec)
    return (New-StepFailure -Message ('Case exceeded its {0}s budget after {1:F1}s.' -f $BudgetSec, $ElapsedSec) -Reason 'timeout')
}

function Invoke-Step {
    <#
    .SYNOPSIS
        Run one step of this suite, bounded by what remains of its deadline.
    .DESCRIPTION
        Every step the runner drives goes through here, so the limit is
        enforced by cancelling work rather than by checking a clock between
        steps.
    #>
    param([hashtable]$Step, [hashtable]$Ctx, [string]$Description, [string]$Phase = 'step', [string]$CaseName)

    if (-not $Description) { $Description = "step $($Step.action)" }
    $label = Format-StepLabel $Step
    $action = [string]$Step.action
    $stepStartedUtc = [DateTime]::UtcNow
    $stepWatch = [Diagnostics.Stopwatch]::StartNew()
    $suiteName = $script:RunState.currentSuite
    # A step an extension's SkipStep hook skips is not run, and the case goes
    # on. The trace takes the reason's category, as a case's skip does; the
    # timings and the step event take the sentence.
    $skip = Get-CaseHookSkip -Name 'SkipStep' -Values @{ Step = $Step; Ctx = $Ctx; Phase = $Phase; CaseName = $CaseName }
    if ($skip) {
        Add-SuiteTrace -Phase $Phase -CaseName $CaseName -StepLabel $label -Action $action -Status 'skipped' -Reason $skip.Reason
        $stepWatch.Stop()
        Add-StepTiming -Phase $Phase -Suite $suiteName -CaseName $CaseName -StepLabel $label -Action $action `
            -Status 'skipped' -StartedUtc $stepStartedUtc -DurationSec $stepWatch.Elapsed.TotalSeconds -Reason $skip.Message -Step $Step
        Write-StepEvent -Step $Step -Phase $Phase -CaseName $CaseName -StepLabel $label -Status 'skipped' `
            -DurationSec $stepWatch.Elapsed.TotalSeconds -Reason $skip.Message
        return $null
    }
    # A guard that does not hold is recorded here rather than left to
    # Invoke-SuiteStep, because a step that did not run and a step that ran and
    # returned nothing look the same to the caller and are not the same thing in
    # a trace.
    if ($Step.ifCapture -and -not (Test-SuiteCapturePath $Ctx.capture ([string]$Step.ifCapture))) {
        Add-SuiteTrace -Phase $Phase -CaseName $CaseName -StepLabel $label -Action $action -Status 'skipped' -Reason 'guard'
        $stepWatch.Stop()
        Add-StepTiming -Phase $Phase -Suite $suiteName -CaseName $CaseName -StepLabel $label -Action $action `
            -Status 'skipped' -StartedUtc $stepStartedUtc -DurationSec $stepWatch.Elapsed.TotalSeconds -Reason 'guard' -Step $Step
        Write-StepEvent -Step $Step -Phase $Phase -CaseName $CaseName -StepLabel $label -Status 'skipped' `
            -DurationSec $stepWatch.Elapsed.TotalSeconds -Reason 'guard'
        return $null
    }
    Write-StepEvent -Step $Step -Phase $Phase -CaseName $CaseName -StepLabel $label -Status 'running'
    # Which number bounded this step decides what a timeout says. A step that
    # ran out of its own limit reports that limit; a step that ran out of the
    # case's reports the case's budget.
    $ownLimit = [int]$Step.timeoutSec
    $remaining = Get-StepLimitSec -Deadline $Ctx.deadline
    $boundedByCase = ($ownLimit -le 0 -or $ownLimit -ge $remaining)
    # The steps a wait polls, each recorded ahead of the wait itself (Wait.ps1).
    $nested = [Collections.Generic.List[object]]::new()
    $Ctx.__nested = $nested
    try {
        try {
            $result = Invoke-SuiteStep -Step $Step -Ctx $Ctx -Runspace (Get-StepRunspace) -Deadline $Ctx.deadline `
                -Interruptible (Test-ActionInterruptible -Name ([string]$Step.action)) -Description $Description
        } finally {
            $Ctx.Remove('__nested')
            foreach ($poll in @($nested.ToArray())) {
                Add-SuiteTrace -Phase $Phase -CaseName $CaseName -StepLabel (Format-StepLabel $poll.step) -Action ([string]$poll.step.action) `
                    -Status $poll.status -Reason $poll.reason
            }
        }
        Add-SuiteTrace -Phase $Phase -CaseName $CaseName -StepLabel $label -Action $action -Status 'passed'
        $stepWatch.Stop()
        Add-StepTiming -Phase $Phase -Suite $suiteName -CaseName $CaseName -StepLabel $label -Action $action `
            -Status 'passed' -StartedUtc $stepStartedUtc -DurationSec $stepWatch.Elapsed.TotalSeconds -Step $Step
        Write-StepEvent -Step $Step -Phase $Phase -CaseName $CaseName -StepLabel $label -Status 'passed' `
            -DurationSec $stepWatch.Elapsed.TotalSeconds
        return $result
    } catch {
        $message = $_.Exception.Message
        $reason = Get-StepFailureReason -Failure $_.Exception
        Add-SuiteTrace -Phase $Phase -CaseName $CaseName -StepLabel $label -Action $action -Status 'failed' -Reason $reason
        $stepWatch.Stop()
        Add-StepTiming -Phase $Phase -Suite $suiteName -CaseName $CaseName -StepLabel $label -Action $action `
            -Status 'failed' -StartedUtc $stepStartedUtc -DurationSec $stepWatch.Elapsed.TotalSeconds -Reason $reason -Step $Step
        Write-StepEvent -Step $Step -Phase $Phase -CaseName $CaseName -StepLabel $label -Status 'failed' `
            -DurationSec $stepWatch.Elapsed.TotalSeconds -Reason $reason
        if ($message -match 'exceeded its \d+s limit') {
            Reset-StepRunspace
            if ($boundedByCase -and $Ctx.caseStartedUtc) {
                throw (Get-CaseBudgetFailure -ElapsedSec ([DateTime]::UtcNow - $Ctx.caseStartedUtc).TotalSeconds -BudgetSec ([int]$Ctx.caseLimitSec))
            }
        }
        # The step says where it came from. Without this a failure inside a
        # meta step reads as whatever the action said and names no step anybody
        # can find in the file. A timeout already names itself, so it is not
        # prefixed twice. Rebuilt rather than re-worded in place, so that the
        # category travels with the message.
        if (-not $message.StartsWith($Description)) {
            throw (New-StepFailure -Message "${Description}: $message" -Reason $reason)
        }
        throw
    }
}

function New-SuiteRunContext {
    <#
    .SYNOPSIS
        The context a case or a suite hook runs in.
    .DESCRIPTION
        Every extension context key reads the value its extension's Start gave
        for this run; failing that, the suite's defaults entry of that name;
        failing both, ''. ${...} may start at the core's roots and those keys
        (__roots); each action sees its own extension's State (__states).
    #>
    param([hashtable]$Defaults, [hashtable]$Capture, [int]$TimeoutSec)
    $context = @{
        timeoutSec = $TimeoutSec
        defaults   = $Defaults
        capture    = $Capture
        recordPath = $script:RunState.recordPath
        __roots    = @($script:RunState.composite.Roots)
        __states   = $script:RunState.started.States
    }
    foreach ($key in @($script:RunState.composite.ContextKeys)) {
        if ($script:RunState.started.Context.ContainsKey($key)) { $context[$key] = $script:RunState.started.Context[$key] }
        elseif ($Defaults -and $Defaults.ContainsKey($key)) { $context[$key] = $Defaults[$key] }
        else { $context[$key] = '' }
    }
    return $context
}

function Get-HookLimitSec {
    <#
    .SYNOPSIS
        The window a hook block gets, from its own key.
    .DESCRIPTION
        A hook never draws on a case's limit: an eight-second case that exists to
        prove a limit fires still has to afford its own setup.
    #>
    param($Suite, $Case, [string]$Key, [int]$Default)
    $value = if ($Case -and $null -ne $Case.$Key) { $Case.$Key }
    elseif ($null -ne $Suite.$Key) { $Suite.$Key }
    elseif ($Suite.defaults -and $null -ne $Suite.defaults.$Key) { $Suite.defaults.$Key }
    else { $Default }
    return [int]$value
}

function Invoke-HookList {
    <#
    .SYNOPSIS
        Run one hook block inside its own window, naming what failed.
    .DESCRIPTION
        A hook is a list of ordinary steps, so it runs through the same
        Invoke-Step as a case's steps; what differs is the bound it gets and the
        attribution when it fails. The category is the hook rather than
        whatever the action was doing.
    #>
    param([object]$Steps, [hashtable]$Ctx, [int]$TimeoutSec, [string]$Label, [string]$Phase, [string]$CaseName)

    $list = @($Steps | Where-Object { $null -ne $_ })
    if (-not $list.Count) { return }
    $Ctx.deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    foreach ($step in $list) {
        try {
            $null = Invoke-Step -Step $step -Ctx $Ctx -Description "$Label $(Format-StepLabel $step)" `
                -Phase $(if ($Phase) { $Phase } else { 'step' }) -CaseName $CaseName
        } catch {
            throw (New-StepFailure -Message $_.Exception.Message -Reason 'hook')
        }
    }
}

function Invoke-BddSuite {
    <#
    .SYNOPSIS
        Lint and run BDD suites, with the extensions given.
    .DESCRIPTION
        Every selected suite is linted first; a run continues only when the
        lint is clean. Returns an object: ExitCode (0 passed, 1 a case failed,
        2 the lint refused or the run could not start), Diagnostics, Suites
        (each case's result), Trace and Error. Narration goes to the host, and
        -Json silences it so a caller can print the diagnostics alone
        (Invoke-BddSuite.ps1 does).
    .PARAMETER Path
        Suite files or globs, relative to the current directory.
    .PARAMETER Tags
        Comma-separated tag filter. A case runs if it or its suite has one of
        them, or if -Tags is empty.
    .PARAMETER TestName
        Run exactly one named case of one suite, with its setup and cleanup. An
        outline case runs every one of its rows. A missing case is an error.
    .PARAMETER ResultsFile
        Where the report is written; empty writes none.
    .PARAMETER ReportFormat
        NUnit3 (the default) or JUnit.
    .PARAMETER DryRun
        Lint, and check every step names a registered action; run nothing.
    .PARAMETER Lint
        Lint and stop. Exit 0 when clean, 2 on any error (or warning, -Strict).
    .PARAMETER Strict
        A warning fails the lint.
    .PARAMETER Json
        Print nothing; the caller prints the Diagnostics as diagnostic.schema.json says.
    .PARAMETER Param
        name=value, repeatable: the highest of the sources a parameter takes a
        value from. A name the suite does not declare is E210.
    .PARAMETER TraceFile
        Where the ordered trace is written (what the conformance corpus compares).
    .PARAMETER TimingFile
        Where real timings are written, beside the deterministic trace.
    .PARAMETER StopFile
        A file whose appearance asks the run to stop, between steps or cases.
    .PARAMETER SchemaRoot
        Where suite.schema.json and actions.catalog.yaml are, used as given.
        Without it the workspace root is found by walking up to test/e2e/schema.
    .PARAMETER ActionPath
        Folders (or files) of action .ps1 files, each calling Register-SuiteAction.
    .PARAMETER Extension
        Extension module paths (README.md).
    .PARAMETER Option
        The values of the extensions' options, by name: @{ region = 'eu' }.
    .PARAMETER Binding
        The binding a -BindingCheck lint holds the suites to.
    .PARAMETER BindingCheck
        Report E201 for an action the binding does not implement.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$Path,
        [string]$Tags = '',
        [string]$TestName = '',
        [string]$ResultsFile = 'test-results.xml',
        [ValidateSet('NUnit3', 'JUnit')][string]$ReportFormat = 'NUnit3',
        [switch]$DryRun,
        [switch]$Lint,
        [switch]$Strict,
        [switch]$Json,
        [string[]]$Param = @(),
        [string]$TraceFile = '',
        [string]$TimingFile = '',
        [string]$StopFile = '',
        [string]$SchemaRoot,
        [string[]]$ActionPath = @(),
        [string[]]$Extension = @(),
        [hashtable]$Option = @{},
        [ValidatePattern('^[a-z][a-z0-9]*$')][string]$Binding = 'powershell',
        [switch]$BindingCheck
    )

    $outcome = [pscustomobject]@{ ExitCode = 2; Diagnostics = @(); Suites = @(); Trace = @(); Error = $null }
    $script:RunState = @{
        quiet        = [bool]$Json
        started      = $null
        composite    = $null
        schema       = $null
        stepRunspace = $null
        stopFile     = $StopFile
        recordPath   = ''
        currentSuite = ''
        # The suite being run, and whether the run only validates, for the
        # extensions' case hooks ($In.Suite, $In.DryRun).
        currentSuiteModel = $null
        dryRun       = [bool]$DryRun
        trace        = [Collections.Generic.List[object]]::new()
        suiteTimings = [Collections.Generic.List[object]]::new()
        stepTimings  = [Collections.Generic.List[object]]::new()
    }
    try {
        # The last value is the exit code; anything an action file printed while
        # it loaded is ahead of it and is not one.
        $codes = @(Invoke-BddSuiteRun @PSBoundParameters -Outcome $outcome)
        $outcome.ExitCode = [int]$codes[-1]
    } catch {
        $message = Protect-SuiteText -Text $_.Exception.Message -Started $script:RunState.started
        $outcome.Error = $message
        $outcome.ExitCode = 2
        if (-not $Json) { Write-Host "[HARNESS ERROR] $message" -ForegroundColor Red }
    } finally {
        Reset-StepRunspace
        $outcome.Trace = @($script:RunState.trace.ToArray())
    }
    return $outcome
}

function Invoke-BddSuiteRun {
    # The body of Invoke-BddSuite, which turns anything it throws into exit 2.
    [CmdletBinding()]
    param(
        [string[]]$Path, [string]$Tags = '', [string]$TestName = '', [string]$ResultsFile = 'test-results.xml',
        [string]$ReportFormat = 'NUnit3', [switch]$DryRun, [switch]$Lint, [switch]$Strict, [switch]$Json,
        [string[]]$Param = @(), [string]$TraceFile = '', [string]$TimingFile = '', [string]$StopFile = '',
        [string]$SchemaRoot, [string[]]$ActionPath = @(), [string[]]$Extension = @(), [hashtable]$Option = @{},
        [string]$Binding = 'powershell', [switch]$BindingCheck, [Parameter(Mandatory)]$Outcome
    )

    $run = $script:RunState
    $runStartedUtc = [DateTime]::UtcNow

    # The extensions, composed and checked before anything is read.
    $described = @(foreach ($one in @($Extension)) { if ($one) { Import-SuiteExtension -Path $one } })
    $composite = New-SuiteComposite -Extension $described -ActionPath $ActionPath
    $run.composite = $composite
    # Options are refused before the lint: a value nobody reads is a mistake
    # whichever suite it was meant for.
    foreach ($name in @($Option.Keys)) {
        if (-not @($composite.Options | Where-Object { $_.Name -eq [string]$name }).Count) {
            throw "Invoke-BddSuite does not take the option ${name}: no extension of this run declares it."
        }
    }

    $roots = Resolve-SuiteRoot -SchemaRoot $SchemaRoot
    $run.schema = Import-SuiteSchema -SchemaRoot $roots.schemaRoot -Force

    $tagFilter = @()
    if ($Tags) { $tagFilter = @($Tags -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }

    $suiteFiles = @(Resolve-SuitePath -Pattern $Path)
    if (-not $suiteFiles.Count) { throw "No suite files matched $($Path -join ', ')" }
    Write-RunHost ('Found {0} suite file(s):' -f $suiteFiles.Count) Cyan
    foreach ($file in $suiteFiles) { Write-RunHost "  $($file.FullName)" Gray }

    # Every selected suite is validated before anything executes, so a
    # misspelled keyword or an unresolved reference costs a second rather than a
    # run. -Lint stops here; a run continues only when the lint is clean.
    $commandLineParam = @{}
    foreach ($pair in @($Param)) {
        if ($pair -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { throw "-Param takes name=value; got '$pair'." }
        $commandLineParam[$Matches[1]] = $Matches[2]
    }
    $lintFindings = [Collections.Generic.List[object]]::new()
    foreach ($suiteFile in $suiteFiles) {
        foreach ($finding in Invoke-SuiteLintFile -FilePath $suiteFile.FullName -Param $commandLineParam -SchemaRoot $roots.schemaRoot `
                -RepositoryRoot $roots.root -Composite $composite -Binding $Binding -BindingCheck:$BindingCheck) {
            $lintFindings.Add($finding)
        }
    }
    $sorted = @(Get-SortedSuiteDiagnostic -Diagnostic $lintFindings.ToArray() | Where-Object { $null -ne $_ })
    $Outcome.Diagnostics = $sorted
    foreach ($finding in $sorted) {
        Write-RunHost (Format-SuiteDiagnostic $finding) $(if ($finding.severity -eq 'warning') { 'Yellow' } else { 'Red' })
    }
    if (Test-SuiteDiagnosticFailure -Diagnostic $sorted -Strict:$Strict) {
        $errorCount = @($sorted | Where-Object { $_.severity -eq 'error' }).Count
        Write-RunHost ('Lint found {0} error(s) and {1} warning(s). Nothing was executed.' -f $errorCount, ($sorted.Count - $errorCount)) Red
        return 2
    }
    if ($Lint) {
        Write-RunHost ('Lint clean: {0} suite file(s), {1} warning(s).' -f $suiteFiles.Count, $sorted.Count) Green
        return 0
    }

    # Once per run, shared by every file, so an extension's state persists
    # across files.
    $run.started = Start-SuiteExtension -Composite $composite -Option $Option
    $run.recordPath = [string][Environment]::GetEnvironmentVariable("$($composite.EnvPrefix)RECORD_PATH")

    $results = [Collections.Generic.List[hashtable]]::new()
    $anyFailures = $false
    if ($TestName -and $suiteFiles.Count -ne 1) { throw '-TestName requires exactly one suite file.' }
    # What the session reads from the run (Session.ps1): suiterun runs guarded
    # suites, and the command line's tags and parameters.
    $run.tagFilter = $tagFilter
    $run.commandLineParam = $commandLineParam
    $run.allowGuarded = $true
    $run.schemaRoot = $roots.schemaRoot
    $run.repositoryRoot = $roots.root

    # Each file through a session, its operations in order (spec/session.md),
    # so a Pester run and this run of a file give the same results and trace.
    foreach ($f in $suiteFiles) {
        Write-RunHost "`n=== Suite: $($f.Name) ===" Cyan
        $session = Open-BddSuiteSession -Path $f.FullName -Context $run -NoLint -TestName $TestName
        $suiteResult = @{
            name  = $session.Name
            file  = $f.FullName
            tests = [Collections.Generic.List[hashtable]]::new()
        }
        Invoke-BddSuiteSetup -Session $session
        for ($index = 0; $index -lt $session.Cases.Count; $index++) {
            Invoke-BddSuiteBeforeEach -Session $session -Case $index
            $null = Invoke-BddSuiteCase -Session $session -Case $index
            $settled = Invoke-BddSuiteAfterEach -Session $session -Case $index
            # A stop asked for before a case started ends the file's cases there.
            if ($settled.stopped) { break }
            $suiteResult.tests.Add($settled)
        }
        # The teardown runs after the last case whether cases passed, and
        # whether the setup did: state a failed setup half-built still has to
        # be released.
        $teardown = Invoke-BddSuiteTeardown -Session $session
        if ($teardown.Failed) { $suiteResult.tests.Add($teardown.Entry) }
        if ($session.AnyFailures) { $anyFailures = $true }
        $results.Add($suiteResult)
    }
    $Outcome.Suites = @($results.ToArray())

    # An empty -ResultsFile writes no report (the command line's run without
    # --results, as every program's suiterun).
    $absResultsFile = ''
    if ($ResultsFile) {
        $doc = if ($ReportFormat -eq 'JUnit') { New-JUnitXml -Suites $results } else { New-NUnit3Xml -Suites $results }
        $absResultsFile = if ([IO.Path]::IsPathRooted($ResultsFile)) { $ResultsFile } else { Join-Path (Get-Location).Path $ResultsFile }
        $resultsDir = Split-Path $absResultsFile -Parent
        if ($resultsDir -and -not (Test-Path -LiteralPath $resultsDir)) { New-Item -ItemType Directory -Path $resultsDir -Force | Out-Null }
        $doc.Save($absResultsFile)
    }

    if ($TraceFile) {
        # An array even when the run did one thing, and empty rather than absent
        # when it did none.
        $traceDir = Split-Path $TraceFile -Parent
        if ($traceDir -and -not (Test-Path -LiteralPath $traceDir)) { New-Item -ItemType Directory -Path $traceDir -Force | Out-Null }
        $traceJson = ConvertTo-Json -InputObject @($run.trace.ToArray()) -Depth 6
        if ($run.trace.Count -eq 0) { $traceJson = '[]' }
        Set-Content -LiteralPath $TraceFile -Value $traceJson
        Write-RunHost "Trace written to $TraceFile" Cyan
    }

    Reset-StepRunspace
    if ($TimingFile) {
        $timingDir = Split-Path $TimingFile -Parent
        if ($timingDir -and -not (Test-Path -LiteralPath $timingDir)) { New-Item -ItemType Directory -Path $timingDir -Force | Out-Null }
        @{
            schema       = 'bdd.suite.timings.v1'
            reportSha256 = $(if ($absResultsFile) { (Get-FileHash -LiteralPath $absResultsFile).Hash } else { '' })
            startedUtc   = $runStartedUtc.ToString('o')
            finishedUtc  = [DateTime]::UtcNow.ToString('o')
            cases        = @($run.suiteTimings.ToArray())
            steps        = @($run.stepTimings.ToArray())
        } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $TimingFile
    }
    if ($ResultsFile) { Write-RunHost "`nResults written to $ResultsFile" Cyan }

    if ($anyFailures) {
        Write-RunHost 'One or more tests failed.' Red
        return 1
    }
    if ($DryRun) { Write-RunHost 'Suite validation passed; live tests were not run.' Yellow }
    else { Write-RunHost 'All selected tests passed.' Green }
    return 0
}
