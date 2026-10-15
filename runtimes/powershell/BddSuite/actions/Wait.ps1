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
            $null = Invoke-SuiteStep -Step $Step.forStep -Ctx $Ctx
            if ($Step.until) {
                try {
                    Test-Assertion -Assert $Step.until -Ctx $Ctx
                    return @{ waited = $true; elapsedSec = ($timeout - [int](($deadline - (Get-Date)).TotalSeconds)) }
                } catch {
                    # assertion failed, keep polling
                }
            }
        } catch {
            # step failed transiently, keep polling
        }
        Start-Sleep -Seconds $interval
    }
    throw "wait: timeout after $timeout sec"
}
