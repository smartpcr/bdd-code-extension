# stock.receive, stock.ship and stock.level: what a store holds.

Register-SuiteAction -Name 'stock.receive' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $path = Get-RequiredText $Step 'stock.receive' 'store'
    $sku = Get-RequiredText $Step 'stock.receive' 'sku'
    $qty = Get-Quantity $Step 'stock.receive'
    $levels = Read-InventoryStore $path
    $levels[$sku] = [long]$levels[$sku] + $qty
    Write-InventoryStore $path $levels
    return [ordered]@{ sku = $sku; received = $qty; onHand = $levels[$sku] }
}

Register-SuiteAction -Name 'stock.ship' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $path = Get-RequiredText $Step 'stock.ship' 'store'
    $sku = Get-RequiredText $Step 'stock.ship' 'sku'
    $qty = Get-Quantity $Step 'stock.ship'
    $levels = Read-InventoryStore $path
    $onHand = [long]$levels[$sku]
    if ($onHand -lt $qty) {
        # A refusal is an answer: the case asserts on it.
        return [ordered]@{ sku = $sku; shipped = $false; onHand = $onHand; reason = "$sku`: asked for $qty, only $onHand on hand" }
    }
    $levels[$sku] = $onHand - $qty
    Write-InventoryStore $path $levels
    return [ordered]@{ sku = $sku; shipped = $true; onHand = $levels[$sku] }
}

Register-SuiteAction -Name 'stock.level' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $sku = Get-RequiredText $Step 'stock.level' 'sku'
    $levels = Read-InventoryStore (Get-RequiredText $Step 'stock.level' 'store')
    return [ordered]@{ sku = $sku; onHand = [long]$levels[$sku] }
}
