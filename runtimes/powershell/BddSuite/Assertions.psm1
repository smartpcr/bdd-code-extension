<#
.SYNOPSIS
    One comparer, implementing the operator table exactly.

.DESCRIPTION
    Y2.7 / DEC-Y20. Four implementations of "contains" is where conformance dies
    quietly: PowerShell's -contains, -like and -match are case-insensitive by
    default and Go, Rust and C# are not. So every operator's coercion and its
    case sensitivity are written here, once, and the table is what the other
    three bindings are held to.

    Where today's PowerShell behaviour is case-insensitive the table keeps it,
    because changing it would silently change what the suites in the tree
    assert. What does change is the failures: a non-numeric operand to gt, gte,
    lt or lte fails with a type message rather than silently comparing zero.
#>

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'Expression.psm1') -DisableNameChecking

# Constructs no two of the four bindings' regular expression engines agree on.
# The linter refuses them as E308; this is the same list, so a pattern that
# reaches the comparer has already been checked against it.
$script:UnportableRegex = '\(\?=|\(\?!|\(\?<=|\(\?<!|\\[1-9]'

function Get-SuiteAssertionOperator {
    <#
    .SYNOPSIS
        Every operator the comparer implements, which the reference renders and
        a test compares against the schema.
    #>
    [CmdletBinding()]
    param()
    return @('equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches',
        'in', 'gt', 'gte', 'lt', 'lte', 'count', 'isTrue', 'isFalse', 'isNull', 'isNotNull', 'script')
}

function ConvertTo-AssertionNumber {
    <#
    .SYNOPSIS
        A 64-bit float, or a failure that says which side was not a number.
    #>
    [CmdletBinding()]
    param([object]$Value, [string]$Side, [string]$Operator)

    $number = 0.0
    if ($null -ne $Value -and [double]::TryParse([string]$Value, [ref]$number)) { return $number }
    throw "$Operator compares numbers, and the $Side is '$Value', which is not one."
}

function Test-SuiteComparison {
    <#
    .SYNOPSIS
        One operator against one actual value. True or false, or a throw when
        the operands cannot be compared at all.
    .DESCRIPTION
        Every cell of DEC-Y20's table, in the order that table lists them.
    #>
    [CmdletBinding()]
    param([string]$Operator, [object]$Actual, [object]$Expected, [bool]$Present = $true)

    switch ($Operator) {
        'equals' { return ([string]$Actual -eq [string]$Expected) }
        'notEquals' { return ([string]$Actual -ne [string]$Expected) }
        'contains' {
            if ($Actual -isnot [string] -and $Actual -is [System.Collections.IEnumerable]) {
                return (@($Actual) -contains $Expected)
            }
            return ([string]$Actual).IndexOf([string]$Expected, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }
        'notContains' { return -not (Test-SuiteComparison -Operator 'contains' -Actual $Actual -Expected $Expected) }
        'startsWith' { return ([string]$Actual).StartsWith([string]$Expected, [StringComparison]::OrdinalIgnoreCase) }
        'endsWith' { return ([string]$Actual).EndsWith([string]$Expected, [StringComparison]::OrdinalIgnoreCase) }
        'matches' {
            if ([string]$Expected -match $script:UnportableRegex) {
                # Coded, and with the same code the validator reports for the
                # same pattern. A rule that is E308 before the run and an
                # uncoded sentence during it is two rules.
                throw "E308: the pattern '$Expected' uses a construct outside the subset the four bindings share."
            }
            return ([string]$Actual -match [string]$Expected)
        }
        'in' {
            if ($Expected -is [string] -or $Expected -isnot [System.Collections.IEnumerable]) {
                throw "in takes a list, and '$Expected' is not one."
            }
            foreach ($candidate in @($Expected)) {
                if ([string]$Actual -eq [string]$candidate) { return $true }
            }
            return $false
        }
        'gt' { return (ConvertTo-AssertionNumber $Actual 'subject' 'gt') -gt (ConvertTo-AssertionNumber $Expected 'expected value' 'gt') }
        'gte' { return (ConvertTo-AssertionNumber $Actual 'subject' 'gte') -ge (ConvertTo-AssertionNumber $Expected 'expected value' 'gte') }
        'lt' { return (ConvertTo-AssertionNumber $Actual 'subject' 'lt') -lt (ConvertTo-AssertionNumber $Expected 'expected value' 'lt') }
        'lte' { return (ConvertTo-AssertionNumber $Actual 'subject' 'lte') -le (ConvertTo-AssertionNumber $Expected 'expected value' 'lte') }
        'count' {
            if ($Actual -is [string] -or $Actual -isnot [System.Collections.IEnumerable]) {
                throw "count takes a list, and the subject is '$Actual', which is not one."
            }
            return (@($Actual).Count -eq [int](ConvertTo-AssertionNumber $Expected 'expected value' 'count'))
        }
        'isTrue' { return ($Actual -is [bool] -and $Actual -eq $true) -eq [bool]$Expected }
        'isFalse' { return ($Actual -is [bool] -and $Actual -eq $false) -eq [bool]$Expected }
        'isNull' { return ((-not $Present) -or $null -eq $Actual) -eq [bool]$Expected }
        'isNotNull' { return ($Present -and $null -ne $Actual) -eq [bool]$Expected }
        default { throw "Unknown assertion: $Operator" }
    }
}

function Format-AssertionFailure {
    <#
    .SYNOPSIS
        What a failed assertion says: the subject, the operator, what was
        expected and what was there.
    #>
    [CmdletBinding()]
    param([string]$Subject, [string]$Operator, [object]$Expected, [object]$Actual, [bool]$Present = $true)

    $shown = if (-not $Present) { '(absent)' }
    elseif ($null -eq $Actual) { '(null)' }
    elseif ($Actual -isnot [string] -and $Actual -is [System.Collections.IEnumerable]) { '[' + ((@($Actual) | ForEach-Object { [string]$_ }) -join ', ') + ']' }
    else { [string]$Actual }
    $wanted = if ($Expected -isnot [string] -and $Expected -is [System.Collections.IEnumerable]) { '[' + ((@($Expected) | ForEach-Object { [string]$_ }) -join ', ') + ']' }
    else { [string]$Expected }
    switch ($Operator) {
        'isTrue' { return "expected $Subject to be true, got '$shown'" }
        'isFalse' { return "expected $Subject to be false, got '$shown'" }
        'isNull' { return "expected $Subject to be absent or null, got '$shown'" }
        'isNotNull' { return "expected $Subject to be present, got '$shown'" }
        'count' { return "expected $Subject to have $wanted entries, got '$shown'" }
        default { return "expected $Subject $Operator '$wanted', got '$shown'" }
    }
}

Export-ModuleMember -Function Get-SuiteAssertionOperator, Test-SuiteComparison, Format-AssertionFailure,
ConvertTo-AssertionNumber
