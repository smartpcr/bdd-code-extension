# The name filter, run progress and the run observer (spec/README.md,
# spec/progress.md; docs/packages, D6). Dot-sourced by BddSuite.psm1.
#
# A run of many lab suites takes hours, and the people and tools watching it
# need to know which case is running and how the finished ones went before the
# report is written at the end. `run --progress` prints lines in the shape TAEF's
# console output has, because existing lab tooling already parses it:
#
#       suite-setup   step 1 (core.record) passed
#   StartGroup: orders::place-an-order
#       step          when the order is placed (shop.order) passed
#   EndGroup: orders::place-an-order [Passed] (3s)
#   Summary: Total=1, Passed=1, Failed=0, Blocked=0, Not Run=0, Skipped=0
#
# An observer is a hashtable of three script blocks, CaseStarted ($Suite,
# $CaseName), CaseFinished ($Suite, $Result) and Entry ($Entry): it sees the run
# and cannot change it. Only cases the tag and name filters select are reported,
# and a dry run reports none.

function Test-SuiteNameMatch {
    <#
    .SYNOPSIS
        Whether a case name matches any --name glob; none matches every case.
    .DESCRIPTION
        The glob --path takes: * for any run of characters, ? for one, over the
        whole name, case-sensitive. Not -like, which also reads [ and ] as a
        pattern, and outline row names hold brackets.
    #>
    [CmdletBinding()]
    param([string]$Name, [string[]]$Pattern = @())
    $patterns = @($Pattern | Where-Object { $_ })
    if (-not $patterns.Count) { return $true }
    foreach ($glob in $patterns) {
        $regex = '^' + ([regex]::Escape($glob) -replace '\\\*', '.*' -replace '\\\?', '.') + '$'
        if ([regex]::IsMatch($Name, $regex)) { return $true }
    }
    return $false
}

$script:DefaultProgressWriter = {
    param([string]$Line)
    [Console]::Out.WriteLine($Line)
    [Console]::Out.Flush()
}
$script:ProgressWriter = $script:DefaultProgressWriter

function Set-BddSuiteProgressWriter {
    <#
    .SYNOPSIS
        Point the progress lines at a script block taking one line; none for
        standard output again. Returns the writer set before.
    #>
    [CmdletBinding()]
    param([scriptblock]$Writer)
    $before = $script:ProgressWriter
    $script:ProgressWriter = if ($Writer) { $Writer } else { $script:DefaultProgressWriter }
    return $before
}

function Write-BddSuiteProgress {
    param([string]$Line)
    & $script:ProgressWriter $Line
}

$script:ProgressCounts = @{ Passed = 0; Failed = 0; Skipped = 0 }

function New-BddSuiteProgressPrinter {
    <#
    .SYNOPSIS
        The observer behind run --progress, its counts reset; Summary prints
        the closing line, which the tooling reads as authoritative.
    #>
    [CmdletBinding()]
    param()
    $script:ProgressCounts = @{ Passed = 0; Failed = 0; Skipped = 0 }
    return @{
        CaseStarted  = { param([string]$Suite, [string]$CaseName) Write-BddSuiteProgress "StartGroup: ${Suite}::$CaseName" }
        CaseFinished = {
            param([string]$Suite, $Result)
            $verdict = switch ([string]$Result.status) { 'passed' { 'Passed' } 'skipped' { 'Skipped' } default { 'Failed' } }
            $script:ProgressCounts[$verdict]++
            if ($verdict -eq 'Failed' -and $Result.message) {
                Write-BddSuiteProgress ('    failure: ' + ([string]$Result.message -replace "`r`n|`r|`n", ' '))
            }
            # Rounded half away from zero, as the other runtimes round.
            $seconds = [Math]::Round([double]$Result.durationSec, [MidpointRounding]::AwayFromZero)
            Write-BddSuiteProgress ("EndGroup: ${Suite}::$($Result.name) [$verdict] (${seconds}s)")
        }
        Entry        = {
            param($Entry)
            if ($Entry.phase -eq 'case') { return }
            $step = [string]$Entry['step']
            $action = [string]$Entry['action']
            # A step label written with a Gherkin keyword already ends in "(action)".
            $shown = if ($action -and -not $step.Contains("($action)")) { " ($action)" } else { '' }
            $reason = if ($Entry['reason']) { " [$($Entry['reason'])]" } else { '' }
            Write-BddSuiteProgress ('    {0,-13} {1}{2} {3}{4}' -f $Entry.phase, $step, $shown, $Entry.status, $reason)
        }
        Summary      = {
            $c = $script:ProgressCounts
            Write-BddSuiteProgress "Summary: Total=$($c.Passed + $c.Failed + $c.Skipped), Passed=$($c.Passed), Failed=$($c.Failed), Blocked=0, Not Run=0, Skipped=$($c.Skipped)"
        }
    }
}
