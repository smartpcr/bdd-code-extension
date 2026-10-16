<#
.SYNOPSIS
    The sample workspace's suiterun, PowerShell binding: the runtime's command
    line with this workspace's extension.

.DESCRIPTION
    pwsh -File scripts/e2e/suiterun.ps1 <verb> [flags]

    The same verbs, flags, outputs and exit codes as every program's suiterun
    (lint, run, list, actions; --path, --json, --strict, --binding-check,
    --binding, --tags, --results, --format, --dry-run, --param, --trace-file,
    --schema-root), plus --test-name <case> for a one-case run, and --store
    <name>, the option this workspace's extension adds.
#>
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '../../../../runtimes/powershell/BddSuite/BddSuite.psd1') -DisableNameChecking
exit (Invoke-BddSuiteCli -Arguments $args -Extension (Join-Path $PSScriptRoot 'Workspace.Extension.psm1'))
