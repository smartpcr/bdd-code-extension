<#
.SYNOPSIS
    suiterun for this workspace: the BddSuite module's command line with the
    {{name}} extension.

.DESCRIPTION
    pwsh -File bindings/powershell/suiterun.ps1 <verb> [flags]

    The verbs, flags, outputs and exit codes every binding's suiterun has
    (lint, run, list, actions, generate; --path, --schema-root, --tags, --name,
    --results, --format, --trace-file, --progress, --dry-run, ...), plus
    --test-name <case> for a one-case run. The Suite Authoring extension runs
    it (.vscode/settings.json, bddSuite.bindings.powershell.tool).

    BddSuite comes from .modules/ at the workspace root, which restore.ps1
    fills from packages.psd1; it is put first on this process's PSModulePath
    only, so the version packages.psd1 names is the one loaded.
#>
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$modules = Join-Path $workspace '.modules'
$version = (Import-PowerShellDataFile (Join-Path $workspace 'packages.psd1')).BddSuite.Version
if (-not (Test-Path (Join-Path $modules "BddSuite/$version"))) {
    [Console]::Error.WriteLine("suiterun: BddSuite $version is not restored; run pwsh -File restore.ps1 at $workspace first.")
    exit 2
}
$env:PSModulePath = $modules + [IO.Path]::PathSeparator + $env:PSModulePath
Import-Module BddSuite -RequiredVersion $version -DisableNameChecking
exit (Invoke-BddSuiteCli -Arguments $args -Extension (Join-Path $PSScriptRoot '{{Namespace}}/{{Namespace}}.psm1'))
