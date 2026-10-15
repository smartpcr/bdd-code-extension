# Action: demo.count
#
# Counts from one to the step's `to`.

Register-LabAction -Name 'demo.count' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)

    return @{ counted = @(1..[int]$Step.to) }
}
