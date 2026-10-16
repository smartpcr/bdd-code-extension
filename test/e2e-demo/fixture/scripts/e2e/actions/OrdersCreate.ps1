# Action: orders.create
#
# Creates an order for an item and returns it for captureAs.

Register-SuiteAction -Name 'orders.create' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)

    return @{ id = [guid]::NewGuid().ToString('N'); item = $Step.item; quantity = $Step.quantity }
}
