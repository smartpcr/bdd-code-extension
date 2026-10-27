# warehouse.sync: stands for an action that reaches a real environment, so a
# suite using it is guarded (bddsuite.tests.yaml leaves it out of offlineActions).

Register-SuiteAction -Name 'warehouse.sync' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $path = Get-RequiredText $Step 'warehouse.sync' 'store'
    # The step's endpoint, else the run's --api-url, else the sample's default.
    $endpoint = if ($Step['endpoint']) { [string]$Step['endpoint'] }
    elseif ($Ctx.state.apiUrl) { [string]$Ctx.state.apiUrl }
    else { 'https://warehouse.example/api/levels' }
    $levels = Read-InventoryStore $path
    # The sample's stand-in for the service call: the payload is written beside the store.
    $payload = ConvertTo-InventoryJson $levels
    Set-Content -LiteralPath "$path.sync.json" -Value $payload -NoNewline
    return [ordered]@{ endpoint = $endpoint; skus = [long]$levels.Count; payload = $payload }
}
