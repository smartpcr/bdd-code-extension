<#
.SYNOPSIS
    The corpus's test extension: the context keys conformance/ reads.

.DESCRIPTION
    The core defines no context keys of its own (DEC-S03), and the corpus's
    expression table reads four (conformance/README.md). Every runtime's corpus
    test registers them through its extension API, with the values in
    conformance/expressions/context.yaml, which is also what proves a context
    key reaches lint and the run from an extension. It also implements
    fixture.append (actions/Fixture.ps1), for execute/capture-isolation.yml.
#>

function Get-SuiteExtension {
    return @{
        Name        = 'corpus'
        ActionPath  = @('actions')
        ContextKeys = @('cluster', 'target', 'labId', 'apiUrl')
        Start       = {
            param([hashtable]$Options)
            return @{ Context = @{ cluster = 'HOST-CL01'; target = 'HOST-N1'; labId = 'lab1'; apiUrl = 'http://api/api/v1' } }
        }
    }
}

Export-ModuleMember -Function Get-SuiteExtension
