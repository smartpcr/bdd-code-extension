# Action: {{action}} - return the text it is given. A starting point; replace it
# with the first real action. $Step holds the step's parameters after
# substitution, $Ctx the run's context ($Ctx.state: the environment the run
# targets); the hashtable returned is what captureAs keeps.

Register-SuiteAction -Name '{{action}}' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $text = [string]$Step['text']
    if (-not $text) { throw '{{action}}: text is required' }
    return [ordered]@{ text = $text }
}
