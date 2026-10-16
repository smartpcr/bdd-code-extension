# Action: demo.greet
#
# Greets someone by name and returns the greeting for captureAs.

Register-SuiteAction -Name 'demo.greet' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)

    return @{ greeting = "Hello, $($Step.name)" }
}
