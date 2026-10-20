# fixture.append, the one fixture action the execute corpus runs
# (execute/capture-isolation.yml): the item appended to the list it was given,
# in place when the list can grow, which is the change a case must keep to
# itself.
Register-SuiteAction -Name 'fixture.append' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    $list = $Step['list']
    if ($list -isnot [System.Collections.IList] -or $list -is [string]) { throw 'fixture.append: list must be a list' }
    if (-not $list.IsFixedSize) {
        $null = $list.Add($Step['item'])
        return , $list
    }
    return , @(@($list) + , $Step['item'])
}

# fixture.throw (execute/worker-throws.yml): an exception of a .NET type the
# runtime never names, so only a worker that turns any error into the step's
# failure keeps the run going (spec/progress.md).
Register-SuiteAction -Name 'fixture.throw' -Handler {
    param([hashtable]$Step, [hashtable]$Ctx)
    throw [System.Security.Cryptography.CryptographicException]::new([string]$Step['message'])
}
