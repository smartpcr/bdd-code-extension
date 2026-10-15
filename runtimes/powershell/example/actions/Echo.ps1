# example.echo: the example extension's one action.
#
# Loaded under the extension's name, in the runner and in the step runspace,
# because BddSuite.Example.psm1 lists this folder as its ActionPath. $Ctx.state
# is what the extension's Start returned as State for this run.

Register-SuiteAction -Name 'example.echo' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    if ($Step.text -isnot [string]) { throw 'example.echo needs a text.' }
    $region = if ($Ctx.state) { [string]$Ctx.state.region } else { '' }
    return @{ echoed = "${region}:$($Step.text)" }
}
