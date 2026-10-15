<#
.SYNOPSIS
    The action registry: every action this runtime can run, by name, with the
    extension that registered it. Dot-sourced by StepExecution.psm1, so the
    registry lives in that module and Invoke-SuiteStep reads it directly.

.DESCRIPTION
    Each action is a scriptblock with the signature:
        param([hashtable]$Step, [hashtable]$Ctx)
    and returns whatever the suite should be able to capture (string,
    hashtable, number, etc.). It throws on failure.

    $Ctx carries, for every step:
        capture    - hashtable of values captured by previous steps
        param      - the suite parameters, resolved highest source first
        var        - the suite and case variables
        row        - the table or outline row in scope, when there is one
        defaults   - the suite-level defaults block
        timeoutSec - the case's declared limit
        recordPath - <prefix>RECORD_PATH, where core.record appends
        state      - what the registering extension's Start returned as State
        <key>      - one entry per extension context key

    $Step is the YAML step after ${...} substitution.

    To add an action, write a file that calls Register-SuiteAction (or its old
    name Register-LabAction) and hand its folder to Invoke-BddSuite with
    -ActionPath, or list it in an extension's ActionPath (README.md). The core
    actions (actions/Core.ps1, actions/Wait.ps1) are registered when BddSuite
    is imported.

    Two sources registering one name is refused, naming both, before anything
    runs: an action that silently replaced another would make a suite mean
    whatever was loaded last.
#>

# Name to @{ handler; owner }. Ordinal: action names are case-sensitive in
# every runtime.
$script:SuiteActions = [Collections.Generic.Dictionary[string, hashtable]]::new([StringComparer]::Ordinal)
# Who the next registration belongs to. The loader sets it before it loads an
# extension's action files; anything registered outside a load belongs to the
# caller that registered it.
$script:SuiteActionOwner = 'the core'

function Register-SuiteAction {
    <#
    .SYNOPSIS
        Register one action under a name.
    .DESCRIPTION
        Refuses a name another source already registered: "Action X is defined
        by both A and B." The owner is the extension being loaded (see
        Set-SuiteActionOwner), or -Owner when given.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ScriptBlock]$Handler,
        [string]$Owner
    )
    if (-not $Owner) { $Owner = $script:SuiteActionOwner }
    $held = $null
    if ($script:SuiteActions.TryGetValue($Name, [ref]$held)) {
        throw "Action $Name is defined by both $($held.owner) and $Owner."
    }
    $script:SuiteActions[$Name] = @{ handler = $Handler; owner = $Owner }
}

function Set-SuiteActionOwner {
    <#
    .SYNOPSIS
        Name the source the next registrations belong to, and return the one it
        replaces.
    .DESCRIPTION
        The runner calls this around each extension's action files, so a name
        two extensions both register is refused naming both. A wrapper that
        loads action files itself does the same.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Owner)
    $previous = $script:SuiteActionOwner
    $script:SuiteActionOwner = $Owner
    return $previous
}

function Get-SuiteAction {
    <#
    .SYNOPSIS
        The handler registered under a name, or nothing.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Name)
    $held = $null
    if ($script:SuiteActions.TryGetValue($Name, [ref]$held)) { return $held.handler }
    return $null
}

function Get-SuiteActionOwner {
    <#
    .SYNOPSIS
        Which source registered an action, or nothing when none did.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Name)
    $held = $null
    if ($script:SuiteActions.TryGetValue($Name, [ref]$held)) { return $held.owner }
    return $null
}

function Get-SuiteActionNames {
    <#
    .SYNOPSIS
        Every action name this registry holds, sorted.
    .DESCRIPTION
        The catalog is the vocabulary every runtime reads, and a test compares
        it with this list: an action added in code without being declared in
        the catalog fails that test.
    #>
    [CmdletBinding()]
    param()
    return @($script:SuiteActions.Keys | Sort-Object)
}

function Reset-SuiteActionRegistry {
    <#
    .SYNOPSIS
        Forget every registration; the core's are made again by the caller.
    #>
    [CmdletBinding()]
    param()
    $script:SuiteActions.Clear()
    $script:SuiteActionOwner = 'the core'
}
