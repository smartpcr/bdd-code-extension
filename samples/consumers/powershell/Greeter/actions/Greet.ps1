# greet.say and greet.shout: the greeter's actions. Loaded under the
# extension's name because Greeter.psm1 lists this folder as its ActionPath.

Register-SuiteAction -Name 'greet.say' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    return @{ text = "Hello, $($Step.name)!" }
}

Register-SuiteAction -Name 'greet.shout' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    return @{ text = "HELLO, $(([string]$Step.name).ToUpperInvariant())!" }
}
