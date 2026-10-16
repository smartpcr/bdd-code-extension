<#
.SYNOPSIS
    The sample workspace's PowerShell extension: its shop actions, the context
    key store and the option that sets it.

.DESCRIPTION
    Built on BddSuite's exported commands only. It adds:

        actions      actions/*.ps1 (Register-SuiteAction)
        context key  store    ${store} in any expression; 'main' unless --store gives one
        option       store    suiterun.ps1 run ... --store <name>
#>

function Get-SuiteExtension {
    return @{
        Name        = 'shop'
        ActionPath  = @('actions')
        ContextKeys = @('store')
        Options     = @(@{ Name = 'store'; Description = 'The store ${store} reads (main by default).' })
        Start       = {
            param([hashtable]$Options)
            $store = if ($Options.ContainsKey('store') -and $Options['store']) { [string]$Options['store'] } else { 'main' }
            return @{ Context = @{ store = $store }; State = @{ store = $store } }
        }
    }
}

Export-ModuleMember -Function Get-SuiteExtension
