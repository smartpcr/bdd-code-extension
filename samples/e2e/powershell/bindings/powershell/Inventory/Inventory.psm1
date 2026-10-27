<#
.SYNOPSIS
    The inventory extension of the BddSuite module: the actions
    schema/actions.catalog.yaml declares. suiterun.ps1 and the generated Pester
    tests both load it.

.DESCRIPTION
    ActionPath: actions/*.ps1, one Register-SuiteAction per action. The Suite
    Authoring extension finds the registrations there (the catalog's
    bindingSources) and its *Declare action* writes a new action's stub there
    (bddSuite.bindings.powershell.stubFile).

    Modules: InventoryStore.psm1, the store the actions act on. Handlers run in
    the runtime's step runspace, which imports it before the action files load.

    Options: the environment a guarded suite reaches. The Suite Authoring
    extension passes --api-url, --lab-id and --connection-file to every run of a
    guarded suite (bddSuite.lab.*); the generated tests read them as
    BDD_SUITE_OPTION_API_URL and so on. Start hands them to every action as
    $Ctx.state.
#>

function Get-SuiteExtension {
    return @{
        Name       = 'inventory'
        ActionPath = @('actions')
        Modules    = @('InventoryStore.psm1')
        Options    = @(
            @{ Name = 'apiUrl'; Description = 'The warehouse service warehouse.sync sends to when its step names no endpoint.' }
            @{ Name = 'labId'; Description = "The environment's id, for the report." }
            @{ Name = 'connectionFile'; Description = "The environment's connection file." }
        )
        Start      = {
            param([hashtable]$Options)
            return @{ State = @{ apiUrl = [string]$Options['apiUrl']; labId = [string]$Options['labId']; connectionFile = [string]$Options['connectionFile'] } }
        }
    }
}

Export-ModuleMember -Function Get-SuiteExtension
