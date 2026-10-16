# The shop's actions, PowerShell binding. Loaded by Workspace.Extension.psm1
# (its ActionPath is this folder), in the runner and in the step runspace.
#
# Every handler is small and deterministic, and returns what the other four
# bindings return for the same step, so one suite gives one result everywhere.

function Get-ShopInteger {
    # An integer parameter, given as a number or as a numeric string.
    param($Value, [long]$Default)
    if ($null -eq $Value -or "$Value" -eq '') { return $Default }
    return [long]"$Value"
}

function Get-ShopText {
    # A required text parameter.
    param([hashtable]$Step, [string]$Name, [string]$Action)
    $value = $Step[$Name]
    if ($null -eq $value -or "$value" -eq '') { throw "${Action} needs a ${Name}." }
    return [string]$value
}

Register-SuiteAction -Name 'inventory.get' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $sku = Get-ShopText $Step 'sku' 'inventory.get'
    return [ordered]@{ sku = $sku; quantity = [long]($sku.Length * 10); inStock = $true }
}

Register-SuiteAction -Name 'shop.state' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $shop = if ($Step.shop) { [string]$Step.shop } else { 'main' }
    return [ordered]@{
        Name  = $shop
        Open  = $true
        Items = @(
            [ordered]@{ Sku = 'APPLE'; Quantity = [long]5 },
            [ordered]@{ Sku = 'PEAR'; Quantity = [long]3 }
        )
    }
}

Register-SuiteAction -Name 'cart.add' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $sku = Get-ShopText $Step 'sku' 'cart.add'
    $quantity = Get-ShopInteger $Step.quantity 1
    return [ordered]@{ sku = $sku; quantity = $quantity; line = "${sku}x$quantity" }
}

Register-SuiteAction -Name 'order.place' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $sku = Get-ShopText $Step 'sku' 'order.place'
    $quantity = Get-ShopInteger $Step.quantity 1
    return [ordered]@{ orderId = "ORD-$sku-$quantity"; status = 'placed' }
}

Register-SuiteAction -Name 'shipping.quote' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $weight = Get-ShopInteger $Step.weightKg 0
    if ($weight -le 0) { throw 'shipping.quote needs a weightKg above zero.' }
    $policy = if ($Step.policy) { [string]$Step.policy } else { 'Standard' }
    $rate = switch -CaseSensitive ($policy) { 'Standard' { 5 } 'Express' { 10 } default { throw "shipping.quote: unknown policy $policy." } }
    return [ordered]@{ policy = $policy; cost = [long]($weight * $rate) }
}

Register-SuiteAction -Name 'customer.lookup' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $id = Get-ShopText $Step 'id' 'customer.lookup'
    $tier = if ($id.StartsWith('G', [StringComparison]::Ordinal)) { 'gold' } else { 'standard' }
    return [ordered]@{ id = $id; name = "Customer $id"; tier = $tier }
}

Register-SuiteAction -Name 'audit.log' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $null = Get-ShopText $Step 'message' 'audit.log'
    return [ordered]@{ logged = $true }
}
