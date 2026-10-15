<#
.SYNOPSIS
    Reduce a test report to the form two reports can be compared in.

.DESCRIPTION
    Y3.6. Two runs of one suite produce two reports that differ in when they
    happened, how long they took and which machine they ran on. Comparing them
    as written fails every time, for none of the reasons anybody cares about.

    What is dropped and what is normalised is written down in
    conformance/report/canonicalise.md, because the other runtimes
    implement this from that page rather than from this file. Keep the two
    together: a rule here that is not there is a rule only one binding follows.
#>

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

# When, how long, and on what. None of it is behaviour, and all of it differs
# between two runs of the same suite.
$script:VolatileAttributes = @(
    'start-time', 'end-time', 'duration',
    'time', 'timestamp', 'hostname',
    'id', 'clr-version', 'engine-version'
)

# A stack trace belongs to the host runtime rather than to the suite. It names
# an absolute path and a line number inside the runner, so it changes when a
# comment is added above the throw, and four bindings would produce four
# completely different ones for the same failing assertion.
$script:VolatileElements = @('stack-trace')

# JUnit has no stack-trace element; it puts the same thing in the text of the
# failure, whose message attribute is the part that says what went wrong.
$script:TextlessElements = @('failure')

# What a step captured, which a caller may ask to leave out. A suite that mints
# an identifier - a run id, a timestamp the API assigned - captures a different
# one every time it runs, so two runs of the *same* binding differ there. The
# rest of the report still has to match, and that is what -IgnoreOutput compares.
$script:OutputElements = @('output', 'system-out')
$script:DropOutput = $false

function ConvertTo-SortedJsonLine {
    <#
    .SYNOPSIS
        One line of captured output, with a JSON object's keys put in order.
    .DESCRIPTION
        What a step captured is behaviour; the order a hash map happened to
        enumerate it in is not, and four bindings enumerate in four orders. A
        line that is not a JSON object comes back exactly as it was.
    #>
    [CmdletBinding()]
    param([string]$Line)

    $trimmed = $Line.Trim()
    if (-not $trimmed.StartsWith('{') -or -not $trimmed.EndsWith('}')) { return $Line }
    $parsed = $null
    # Braces at both ends and a successful parse is an object; there is no
    # other JSON value that looks like this.
    try { $parsed = $trimmed | ConvertFrom-Json -AsHashtable } catch { return $Line }
    return (ConvertTo-SortedJsonValue -Value $parsed | ConvertTo-Json -Depth 30 -Compress)
}

function ConvertTo-SortedJsonValue {
    <#
    .SYNOPSIS
        The same value with every object's keys in ascending order. An array
        keeps the order it was written in, because that order is behaviour.
    #>
    [CmdletBinding()]
    param($Value)

    if ($Value -is [System.Collections.IDictionary]) {
        $sorted = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object)) { $sorted[$key] = ConvertTo-SortedJsonValue -Value $Value[$key] }
        return $sorted
    }
    if ($Value -isnot [string] -and $Value -is [System.Collections.IEnumerable]) {
        return , @($Value | ForEach-Object { ConvertTo-SortedJsonValue -Value $_ })
    }
    return $Value
}

function Get-CanonicalReportElement {
    <#
    .SYNOPSIS
        One element and everything under it, as canonical lines.
    .DESCRIPTION
        Recursive rather than a walk with a stack, because a report is four
        levels deep and the recursion reads like the document does.
    #>
    [CmdletBinding()]
    param([System.Xml.XmlElement]$Element, [int]$Depth, [Collections.Generic.List[string]]$Lines)

    $indent = ' ' * (2 * $Depth)
    $parts = [Collections.Generic.List[string]]::new()
    foreach ($attribute in @($Element.get_Attributes() | Sort-Object Name)) {
        if ($script:VolatileAttributes -ccontains $attribute.Name) { continue }
        $value = ([string]$attribute.Value) -replace "`r`n", "`n"
        $parts.Add("$($attribute.Name)=`"$value`"")
    }
    $open = $Element.get_Name()
    if ($parts.Count) { $open = $open + ' ' + ($parts -join ' ') }

    $children = @($Element.get_ChildNodes() | Where-Object {
            $_.NodeType -eq 'Element' -and $script:VolatileElements -cnotcontains $_.get_Name() -and
            -not ($script:DropOutput -and $script:OutputElements -ccontains $_.get_Name())
        })
    $text = ''
    if ($script:TextlessElements -cnotcontains $Element.get_Name() -and
        -not ($script:DropOutput -and $script:OutputElements -ccontains $Element.get_Name())) {
        foreach ($node in @($Element.get_ChildNodes() | Where-Object { $_.NodeType -in 'Text', 'CDATA' })) {
            $text += [string]$node.Value
        }
    }
    # Whitespace-only text is no text. A serialiser that indents its children
    # and one that does not have not written different reports.
    $text = ($text -replace "`r`n", "`n").Trim()
    $text = (@($text -split "`n" | ForEach-Object { ConvertTo-SortedJsonLine -Line $_ }) -join "`n")

    if (-not $children.Count -and -not $text) {
        $Lines.Add("$indent<$open/>")
        return
    }
    if (-not $children.Count) {
        $flat = @($text -split "`n" | ForEach-Object { $_.TrimEnd() })
        if ($flat.Count -eq 1) {
            $Lines.Add("$indent<$open>$($flat[0])</$($Element.get_Name())>")
            return
        }
        $Lines.Add("$indent<$open>")
        foreach ($line in $flat) { $Lines.Add((' ' * (2 * ($Depth + 1))) + $line) }
        $Lines.Add("$indent</$($Element.get_Name())>")
        return
    }
    $Lines.Add("$indent<$open>")
    if ($text) { $Lines.Add((' ' * (2 * ($Depth + 1))) + $text) }
    foreach ($child in $children) { Get-CanonicalReportElement -Element $child -Depth ($Depth + 1) -Lines $Lines }
    $Lines.Add("$indent</$($Element.get_Name())>")
}

function ConvertTo-CanonicalReport {
    <#
    .SYNOPSIS
        A report as the text two reports are compared as.
    .DESCRIPTION
        Takes the document, the XML text, or a path to a file holding it, so a
        caller with any of the three does not have to convert first.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$Report, [switch]$IgnoreOutput)

    $document = $null
    if ($Report -is [xml]) { $document = $Report }
    elseif ($Report -is [string] -and $Report.TrimStart().StartsWith('<')) { $document = [xml]$Report }
    elseif ($Report -is [string]) { $document = [xml](Get-Content -LiteralPath $Report -Raw) }
    else { throw 'A report is an XmlDocument, its text, or the path to a file holding it.' }

    $script:DropOutput = [bool]$IgnoreOutput
    try {
        $lines = [Collections.Generic.List[string]]::new()
        Get-CanonicalReportElement -Element $document.DocumentElement -Depth 0 -Lines $lines
        return (($lines -join "`n") + "`n")
    } finally { $script:DropOutput = $false }
}

function Get-FirstReportDifference {
    <#
    .SYNOPSIS
        The first line two canonical documents differ on, or nothing when they
        do not differ at all.
    .DESCRIPTION
        Text in and text out, so that the comparison can be tested with two
        documents rather than only with two reports. One document running out
        before the other is a difference like any other, and reads as one.
    #>
    [CmdletBinding()]
    param([string]$Left, [string]$Right)

    $leftLines = @($Left -split "`n")
    $rightLines = @($Right -split "`n")
    for ($index = 0; $index -lt [math]::Max($leftLines.Count, $rightLines.Count); $index++) {
        $one = if ($index -lt $leftLines.Count) { $leftLines[$index] } else { '(nothing)' }
        $other = if ($index -lt $rightLines.Count) { $rightLines[$index] } else { '(nothing)' }
        if ($one -cne $other) { return "line $($index + 1): [$one] against [$other]" }
    }
    return ''
}

function Test-ReportsEqual {
    <#
    .SYNOPSIS
        Whether two reports say the same thing, and what the first difference is
        when they do not.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$Left, [Parameter(Mandatory)][object]$Right, [switch]$IgnoreOutput)

    $difference = Get-FirstReportDifference `
        -Left (ConvertTo-CanonicalReport -Report $Left -IgnoreOutput:$IgnoreOutput) `
        -Right (ConvertTo-CanonicalReport -Report $Right -IgnoreOutput:$IgnoreOutput)
    return @{ equal = ($difference -eq ''); difference = $difference }
}

Export-ModuleMember -Function ConvertTo-CanonicalReport, Test-ReportsEqual, Get-CanonicalReportElement,
ConvertTo-SortedJsonLine, ConvertTo-SortedJsonValue,
Get-FirstReportDifference
