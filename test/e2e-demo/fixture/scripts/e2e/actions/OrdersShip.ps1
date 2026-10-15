# Action: orders.ship
#
# Ships an order.

Register-LabAction -Name 'orders.ship' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)

    return @{ shipped = $Step.orderId }
}
