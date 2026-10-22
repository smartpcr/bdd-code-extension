<#
.SYNOPSIS
    Runs one step, inside a limit that is enforced by cancelling the work.

.DESCRIPTION
    Y2.3 / DEC-Y08, DEC-Y09. Defect D3: the runner used to check the deadline
    *before* each step, so a step that blocked ran until the process was killed
    and the declared case-budget guarantee was only a guarantee about the gaps
    between steps.

    The fix is to run the action in a second runspace and stop it when its limit
    expires. A runspace rather than a thread job because arguments reach a
    runspace as live object references rather than serialised copies, so a step
    still sees the same capture bag, the same open event streams and the same
    credential object the case holds.

    What a new runspace does not inherit is session state, so it is initialised
    once per run with the modules and the action registry, and replaced after a
    cancellation, because a stopped pipeline can leave module state half-written
    and assuming it did not is how a later step fails for no visible reason.

    An action the catalog marks `interruptible: false` holds a PSDirect or WinRM
    session that PowerShell cannot interrupt. Stopping the pipeline stops *this*
    side waiting; the work on the far side keeps going. That is reported as
    abandoned rather than cancelled, because they are not the same promise.

    This module also owns the two things a step does either side of the action -
    substituting `${...}` into it and comparing an assertion - because an action
    that runs a nested step, as `wait` does, needs them where it runs.
    Y2.6 and Y2.7 replace their bodies with the expression evaluator and the
    operator table; the names stay.
#>

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

# The expression language a suite is written in. Imported here rather than by
# the runner alone, because a step runs in a second runspace and needs it there.
Import-Module (Join-Path $PSScriptRoot 'Expression.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Assertions.psm1') -DisableNameChecking

# The action registry lives here, so Invoke-SuiteStep reads it directly and a
# runspace that imports BddSuite has its own.
. (Join-Path $PSScriptRoot 'actions/ActionRegistry.ps1')

# The two scripts that run in the *other* runspace, held as text rather than as
# scriptblock literals. A profiler instruments only the runspace it started in,
# so a scriptblock literal here would be counted as code this process never
# runs, and a coverage number that counts unreachable lines measures nothing.
#
# The step runspace loads BddSuite (which registers the core actions), then
# every extension's modules, then every source of action files, each under its
# owner's name. The files are dot-sourced at the runspace's top level, so a
# helper function an action file defines is still there when its handler runs.
# Nothing is loaded by a fixed path: what loads is what the run was given
# (Invoke-BddSuite -Extension and -ActionPath).
$script:StepRunspaceInit = @"
param(`$__bddManifest, `$__bddLoad)
`$ErrorActionPreference = 'Stop'
Import-Module powershell-yaml -ErrorAction Stop
Import-Module `$__bddManifest -Force -DisableNameChecking
foreach (`$__bddModule in @(`$__bddLoad.modules)) { if (`$__bddModule) { Import-Module `$__bddModule -Force -DisableNameChecking } }
foreach (`$__bddSource in @(`$__bddLoad.sources)) {
    if (`$null -eq `$__bddSource) { continue }
    `$__bddPrevious = Set-SuiteActionOwner -Owner ([string]`$__bddSource.owner)
    foreach (`$__bddFile in @(`$__bddSource.files)) { if (`$__bddFile) { . `$__bddFile } }
    `$null = Set-SuiteActionOwner -Owner `$__bddPrevious
}
"@

$script:StepActionBody = @"
param(`$ActionName, `$Step, `$Context)
`$ErrorActionPreference = 'Stop'
`$handler = Get-SuiteAction -Name `$ActionName
if (-not `$handler) { throw "Unknown action: `$ActionName. No extension of this runtime registers it." }
& `$handler -Step `$Step -Ctx `$Context
"@

function New-StepFailure {
    <#
    .SYNOPSIS
        A failure that says which category it belongs to as well as what went
        wrong.
    .DESCRIPTION
        A trace entry names a reason from a closed list, and the list is part of
        the conformance contract while the message is not. Attaching the
        category here is what lets the runner report it without reading its own
        wording back out of a string.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Message, [Parameter(Mandatory)][string]$Reason)

    $failure = [Exception]::new($Message)
    $failure.Data['SuiteReason'] = $Reason
    return $failure
}

function Get-StepFailureReason {
    <#
    .SYNOPSIS
        The category a failure belongs to, or 'action' when it did not say.
    .DESCRIPTION
        An action that threw on its own says nothing about categories, and that
        is exactly what 'action' means: the step's own work failed.
    #>
    [CmdletBinding()]
    param($Failure)

    if ($Failure -and $Failure.Data -and $Failure.Data['SuiteReason']) { return [string]$Failure.Data['SuiteReason'] }
    return 'action'
}

function New-StepSkip {
    <#
    .SYNOPSIS
        Not a failure: the case cannot run here, so it ends as skipped with this
        message. What an action throws (`throw (New-StepSkip 'why')`).
    .DESCRIPTION
        spec/session.md rule 12. In a case's own setup or steps the rest of the
        case does not run, its cleanup and afterEach still do, and the case is
        skipped with reason skip. In any other hook it is that hook's failure,
        as anything else thrown there is.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Message)

    return (New-StepFailure -Message $Message -Reason 'skip')
}

function Test-StepSkip {
    <#
    .SYNOPSIS
        Whether what a step threw ends its case as skipped rather than failing it.
    #>
    [CmdletBinding()]
    param($Failure)

    return ((Get-StepFailureReason -Failure $Failure) -eq 'skip')
}

function Expand-SuiteValue {
    <#
    .SYNOPSIS
        Substitute every ${...} in a value against the run context.
    .DESCRIPTION
        Y2.6 moved the work into Expression.psm1, which reads the same two rules
        the regex walk followed - a string that is exactly one expression keeps
        its type, a string with one inside text is substituted - and adds the
        operators and the closed function list. This stays as the name every
        caller already uses.
    #>
    [CmdletBinding()]
    param([object]$Value, [hashtable]$Ctx)
    return , (Expand-SuiteExpression -Value $Value -Scope $Ctx)
}
function Get-AssertionActual {
    <#
    .SYNOPSIS
        Walk a dotted subject path into the capture bag, and say whether it was
        there at all.
    .DESCRIPTION
        Absent and null are different things to isNull and isNotNull, so the
        walk reports both rather than collapsing one into the other.
    #>
    [CmdletBinding()]
    param([string]$Path, [hashtable]$Ctx)

    $cursor = $Ctx.capture
    $value = $null
    foreach ($segment in $Path -split '\.') {
        if ($null -eq $cursor) { return @{ value = $null; present = $false } }
        if ($cursor -isnot [string] -and $cursor -is [System.Collections.IList] -and $segment -match '^\d+$') {
            $position = [int]$segment
            if ($position -ge $cursor.Count) { return @{ value = $null; present = $false } }
            $value = $cursor[$position]
        } elseif ($cursor -is [System.Collections.IDictionary]) {
            if (-not $cursor.Contains($segment)) { return @{ value = $null; present = $false } }
            $value = $cursor[$segment]
        } else {
            $property = $cursor.PSObject.Properties[$segment]
            if (-not $property) { return @{ value = $null; present = $false } }
            $value = $property.Value
        }
        $cursor = $value
    }
    return @{ value = $value; present = $true }
}

function Test-Assertion {
    <#
    .SYNOPSIS
        Compare one assertion and throw when it does not hold.
    .DESCRIPTION
        Y2.7: the comparison rules live in Assertions.psm1, one table, so that
        three other bindings can be held to the same cells. What stays here is
        the bookkeeping: substitute the expected values, walk the subject, and
        say what failed in a sentence that names all four parts of it.

        Every operator in one assertion has to pass, which is what the suites
        were written against, and the first failure ends the case.
    #>
    [CmdletBinding()]
    param([hashtable]$Assert, [hashtable]$Ctx)

    # A list with a blank entry in it parses as one null assertion; there is
    # nothing to compare, and the schema is what refuses the blank.
    if ($null -eq $Assert) { return }
    $expanded = Expand-SuiteValue -Value $Assert -Ctx $Ctx
    $subject = if ($expanded.var) { [string]$expanded.var } else { '(value)' }
    $found = @{ value = $null; present = $false }
    if ($expanded.var) { $found = Get-AssertionActual -Path $expanded.var -Ctx $Ctx }

    foreach ($operator in @($expanded.Keys | Where-Object { $null -ne $_ })) {
        if ($operator -eq 'var') { continue }
        if ($operator -eq 'script') {
            # PowerShell only, and refused elsewhere by the catalog's binding
            # list. It reads the bag directly rather than through a subject.
            $ok = & ([ScriptBlock]::Create($expanded.script))
            # Name the assertion: a case with several script assertions gave no
            # way to tell which one failed (lab3, 2026-09-24, E1-2 e1-2-08).
            $text = ([string]$expanded.script -replace '\s+', ' ').Trim()
            if ($text.Length -gt 200) { $text = $text.Substring(0, 200) + '...' }
            if (-not $ok) { throw "expected script assertion to return truthy, got '$ok': $text" }
            continue
        }
        $expected = $expanded[$operator]
        $passed = Test-SuiteComparison -Operator $operator -Actual $found.value -Expected $expected -Present $found.present
        if (-not $passed) {
            # Carried on the exception rather than matched out of its text: a
            # trace says why a step failed as a category (Y3.1), and deriving
            # that from a message would tie the category to the wording the
            # conformance contract deliberately leaves free.
            throw (New-StepFailure -Message (Format-AssertionFailure -Subject $subject -Operator $operator -Expected $expected -Actual $found.value -Present $found.present) -Reason 'assertion')
        }
    }
}
function Get-StepLimitSec {
    <#
    .SYNOPSIS
        The limit one step gets: its own, or what remains of the case, whichever
        is smaller (DEC-Y08).
    .DESCRIPTION
        The innermost number wins and never raises: a step may shorten its share
        of the case's budget and may never lengthen it. A step with no limit of
        its own gets what remains of the case. Zero means the case is already out
        of time, which the caller reports as a timeout rather than running the
        step for no seconds.
    #>
    [CmdletBinding()]
    param([int]$StepLimitSec = 0, [AllowNull()][object]$Deadline)

    $remaining = [int]::MaxValue
    if ($Deadline -is [DateTime]) {
        $remaining = [int][math]::Ceiling(([DateTime]$Deadline - [DateTime]::UtcNow).TotalSeconds)
        if ($remaining -lt 0) { $remaining = 0 }
    }
    if ($StepLimitSec -gt 0) { return [math]::Min($StepLimitSec, $remaining) }
    return $remaining
}

function New-StepRunspace {
    <#
    .SYNOPSIS
        A runspace that can run an action: BddSuite, the extensions' modules,
        their action files, and the host this process writes to.
    .DESCRIPTION
        Initialised once and reused. Passing the real host is what keeps an
        action's Write-Host on the console, which several of them use to narrate
        a long remote fixture.

        -Load is @{ modules = @(<module paths>); sources = @(@{ owner = <name>;
        files = @(<action .ps1 paths>) }) }, which Invoke-BddSuite builds from
        its -Extension and -ActionPath.
    #>
    [CmdletBinding()]
    param([hashtable]$Load = @{}, $RunspaceHost)

    $runspace = if ($RunspaceHost) { [RunspaceFactory]::CreateRunspace($RunspaceHost) } else { [RunspaceFactory]::CreateRunspace() }
    $runspace.Open()
    $shell = [powershell]::Create()
    $shell.Runspace = $runspace
    $manifest = Join-Path $PSScriptRoot 'BddSuite.psd1'
    $null = $shell.AddScript($script:StepRunspaceInit).AddArgument($manifest).AddArgument($Load)
    try { $null = $shell.Invoke() }
    catch { throw "Step runspace could not be initialised: $($_.Exception.Message)" }
    finally { $shell.Dispose() }
    return $runspace
}

function Close-StepRunspace {
    <#
    .SYNOPSIS
        Dispose a step runspace, and never fail a run because disposing failed.
    #>
    [CmdletBinding()]
    param($Runspace)
    if (-not $Runspace) { return }
    try { $Runspace.Close() } catch { Write-Verbose "Step runspace would not close: $($_.Exception.Message)" }
    try { $Runspace.Dispose() } catch { Write-Verbose "Step runspace would not dispose: $($_.Exception.Message)" }
}

function Stop-StepPipeline {
    <#
    .SYNOPSIS
        Stop an overrunning pipeline, and never let failing to stop it replace
        the timeout the case has to be told about.
    .DESCRIPTION
        Its own function rather than an inline catch so that the refusal has a
        test: a pipeline whose runspace has gone underneath it throws here, and
        the step still has to fail with its limit rather than with this.
    #>
    [CmdletBinding()]
    param($Shell)
    try { $Shell.Stop() } catch { Write-Verbose "Step would not stop: $($_.Exception.Message)" }
}

function Invoke-BoundedAction {
    <#
    .SYNOPSIS
        Run one action with a limit, and stop it when the limit expires.
    .DESCRIPTION
        Returns what the action returned. Rethrows what the action threw. Throws
        a timeout naming the limit when the action did not finish inside it, in
        the wording that is honest for its kind: cancelled when the runner could
        stop it, abandoned when the far side of a remote session keeps working.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Runspace,
        [Parameter(Mandatory)][string]$ActionName,
        [Parameter(Mandatory)][hashtable]$Step,
        [Parameter(Mandatory)][hashtable]$Context,
        [Parameter(Mandatory)][int]$LimitSec,
        [bool]$Interruptible = $true,
        [string]$Description
    )

    if (-not $Description) { $Description = "step $ActionName" }
    if ($LimitSec -le 0) { throw "$Description had no time left to run in: the deadline had already passed." }

    $shell = [powershell]::Create()
    $shell.Runspace = $Runspace
    $null = $shell.AddScript($script:StepActionBody).AddArgument($ActionName).AddArgument($Step).AddArgument($Context)

    $async = $shell.BeginInvoke()
    if (-not $async.AsyncWaitHandle.WaitOne([TimeSpan]::FromSeconds($LimitSec))) {
        Stop-StepPipeline -Shell $shell
        $wording = if ($Interruptible) { 'cancelled' } else {
            'abandoned: it holds a remote session this runner cannot interrupt, so the work on the far side continues'
        }
        throw (New-StepFailure -Message "$Description exceeded its ${LimitSec}s limit and was $wording." -Reason 'timeout')
    }

    try {
        # EndInvoke rethrows what the action threw, but as a method-invocation
        # failure wrapped around it, so a step's own message would read
        # 'Exception calling "EndInvoke"...' in the report. Unwrap to the
        # exception the action actually raised.
        try { $output = $shell.EndInvoke($async) } catch {
            $inner = $_.Exception
            while ($inner.InnerException -and $inner -is [Management.Automation.MethodInvocationException]) { $inner = $inner.InnerException }
            throw $inner
        }
        if ($shell.Streams.Error.Count) { throw $shell.Streams.Error[0].Exception }
        # A handler returning one object comes back as a one-element collection,
        # and returning nothing as an empty one. Unwrapping here keeps what a
        # capture holds identical to what the handler returned.
        $values = @($output)
        if (-not $values.Count) { return $null }
        if ($values.Count -eq 1) { return , $values[0] }
        return , $values
    } finally { $shell.Dispose() }
}

function Test-SuiteCapturePath {
    param([hashtable]$Capture, [string]$Path)
    if ($Capture.ContainsKey($Path)) { return $true }
    $current = $Capture
    foreach ($part in $Path.Split('.')) {
        if (-not $part -or $null -eq $current) { return $false }
        if ($current -is [Collections.IDictionary]) {
            if (-not $current.Contains($part)) { return $false }
            $current = $current[$part]
        } elseif ($current -is [pscustomobject]) {
            if (-not $current.PSObject.Properties[$part]) { return $false }
            $current = $current.$part
        } else { return $false }
    }
    return $true
}

function Invoke-SuiteStep {
    <#
    .SYNOPSIS
        Run one step: guard, substitute, act, capture.
    .DESCRIPTION
        One function for both callers, so the bookkeeping around an action
        happens once. The runner passes a runspace and a deadline, and the step
        is bounded; an action that runs a nested step, as `wait` does, passes
        neither and the nested step runs inline inside the bound its parent
        already holds.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Step,
        [Parameter(Mandatory)][hashtable]$Ctx,
        $Runspace,
        [AllowNull()][object]$Deadline,
        [bool]$Interruptible = $true,
        [string]$Description
    )

    if ($Step.ifCapture -and -not (Test-SuiteCapturePath $Ctx.capture ([string]$Step.ifCapture))) { return $null }

    if ($null -ne $Step.__row) {
        # Bound for this step only: ${row.<column>} reads the row it came from,
        # and the next step sees whatever its own row is, or none.
        $Ctx.row = $Step.__row
    }
    $expanded = Expand-SuiteValue -Value $Step -Ctx $Ctx
    $actionName = $expanded.action
    if (-not $actionName) { throw "Step is missing 'action' field" }
    # What the registering extension's Start returned as State, for this
    # action only (DEC-S03): an action sees its own extension's state.
    if ($Ctx.Contains('__states') -and $Ctx.__states -is [System.Collections.IDictionary]) {
        $owner = Get-SuiteActionOwner -Name ([string]$actionName)
        $Ctx.state = if ($owner -and $Ctx.__states.Contains($owner)) { $Ctx.__states[$owner] } else { $null }
    }

    if ($Runspace) {
        $limit = Get-StepLimitSec -StepLimitSec ([int]$expanded.timeoutSec) -Deadline $Deadline
        $result = Invoke-BoundedAction -Runspace $Runspace -ActionName $actionName -Step $expanded -Context $Ctx `
            -LimitSec $limit -Interruptible $Interruptible -Description $Description
    } else {
        $handler = Get-SuiteAction -Name $actionName
        if (-not $handler) { throw (New-StepFailure -Message "Unknown action: $actionName. No extension of this runtime registers it." -Reason 'action') }
        $result = & $handler -Step $expanded -Ctx $Ctx
    }

    # A step's capture is its own result while its own assertions run, and only
    # then collected into the list a table publishes. That is what lets a
    # per-row assertion say `seen.marker` and mean this row's result: the row
    # index it would otherwise have to name is not something the author knows.
    if ($expanded.captureAs) { $Ctx.capture[$expanded.captureAs] = $result }

    # Y2.8: a step's own assertions run here, immediately after it and before the
    # next step, inside the limit this step already holds. A `then` that asserts
    # nothing would be a label that lies.
    foreach ($assertion in @($Step.asserts)) {
        if ($null -eq $assertion) { continue }
        Test-Assertion -Assert (@{} + $assertion) -Ctx $Ctx
    }

    if ($expanded.captureAs -and $Step.__rowCount) {
        # One entry per row, in row order. The first row starts the list; the
        # rest append to what is already there.
        $collected = [Collections.Generic.List[object]]::new()
        if ($Step.__rowIndex -gt 1 -and $Ctx.capture.ContainsKey("__rows_$($expanded.captureAs)")) {
            foreach ($earlier in @($Ctx.capture["__rows_$($expanded.captureAs)"])) { $collected.Add($earlier) }
        }
        $collected.Add($result)
        $Ctx.capture["__rows_$($expanded.captureAs)"] = $collected.ToArray()
        $Ctx.capture[$expanded.captureAs] = $collected.ToArray()
    }
    return $result
}

Export-ModuleMember -Function Expand-SuiteValue, Get-AssertionActual, Test-Assertion, Get-StepLimitSec,
New-StepRunspace, Close-StepRunspace, Stop-StepPipeline, Invoke-BoundedAction, Invoke-SuiteStep,
New-StepFailure, Get-StepFailureReason, New-StepSkip, Test-StepSkip, Test-SuiteCapturePath,
Register-SuiteAction, Set-SuiteActionOwner, Get-SuiteAction, Get-SuiteActionOwner, Get-SuiteActionNames, Reset-SuiteActionRegistry
