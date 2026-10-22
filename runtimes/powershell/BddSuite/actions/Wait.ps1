# Action: wait
#
# Sleep for N seconds, or poll a captured value until a condition is true.
#
# YAML (simple):
#   - action: wait
#     seconds: 30
#
# YAML (poll):
#   - action: wait
#     forStep:
#       action: core.set
#       value: { State: Up }
#       captureAs: cs
#     until:
#       var: cs.State
#       equals: Up
#     intervalSec: 10
#     timeoutSec: 300

Register-SuiteAction -Name 'wait' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)

    if ($Step.seconds -and -not $Step.forStep) {
        Start-Sleep -Seconds ([int]$Step.seconds)
        return @{ waitedSec = [int]$Step.seconds }
    }

    $interval = if ($Step.intervalSec) { [int]$Step.intervalSec } else { 10 }
    $timeout  = if ($Step.timeoutSec)  { [int]$Step.timeoutSec }  else { 300 }
    $deadline = (Get-Date).AddSeconds($timeout)

    while ((Get-Date) -lt $deadline) {
        try {
            # Inline, with no runspace of its own: the poll runs inside the bound
            # the wait step already holds, and Invoke-SuiteStep is what records
            # the nested capture.
            try {
                $null = Invoke-SuiteStep -Step $Step.forStep -Ctx $Ctx
                # Each poll is a step of the case, and the trace says so, as every
                # runtime's does: the runner reads $Ctx.__nested after the wait.
                if ($Ctx.__nested -is [System.Collections.IList]) { $null = $Ctx.__nested.Add(@{ step = $Step.forStep; status = 'passed'; reason = '' }) }
            } catch {
                $reason = Get-StepFailureReason -Failure $_.Exception
                $status = if ($reason -eq 'skip') { 'skipped' } else { 'failed' }
                if ($Ctx.__nested -is [System.Collections.IList]) { $null = $Ctx.__nested.Add(@{ step = $Step.forStep; status = $status; reason = $reason }) }
                throw
            }
            if ($Step.until) {
                try {
                    Test-Assertion -Assert $Step.until -Ctx $Ctx
                    return @{ waited = $true; elapsedSec = ($timeout - [int](($deadline - (Get-Date)).TotalSeconds)) }
                } catch {
                    # assertion failed, keep polling
                }
            }
        } catch {
            # A skip is the case's decision, not a step that is not ready yet: it
            # ends the case rather than being polled again (session.md rule 12).
            if (Test-StepSkip -Failure $_.Exception) { throw }
            # step failed transiently, keep polling
        }
        Start-Sleep -Seconds $interval
    }
    throw "wait: timeout after $timeout sec"
}
