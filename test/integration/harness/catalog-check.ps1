<#
.SYNOPSIS
    Checks a workspace's action catalog the way a declaration must keep it:
    for the sample workspace layout (DEC-S11), replacing os-context's Y1.3.

.DESCRIPTION
    E-B6 asks that the catalog's own checks still pass after an action is
    declared. In a workspace built on these runtimes those checks are:
      - the catalog parses, has `catalogVersion`, `bindings` and `actions`;
      - every action has a unique name, a summary, and a non-empty list of
        bindings, each one the catalog names at the top;
      - the generated suite.schema.json and suite.schema.md are current
        (test/e2e/schema/Build-Schema.ps1 -Check);
      - the PowerShell binding registers exactly the core plus the actions the
        catalog lists for powershell (`suiterun.ps1 actions --json`), except
        the names given in -DeclaredOnly.
    It reads the workspace and writes nothing. Exit 0 and one summary line on
    success; a terminating error naming the first failed check otherwise.
#>
param(
    [Parameter(Mandatory)][string]$Root,
    # Declared in the catalog and registered by no binding on purpose (the sample's report.export).
    [string[]]$DeclaredOnly = @('report.export')
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
$script:checks = 0
function Assert([bool]$Condition, [string]$Message) {
    $script:checks++
    if (-not $Condition) { throw "FAIL: $Message" }
}

Import-Module powershell-yaml -ErrorAction Stop
$schemaRoot = Join-Path $Root 'test/e2e/schema'
$catalog = Get-Content -LiteralPath (Join-Path $schemaRoot 'actions.catalog.yaml') -Raw | ConvertFrom-Yaml
Assert ($null -ne $catalog.catalogVersion) 'the catalog has catalogVersion'
Assert ($catalog.bindings.Count -gt 0) 'the catalog names its bindings'
Assert ($catalog.actions.Count -gt 0) 'the catalog declares actions'

$names = @($catalog.actions | ForEach-Object { $_.name })
Assert (($names | Sort-Object -Unique).Count -eq $names.Count) "action names are unique: $($names -join ', ')"
foreach ($a in $catalog.actions) {
    Assert (-not [string]::IsNullOrWhiteSpace($a.name)) 'every action has a name'
    Assert (-not [string]::IsNullOrWhiteSpace($a.summary)) "$($a.name) has a summary"
    Assert ($a.bindings.Count -gt 0) "$($a.name) lists at least one binding"
    foreach ($b in $a.bindings) { Assert ($catalog.bindings -contains $b) "$($a.name): binding $b is one the catalog names" }
}

& pwsh -NoProfile -NonInteractive -File (Join-Path $schemaRoot 'Build-Schema.ps1') -Check | Out-Null
Assert ($LASTEXITCODE -eq 0) 'the generated schema is current (Build-Schema.ps1 -Check)'

$core = Get-Content -LiteralPath (Join-Path $Root '../../spec/core.catalog.yaml') -Raw | ConvertFrom-Yaml
$want = @(@($core.actions | ForEach-Object { $_.name }) + @($catalog.actions | Where-Object { $_.bindings -contains 'powershell' -and $DeclaredOnly -notcontains $_.name } | ForEach-Object { $_.name })) | Sort-Object -Unique
Push-Location $Root
try { $registered = & pwsh -NoProfile -NonInteractive -File (Join-Path $Root 'scripts/e2e/suiterun.ps1') actions --json | ConvertFrom-Json } finally { Pop-Location }
$got = @($registered) | Sort-Object -Unique
Assert ((Compare-Object $want $got).Count -eq 0) "PowerShell registers the core plus its catalog actions: want [$($want -join ', ')], got [$($got -join ', ')]"

"Catalog checks passed: $($script:checks) checks over $($names.Count) workspace actions and $($core.actions.Count) core actions."
