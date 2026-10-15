<#
.SYNOPSIS
    The one expression language a suite is written in.

.DESCRIPTION
    Y2.6 / DEC-Y19. Everything between `${` and `}` is an expression in this
    language, and there is no second syntax for a calculated value: a bare dotted
    path is the simplest expression, and the same grammar covers
    `${len(capture.cs.Nodes)}`.

    A tokeniser and a Pratt parser rather than a regular expression, because the
    thing being parsed has precedence. The function list is closed: four bindings
    have to agree on every corner of this, and an open list drifts to whatever
    each language's standard library happens to call things.

    Two rules carry over from the runner this replaces, and they are what keep
    every suite in the tree meaning what it meant:

      * a string that is exactly one expression yields that value with its type
        intact, so `timeoutSec: ${var.deadline}` is a number and
        `commands: ${capture.list}` is a list;
      * a string with an expression inside other text is substituted textually.

    Errors carry the diagnostic codes: `E305` for a syntax error, `E306` for an
    unknown function with the nearest suggested, `E307` for a wrong argument
    count or type, `E301` for a path that resolves to nothing.
#>

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

# The closed function list (design 5.9). Each entry says how many arguments it
# takes, as a minimum and a maximum, and whether its value depends on something
# outside the suite.
$script:ExpressionFunctions = [ordered]@{
    'lower'      = @{ min = 1; max = 1 }
    'upper'      = @{ min = 1; max = 1 }
    'trim'       = @{ min = 1; max = 1 }
    'replace'    = @{ min = 3; max = 3 }
    'format'     = @{ min = 1; max = 99 }
    'split'      = @{ min = 2; max = 2 }
    'join'       = @{ min = 2; max = 2 }
    'startsWith' = @{ min = 2; max = 2 }
    'endsWith'   = @{ min = 2; max = 2 }
    'contains'   = @{ min = 2; max = 2 }
    'len'        = @{ min = 1; max = 1 }
    'first'      = @{ min = 1; max = 1 }
    'last'       = @{ min = 1; max = 1 }
    'int'        = @{ min = 1; max = 1 }
    'float'      = @{ min = 1; max = 1 }
    'str'        = @{ min = 1; max = 1 }
    'bool'       = @{ min = 1; max = 1 }
    'default'    = @{ min = 2; max = 2 }
    'env'        = @{ min = 1; max = 1; deterministic = $false }
    'uuid'       = @{ min = 0; max = 0; deterministic = $false }
    'nowIso'     = @{ min = 0; max = 0; deterministic = $false }
}

# Where a path may start when the scope names no roots of its own. A runtime
# extension adds context keys (DEC-S03), and the runner then gives the scope a
# `__roots` entry: these six followed by every extension's keys. Anything else
# is E301.
$script:CoreRoots = @('capture', 'param', 'var', 'row', 'timeoutSec', 'defaults')

function Get-ExpressionRoot {
    <#
    .SYNOPSIS
        The roots a path may start at in one scope: its `__roots` entry, or the
        core's six when it has none.
    #>
    [CmdletBinding()]
    param([System.Collections.IDictionary]$Scope)
    if ($null -ne $Scope -and $Scope.Contains('__roots') -and $null -ne $Scope['__roots']) { return @($Scope['__roots']) }
    return $script:CoreRoots
}

function Get-ExpressionFunctionName {
    <#
    .SYNOPSIS
        Every function this language has, for a suggestion and for the reference.
    #>
    [CmdletBinding()]
    param()
    return @($script:ExpressionFunctions.Keys)
}

function New-ExpressionError {
    <#
    .SYNOPSIS
        One failure, carrying the diagnostic code it would be reported as.
    #>
    [CmdletBinding()]
    param([string]$Code, [string]$Message)
    return [Management.Automation.ErrorRecord]::new(
        [Exception]::new("${Code}: $Message"), $Code, [Management.Automation.ErrorCategory]::InvalidData, $null)
}

function ConvertTo-ExpressionToken {
    <#
    .SYNOPSIS
        Split an expression into tokens.
    .DESCRIPTION
        Numbers, single or double quoted strings, names, and the operators the
        grammar names. Anything else is E305 at the character it stopped on,
        because "unexpected token" without the token sends the author to guess.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)

    $tokens = [Collections.Generic.List[hashtable]]::new()
    $index = 0
    while ($index -lt $Text.Length) {
        $char = $Text[$index]
        if ([char]::IsWhiteSpace($char)) { $index++; continue }

        if ([char]::IsDigit($char)) {
            # A dot belongs to the number only when a digit follows it. Without
            # that rule `capture.run.sessionResults.0.value` reads as the number
            # "0." and stops, and an index into a captured list is common.
            $start = $index
            while ($index -lt $Text.Length -and [char]::IsDigit($Text[$index])) { $index++ }
            if ($index + 1 -lt $Text.Length -and $Text[$index] -eq '.' -and [char]::IsDigit($Text[$index + 1])) {
                $index++
                while ($index -lt $Text.Length -and [char]::IsDigit($Text[$index])) { $index++ }
            }
            $raw = $Text.Substring($start, $index - $start)
            $value = if ($raw.Contains('.')) { [double]$raw } else { [int64]$raw }
            $tokens.Add(@{ kind = 'literal'; value = $value })
            continue
        }
        if ($char -eq "'" -or $char -eq '"') {
            $quote = $char
            $index++
            $start = $index
            while ($index -lt $Text.Length -and $Text[$index] -ne $quote) { $index++ }
            if ($index -ge $Text.Length) { throw (New-ExpressionError 'E305' "a string that opens with $quote is never closed") }
            $tokens.Add(@{ kind = 'literal'; value = $Text.Substring($start, $index - $start) })
            $index++
            continue
        }
        if ([char]::IsLetter($char) -or $char -eq '_') {
            $start = $index
            while ($index -lt $Text.Length -and ([char]::IsLetterOrDigit($Text[$index]) -or $Text[$index] -eq '_')) { $index++ }
            $tokens.Add(@{ kind = 'name'; value = $Text.Substring($start, $index - $start) })
            continue
        }
        $two = if ($index + 1 -lt $Text.Length) { $Text.Substring($index, 2) } else { '' }
        if ($two -in @('==', '!=', '<=', '>=')) {
            $tokens.Add(@{ kind = 'operator'; value = $two }); $index += 2; continue
        }
        if ($char -in @('+', '-', '*', '/', '%', '<', '>', '(', ')', ',', '.', '?', ':')) {
            $tokens.Add(@{ kind = 'operator'; value = [string]$char }); $index++; continue
        }
        throw (New-ExpressionError 'E305' "'$char' is not part of this language, at position $index of '$Text'")
    }
    $tokens.Add(@{ kind = 'end'; value = '' })
    return $tokens.ToArray()
}

function Resolve-ExpressionPath {
    <#
    .SYNOPSIS
        Walk a dotted path from one of the declared roots.
    .DESCRIPTION
        A numeric segment indexes a list. A path that leaves the model is E301
        rather than an empty string, which is the difference between a suite that
        refuses to start and one that suspends a node called nothing.
    #>
    [CmdletBinding()]
    param([string[]]$Segments, [hashtable]$Scope, [string]$Text)

    if ($script:SyntaxOnly -or $script:SkipEvaluation) { return , 1 }
    $root = $Segments[0]
    $roots = Get-ExpressionRoot -Scope $Scope
    if ($roots -cnotcontains $root) {
        throw (New-ExpressionError 'E301' "`${$Text} resolves to nothing. A path starts at $(@($roots) -join ', ').")
    }
    $current = $Scope
    foreach ($segment in $Segments) {
        if ($null -eq $current) { throw (New-ExpressionError 'E301' "`${$Text} resolves to nothing.") }
        if ($current -isnot [string] -and $current -is [System.Collections.IList] -and $segment -match '^\d+$') {
            $position = [int]$segment
            if ($position -ge $current.Count) { throw (New-ExpressionError 'E301' "`${$Text} resolves to nothing: the list has $($current.Count) entries.") }
            $current = $current[$position]
            continue
        }
        if ($current -is [System.Collections.IDictionary]) {
            if (-not $current.Contains($segment)) { throw (New-ExpressionError 'E301' "`${$Text} resolves to nothing: no $segment there.") }
            $current = $current[$segment]
            continue
        }
        $property = $current.PSObject.Properties[$segment]
        if (-not $property) { throw (New-ExpressionError 'E301' "`${$Text} resolves to nothing: no $segment there.") }
        $current = $property.Value
    }
    return , $current
}

function Invoke-ExpressionFunction {
    <#
    .SYNOPSIS
        Call one function of the closed list.
    .DESCRIPTION
        Every coercion is written here rather than left to PowerShell's, because
        three other bindings implement the same table and PowerShell's defaults
        are not theirs.
    #>
    [CmdletBinding()]
    param([string]$Name, [object[]]$Arguments, [bool]$AllowNonDeterministic = $true)

    # Case-sensitively. An ordered dictionary matches a key whatever its case,
    # which would make `LOWER` legal here and a refusal in the three bindings
    # whose maps are case-sensitive. The roots and the keywords are already
    # compared this way; this was the one place that was not.
    if (@($script:ExpressionFunctions.Keys) -cnotcontains $Name) {
        $nearest = @($script:ExpressionFunctions.Keys | Where-Object { $_.ToLowerInvariant().StartsWith($Name.Substring(0, [math]::Min(2, $Name.Length)).ToLowerInvariant()) })
        $suggestion = if ($nearest.Count) { " Did you mean $($nearest[0])?" } else { '' }
        throw (New-ExpressionError 'E306' "there is no function called $Name.$suggestion")
    }
    $declared = $script:ExpressionFunctions[$Name]
    if ($Arguments.Count -lt $declared.min -or $Arguments.Count -gt $declared.max) {
        $expected = if ($declared.min -eq $declared.max) { "$($declared.min)" } else { "$($declared.min) to $($declared.max)" }
        throw (New-ExpressionError 'E307' "$Name takes $expected argument(s), not $($Arguments.Count)")
    }
    if ($declared.ContainsKey('deterministic') -and -not $declared.deterministic -and -not $AllowNonDeterministic) {
        throw (New-ExpressionError 'E309' "$Name is not deterministic, and this value has to be stable")
    }
    # Checked, not run: without a real value underneath it, what a function
    # would return says nothing.
    if ($script:SyntaxOnly -or $script:SkipEvaluation) { return , 1 }

    switch ($Name) {
        'lower' { return ([string]$Arguments[0]).ToLowerInvariant() }
        'upper' { return ([string]$Arguments[0]).ToUpperInvariant() }
        'trim' { return ([string]$Arguments[0]).Trim() }
        'replace' { return ([string]$Arguments[0]).Replace([string]$Arguments[1], [string]$Arguments[2]) }
        'format' {
            if ($Arguments.Count -eq 1) { return [string]$Arguments[0] }
            return [string]::Format([string]$Arguments[0], @($Arguments[1..($Arguments.Count - 1)]))
        }
        'split' { return , @(([string]$Arguments[0]).Split([string]$Arguments[1])) }
        'join' {
            if ($Arguments[0] -is [string] -or $Arguments[0] -isnot [System.Collections.IEnumerable]) {
                throw (New-ExpressionError 'E307' 'join takes a list and a separator')
            }
            return (@($Arguments[0]) -join [string]$Arguments[1])
        }
        'startsWith' { return ([string]$Arguments[0]).StartsWith([string]$Arguments[1], [StringComparison]::OrdinalIgnoreCase) }
        'endsWith' { return ([string]$Arguments[0]).EndsWith([string]$Arguments[1], [StringComparison]::OrdinalIgnoreCase) }
        'contains' {
            if ($Arguments[0] -isnot [string] -and $Arguments[0] -is [System.Collections.IEnumerable]) {
                return (@($Arguments[0]) -contains $Arguments[1])
            }
            return ([string]$Arguments[0]).IndexOf([string]$Arguments[1], [StringComparison]::OrdinalIgnoreCase) -ge 0
        }
        'len' {
            if ($null -eq $Arguments[0]) { return [int64]0 }
            if ($Arguments[0] -is [string]) { return [int64]([string]$Arguments[0]).Length }
            if ($Arguments[0] -is [System.Collections.ICollection]) { return [int64]@($Arguments[0]).Count }
            throw (New-ExpressionError 'E307' 'len takes a string or a list')
        }
        'first' {
            $list = @($Arguments[0])
            if (-not $list.Count) { throw (New-ExpressionError 'E307' 'first takes a list with something in it') }
            return $list[0]
        }
        'last' {
            $list = @($Arguments[0])
            if (-not $list.Count) { throw (New-ExpressionError 'E307' 'last takes a list with something in it') }
            return $list[-1]
        }
        'int' {
            $parsed = 0L
            if (-not [long]::TryParse([string]$Arguments[0], [ref]$parsed)) {
                $asDouble = 0.0
                if (-not [double]::TryParse([string]$Arguments[0], [ref]$asDouble)) {
                    throw (New-ExpressionError 'E307' "int cannot read '$($Arguments[0])' as a number")
                }
                return [int64][math]::Truncate($asDouble)
            }
            return $parsed
        }
        'float' {
            $parsed = 0.0
            if (-not [double]::TryParse([string]$Arguments[0], [ref]$parsed)) {
                throw (New-ExpressionError 'E307' "float cannot read '$($Arguments[0])' as a number")
            }
            return $parsed
        }
        'str' {
            # A boolean comes out lowercase. `[string]$true` is 'True' in this
            # language and in none of the other three, and the substitution rule
            # a few lines below already lowercases a boolean on its way into a
            # string. Y4.4's table found the two disagreeing with each other.
            if ($Arguments[0] -is [bool]) { return ([string]$Arguments[0]).ToLowerInvariant() }
            return [string]$Arguments[0]
        }
        'bool' {
            $value = $Arguments[0]
            if ($value -is [bool]) { return $value }
            $text = ([string]$value).Trim().ToLowerInvariant()
            if ($text -in @('true', 'yes', '1')) { return $true }
            if ($text -in @('false', 'no', '0', '')) { return $false }
            throw (New-ExpressionError 'E307' "bool cannot read '$value' as true or false")
        }
        'default' { if ($null -eq $Arguments[0] -or '' -eq [string]$Arguments[0]) { return $Arguments[1] } return $Arguments[0] }
        'env' { return [string][Environment]::GetEnvironmentVariable([string]$Arguments[0]) }
        'uuid' { return [guid]::NewGuid().ToString('N') }
        'nowIso' { return [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ') }
    }
}

function Compare-ExpressionValue {
    <#
    .SYNOPSIS
        One comparison, with the coercion written down.
    .DESCRIPTION
        Numbers compare as numbers; anything else compares as a string, and
        case-insensitively, which is what the suites in the tree were written
        against.
    #>
    [CmdletBinding()]
    param([string]$Operator, [object]$Left, [object]$Right)

    if ($script:SkipEvaluation) { return $true }

    $leftNumber = 0.0
    $rightNumber = 0.0
    $numeric = [double]::TryParse([string]$Left, [ref]$leftNumber) -and [double]::TryParse([string]$Right, [ref]$rightNumber)
    switch ($Operator) {
        '==' { if ($numeric) { return $leftNumber -eq $rightNumber } return ([string]$Left -eq [string]$Right) }
        '!=' { if ($numeric) { return $leftNumber -ne $rightNumber } return ([string]$Left -ne [string]$Right) }
        default {
            if (-not $numeric) { throw (New-ExpressionError 'E307' "$Operator compares numbers, and '$Left' or '$Right' is not one") }
            switch ($Operator) {
                '<' { return $leftNumber -lt $rightNumber }
                '<=' { return $leftNumber -le $rightNumber }
                '>' { return $leftNumber -gt $rightNumber }
                '>=' { return $leftNumber -ge $rightNumber }
            }
        }
    }
}

function Invoke-ExpressionOperator {
    <#
    .SYNOPSIS
        The arithmetic and the string `+`.
    #>
    [CmdletBinding()]
    param([string]$Operator, [object]$Left, [object]$Right)

    if ($script:SkipEvaluation) { return , 1 }

    $leftNumber = 0.0
    $rightNumber = 0.0
    $numeric = [double]::TryParse([string]$Left, [ref]$leftNumber) -and [double]::TryParse([string]$Right, [ref]$rightNumber)
    if ($Operator -eq '+' -and -not $numeric) { return ([string]$Left + [string]$Right) }
    if (-not $numeric) { throw (New-ExpressionError 'E307' "$Operator takes numbers, and '$Left' or '$Right' is not one") }
    $whole = ($Left -isnot [double]) -and ($Right -isnot [double]) -and
             ([string]$Left -notmatch '\.') -and ([string]$Right -notmatch '\.')
    switch ($Operator) {
        '+' { $value = $leftNumber + $rightNumber }
        '-' { $value = $leftNumber - $rightNumber }
        '*' { $value = $leftNumber * $rightNumber }
        '/' {
            if ($rightNumber -eq 0) { throw (New-ExpressionError 'E307' 'division by zero') }
            $value = $leftNumber / $rightNumber
            # Division yields a whole number only when it divides exactly, so
            # 7 / 2 is 3.5 rather than 3 in one binding and 4 in another.
            $whole = $whole -and ($value -eq [math]::Truncate($value))
        }
        '%' {
            if ($rightNumber -eq 0) { throw (New-ExpressionError 'E307' 'division by zero') }
            $value = $leftNumber % $rightNumber
        }
    }
    if ($whole) { return [int64]$value }
    return $value
}

function Invoke-SuiteExpression {
    <#
    .SYNOPSIS
        Evaluate one expression against a scope, and return its value with its
        type.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text,
        [hashtable]$Scope = @{},
        [bool]$AllowNonDeterministic = $true,
        [switch]$SyntaxOnly
    )

    $script:SyntaxOnly = [bool]$SyntaxOnly
    $script:SkipEvaluation = $false
    $script:Tokens = ConvertTo-ExpressionToken -Text $Text
    $script:Position = 0
    $script:Scope = $Scope
    $script:Source = $Text
    $script:AllowNonDeterministic = $AllowNonDeterministic
    $value = Read-Ternary
    if ((Peek).kind -ne 'end') { throw (New-ExpressionError 'E305' "'$((Peek).value)' is left over at the end of '$Text'") }
    return , $value
}

function Peek { return $script:Tokens[$script:Position] }
function Read-Token { $token = $script:Tokens[$script:Position]; $script:Position++; return $token }
function Test-Operator {
    param([string[]]$Values)
    $token = Peek
    if ($token.kind -eq 'operator' -and $Values -ccontains $token.value) { return $true }
    if ($token.kind -eq 'name' -and $Values -ccontains $token.value) { return $true }
    return $false
}

function Read-Ternary {
    $condition = Read-Or
    if (Test-Operator @('?')) {
        $null = Read-Token
        $previousSkip = $script:SkipEvaluation
        $taken = if ($script:SyntaxOnly -or $previousSkip) { $true } elseif ($condition -is [bool]) { $condition } else { Invoke-ExpressionFunction -Name 'bool' -Arguments @($condition) }
        try {
            $script:SkipEvaluation = $previousSkip -or (-not $script:SyntaxOnly -and -not $taken)
            $whenTrue = Read-Ternary
            if (-not (Test-Operator @(':'))) { throw (New-ExpressionError 'E305' "a ? needs a : after it, in '$($script:Source)'") }
            $null = Read-Token
            $script:SkipEvaluation = $previousSkip -or (-not $script:SyntaxOnly -and $taken)
            $whenFalse = Read-Ternary
        } finally { $script:SkipEvaluation = $previousSkip }
        return , $(if ($taken) { $whenTrue } else { $whenFalse })
    }
    return , $condition
}

function Read-Or {
    $left = Read-And
    while (Test-Operator @('or')) {
        $null = Read-Token
        $right = Read-And
        $left = (Invoke-ExpressionFunction -Name 'bool' -Arguments @($left)) -or (Invoke-ExpressionFunction -Name 'bool' -Arguments @($right))
    }
    return , $left
}

function Read-And {
    $left = Read-Not
    while (Test-Operator @('and')) {
        $null = Read-Token
        $right = Read-Not
        $left = (Invoke-ExpressionFunction -Name 'bool' -Arguments @($left)) -and (Invoke-ExpressionFunction -Name 'bool' -Arguments @($right))
    }
    return , $left
}

function Read-Not {
    if (Test-Operator @('not')) {
        $null = Read-Token
        return , (-not (Invoke-ExpressionFunction -Name 'bool' -Arguments @((Read-Not))))
    }
    return , (Read-Comparison)
}

function Read-Comparison {
    $left = Read-Sum
    if (Test-Operator @('==', '!=', '<', '<=', '>', '>=')) {
        $operator = (Read-Token).value
        return , (Compare-ExpressionValue -Operator $operator -Left $left -Right (Read-Sum))
    }
    return , $left
}

function Read-Sum {
    $left = Read-Product
    while (Test-Operator @('+', '-')) {
        $operator = (Read-Token).value
        $left = Invoke-ExpressionOperator -Operator $operator -Left $left -Right (Read-Product)
    }
    return , $left
}

function Read-Product {
    $left = Read-Unary
    while (Test-Operator @('*', '/', '%')) {
        $operator = (Read-Token).value
        $left = Invoke-ExpressionOperator -Operator $operator -Left $left -Right (Read-Unary)
    }
    return , $left
}

function Read-Unary {
    if (Test-Operator @('-')) {
        $null = Read-Token
        return , (Invoke-ExpressionOperator -Operator '-' -Left 0 -Right (Read-Unary))
    }
    return , (Read-Primary)
}

function Read-Primary {
    $token = Read-Token
    if ($token.kind -eq 'literal') { return , $token.value }
    if ($token.kind -eq 'operator' -and $token.value -eq '(') {
        $value = Read-Ternary
        if (-not (Test-Operator @(')'))) { throw (New-ExpressionError 'E305' "a ( is never closed, in '$($script:Source)'") }
        $null = Read-Token
        return , $value
    }
    if ($token.kind -ne 'name') { throw (New-ExpressionError 'E305' "'$($token.value)' cannot start a value, in '$($script:Source)'") }

    if ($token.value -in @('true', 'false')) { return , ($token.value -eq 'true') }
    if ($token.value -eq 'null') { return , $null }

    # A name followed by ( is a call; anything else is a path.
    if (Test-Operator @('(')) {
        $null = Read-Token
        $arguments = [Collections.Generic.List[object]]::new()
        if (-not (Test-Operator @(')'))) {
            while ($true) {
                $arguments.Add((Read-Ternary))
                if (Test-Operator @(',')) { $null = Read-Token; continue }
                break
            }
        }
        if (-not (Test-Operator @(')'))) { throw (New-ExpressionError 'E305' "a call to $($token.value) is never closed, in '$($script:Source)'") }
        $null = Read-Token
        return , (Invoke-ExpressionFunction -Name $token.value -Arguments $arguments.ToArray() -AllowNonDeterministic $script:AllowNonDeterministic)
    }

    $segments = [Collections.Generic.List[string]]::new()
    $segments.Add($token.value)
    while (Test-Operator @('.')) {
        $null = Read-Token
        $next = Read-Token
        if ($next.kind -ne 'name' -and $next.kind -ne 'literal') { throw (New-ExpressionError 'E305' "a . needs a name after it, in '$($script:Source)'") }
        $segments.Add([string]$next.value)
    }
    return , (Resolve-ExpressionPath -Segments $segments.ToArray() -Scope $script:Scope -Text ($segments -join '.'))
}

function Expand-SuiteExpression {
    <#
    .SYNOPSIS
        Substitute every ${...} in one value, recursively.
    .DESCRIPTION
        The two rules from DEC-Y19: a string that is exactly one expression
        yields that expression's value with its type intact; a string with an
        expression inside other text is substituted into and stays a string.
    #>
    [CmdletBinding()]
    param([object]$Value, [hashtable]$Scope = @{}, [bool]$AllowNonDeterministic = $true)

    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) {
        $whole = [regex]::Match($Value, '^\$\{(.+)\}$')
        if ($whole.Success -and -not $whole.Groups[1].Value.Contains('${')) {
            return , (Invoke-SuiteExpression -Text $whole.Groups[1].Value -Scope $Scope -AllowNonDeterministic $AllowNonDeterministic)
        }
        # Unwrapped, because Replace calls the evaluator through a delegate and
        # a failure comes back as 'Exception calling "Replace"' wrapped around
        # the diagnostic. The code is the first thing in the message and the
        # whole contract depends on it being readable there.
        try {
            return [regex]::Replace($Value, '\$\{([^{}]+)\}', {
                    param($match)
                    $result = Invoke-SuiteExpression -Text $match.Groups[1].Value -Scope $Scope -AllowNonDeterministic $AllowNonDeterministic
                    if ($result -is [bool]) { return ([string]$result).ToLowerInvariant() }
                    return [string]$result
                })
        } catch {
            $inner = $_.Exception
            while ($inner.InnerException -and $inner -is [Management.Automation.MethodInvocationException]) { $inner = $inner.InnerException }
            throw $inner
        }
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $expanded = @{}
        foreach ($key in $Value.Keys) { $expanded[$key] = Expand-SuiteExpression -Value $Value[$key] -Scope $Scope -AllowNonDeterministic $AllowNonDeterministic }
        return $expanded
    }
    if ($Value -isnot [string] -and $Value -is [System.Collections.IEnumerable]) {
        return , @($Value | ForEach-Object { Expand-SuiteExpression -Value $_ -Scope $Scope -AllowNonDeterministic $AllowNonDeterministic })
    }
    return $Value
}

Export-ModuleMember -Function Invoke-SuiteExpression, Expand-SuiteExpression, Get-ExpressionFunctionName, Get-ExpressionRoot,
ConvertTo-ExpressionToken, Resolve-ExpressionPath, Invoke-ExpressionFunction, Compare-ExpressionValue,
Invoke-ExpressionOperator
