<#
.SYNOPSIS
    The greeter's extension: what a consumer writes to add its own actions to
    the BddSuite module. Its suiterun.ps1 and its generated Pester tests both
    load it.
#>

function Get-SuiteExtension {
    return @{
        Name       = 'greeter'
        # greet.say and greet.shout (actions/Greet.ps1).
        ActionPath = @('actions')
    }
}

Export-ModuleMember -Function Get-SuiteExtension
