<#
.SYNOPSIS
    Runs the Y1.3 catalog checks of scripts/e2e/SuiteLint.Tests.ps1 against a
    checkout, read from that file at run time, without its action-count line.

.DESCRIPTION
    E-B6 asks for SuiteLint.Tests.ps1 to pass after an action is declared. Two
    things in os-context stop the whole file from passing: it fails before any
    edit on PowerShell 7.6.7 (Test-Json, recorded in stage B2), and it asserts
    a literal count of declared actions that any new action changes. This runs
    the part that guards a declaration - the catalog and the registry are the
    same set, the catalog validates against its schema, every entry has a
    summary, a binding, a capture shape and the right interruptible flag -
    using the repository's own lines. It prints the count line it left out.
    It reads the checkout and writes nothing.
#>
param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference = 'Stop'
$script:checks = 0
function Assert([bool]$Condition, [string]$Message) {
    $script:checks++
    if (-not $Condition) { throw "FAIL: $Message" }
}

Import-Module powershell-yaml -ErrorAction Stop
. (Join-Path $Root 'scripts/e2e/actions/ActionRegistry.ps1')
$schemaRoot = Join-Path $Root 'test/e2e/schema'

$text = Get-Content -LiteralPath (Join-Path $Root 'scripts/e2e/SuiteLint.Tests.ps1') -Raw
$start = $text.IndexOf('# Y1.3:')
$end = $text.IndexOf('# Y1.1:')
if ($start -lt 0 -or $end -le $start) { throw 'The Y1.3 block was not found in SuiteLint.Tests.ps1.' }
$block = $text.Substring($start, $end - $start)
$countLine = [regex]::Matches($block, '(?m)^\s*Assert \(\$catalogNames\.Count -eq \d+\).*$')
if ($countLine.Count -ne 1) { throw "Expected one action-count line in Y1.3, found $($countLine.Count)." }
$block = $block.Replace($countLine[0].Value, '')
. ([scriptblock]::Create($block))
"Y1.3 passed: $($script:checks) checks over $($catalogNames.Count) actions; left out: $($countLine[0].Value.Trim())"
