<#
.SYNOPSIS
    Generates this workspace's suite.schema.json and suite.schema.md from its
    catalog, by forwarding to the repository's spec/Build-Schema.ps1.

.DESCRIPTION
    A thin wrapper so the workspace has one command to regenerate (and, with
    -Check, to verify) its schema: the generator itself lives in spec/, beside
    the core it folds in.

.PARAMETER Check
    Write nothing; exit 2 naming every generated file that differs from what
    is committed.

.EXAMPLE
    pwsh -File test/e2e/schema/Build-Schema.ps1
    pwsh -File test/e2e/schema/Build-Schema.ps1 -Check
#>
[CmdletBinding()]
param([switch]$Check)

$ErrorActionPreference = 'Stop'
$generator = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../../../spec/Build-Schema.ps1'))
$catalog = Join-Path $PSScriptRoot 'actions.catalog.yaml'
& $generator -Catalog $catalog -Check:$Check
exit $LASTEXITCODE
