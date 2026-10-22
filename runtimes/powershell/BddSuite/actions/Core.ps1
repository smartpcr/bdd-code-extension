# Core actions: pure logic, no lab, no network, no remote session.
#
# They exist so that execution semantics can be tested without a stamp. A hook
# order, a cancelled step, a table iterating in row order and an outline
# reporting per row are all properties of the runner, and proving them with an
# action that reaches a real system would mean needing that system to prove
# something that has nothing to do with it.
#
# Every runtime implements these (spec/core.catalog.yaml), which is what makes
# the conformance corpus runnable by all five.
#
# Dot-sourced by BddSuite.psm1 when the module is imported, so the core is
# registered in every session that loads the runtime, the step runspace
# included.

Register-SuiteAction -Name 'core.noop' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    # A step that does nothing and says so. What a `then` step uses when its
    # whole job is to carry a sentence and assert on what is already captured.
    return @{ ok = $true }
}

Register-SuiteAction -Name 'core.set' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    # Publishes a literal, so a fixture can capture a value without an action
    # that goes somewhere to get one.
    if (-not $Step.ContainsKey('value')) { throw 'core.set: value is required' }
    return $Step.value
}

Register-SuiteAction -Name 'core.fail' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    # Fails on purpose, with the message the fixture chose, so a test can assert
    # on attribution rather than on whatever a real action happened to say.
    $message = if ($Step.message) { [string]$Step.message } else { 'core.fail: failed on purpose' }
    throw $message
}

Register-SuiteAction -Name 'core.skip' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    # Ends its case as skipped, with the message the suite chose: what a case
    # does when it finds its environment cannot run it (spec/session.md rule
    # 12), usually guarded by ifCapture.
    $message = if ($Step.message) { [string]$Step.message } else { 'core.skip: skipped on purpose' }
    throw (New-StepSkip -Message $message)
}

Register-SuiteAction -Name 'core.sleep' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    # Sleeps, and is interruptible, which is how a limit proves it cancels work
    # rather than waiting it out.
    $seconds = if ($null -ne $Step.seconds) { [double]$Step.seconds } else { 1 }
    Start-Sleep -Milliseconds ([int]($seconds * 1000))
    return @{ sleptSec = $seconds }
}

Register-SuiteAction -Name 'core.record' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    # Appends one marker to the file named by <prefix>RECORD_PATH
    # (BDD_SUITE_RECORD_PATH unless an extension sets another prefix), which the
    # runner reads once and hands every step as $Ctx.recordPath, and returns it.
    # A file rather than a variable because the phases under test run in the
    # runner's process and the assertions run in the test's, so the trace has
    # to survive a process boundary.
    $marker = [string]$Step.marker
    if (-not $marker) { throw 'core.record: marker is required' }
    $path = [string]$Ctx.recordPath
    # Steps run one at a time, so the append needs no retry. If one ever fails,
    # saying so is better than a loop that hides why.
    if ($path) { [IO.File]::AppendAllText($path, $marker + [Environment]::NewLine) }
    return @{ marker = $marker }
}
