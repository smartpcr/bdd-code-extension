# Action: orders.ship
#
# Ships an order.

Register-SuiteAction -Name 'orders.ship' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)

    return @{ shipped = $Step.orderId }
}
