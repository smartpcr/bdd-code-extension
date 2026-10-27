# store.open and store.close: a store's lifetime (InventoryStore.psm1).

Register-SuiteAction -Name 'store.open' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $name = if ($Step['name']) { [string]$Step['name'] } else { 'main' }
    return [ordered]@{ name = $name; path = New-InventoryStore $name }
}

Register-SuiteAction -Name 'store.close' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    return [ordered]@{ removed = Remove-InventoryStore (Get-RequiredText $Step 'store.close' 'store') }
}
