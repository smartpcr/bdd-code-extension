<#
.SYNOPSIS
    The {{name}} extension of the BddSuite module: the actions
    schema/actions.catalog.yaml declares. suiterun.ps1 and the generated Pester
    tests both load it.

.DESCRIPTION
    ActionPath: actions/*.ps1, one Register-SuiteAction per action. The Suite
    Authoring extension finds the registrations there (the catalog's
    bindingSources), and its *Declare action* writes a new action's file there
    (bddSuite.bindings.powershell.stubFile). Handlers run in the runtime's own
    step runspace: a helper they share goes in a module listed under Modules.

    Options: the environment a guarded suite reaches. The Suite Authoring
    extension passes --api-url, --lab-id and --connection-file to every run of a
    guarded suite (bddSuite.lab.*); the generated tests read them as
    BDD_SUITE_OPTION_API_URL and so on. Start hands them to every action as
    $Ctx.state.
#>

function Get-SuiteExtension {
    return @{
        Name       = '{{name}}'
        ActionPath = @('actions')
        Options    = @(
            @{ Name = 'apiUrl'; Description = "The environment's API URL." }
            @{ Name = 'labId'; Description = "The environment's id." }
            @{ Name = 'connectionFile'; Description = "The environment's connection file." }
        )
        Start      = {
            param([hashtable]$Options)
            return @{ State = @{ apiUrl = [string]$Options['apiUrl']; labId = [string]$Options['labId']; connectionFile = [string]$Options['connectionFile'] } }
        }
    }
}

Export-ModuleMember -Function Get-SuiteExtension
