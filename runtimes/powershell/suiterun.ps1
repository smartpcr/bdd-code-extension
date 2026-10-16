<#
.SYNOPSIS
    suiterun: the PowerShell runtime's command line, with the verbs, flags,
    outputs and exit codes of every program's suiterun.

.DESCRIPTION
    pwsh -File runtimes/powershell/suiterun.ps1 <verb> [flags]

        lint    --path <glob> [--json] [--strict] [--binding-check] [--binding <name>]
        run     --path <glob> [--tags a,b] [--results f.xml] [--format nunit3|junit]
                [--dry-run] [--param name=value] [--trace-file f.json] [--test-name <case>]
        list    --path <glob> [--tags a,b]
        actions [--json]

    and --schema-root <dir> on any verb. This entry runs the core alone. A
    workspace's own suiterun.ps1 is the same three lines with its extensions:

        Import-Module <runtime>/BddSuite/BddSuite.psd1 -DisableNameChecking
        exit (Invoke-BddSuiteCli -Arguments $args -Extension <its extension modules>)

    Exit codes: 0 passed, 1 a case failed, 2 refused.
#>
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BddSuite/BddSuite.psd1') -DisableNameChecking
exit (Invoke-BddSuiteCli -Arguments $args)
