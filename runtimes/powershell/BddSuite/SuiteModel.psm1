<#
.SYNOPSIS
    Turns a suite file into the model the runner executes.

.DESCRIPTION
    Y2.4, Y2.5, Y2.8. Parsing a suite is not the same as reading it: a meta step
    has to be expanded into the steps it stands for, an import has to be
    resolved, a parameter has to be given the value that wins, and a table has to
    be turned into one step per row. All of that happens here, once, before
    anything executes, so that the runner's loop only ever sees a flat list of
    steps and the linter's diagnostics point at steps that exist.

    Every expanded step carries provenance: the meta step it came from, its
    one-based index inside that definition, and the position of the use site.
    That is what lets a failure read

        case S1-01 / meta prepare step 2 (core.set)

    rather than naming a step number nobody can find in the file (DEC-Y10).
#>

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

# How deep a meta step may use another before the nesting is refused (DEC-Y10).
$script:MetaDepthLimit = 5

function Copy-SuiteValue {
    <#
    .SYNOPSIS
        A deep copy of a parsed YAML value.
    .DESCRIPTION
        Expansion rewrites steps, and a meta step used twice must not have its
        first use edited by its second. Hashtables and lists are rebuilt;
        everything else is immutable as far as a suite is concerned.
    #>
    [CmdletBinding()]
    param([object]$Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($key in $Value.Keys) { $copy[$key] = Copy-SuiteValue -Value $Value[$key] }
        return $copy
    }
    if ($Value -isnot [string] -and $Value -is [System.Collections.IEnumerable]) {
        return , @($Value | ForEach-Object { Copy-SuiteValue -Value $_ })
    }
    return $Value
}

function Expand-MetaParameter {
    <#
    .SYNOPSIS
        Replace ${param.x} inside a meta step's body with what the use site gave.
    .DESCRIPTION
        A meta step's parameters are resolved at expansion time rather than at
        run time, so the steps the runner sees carry values and nothing
        downstream has to know that a meta step existed. A reference the use site
        has no value for is left alone, because the dataflow pass is what reports
        it, with a position.
    #>
    [CmdletBinding()]
    param([object]$Value, [hashtable]$Arguments)

    if ($Value -is [string]) {
        return [regex]::Replace($Value, '\$\{param\.([A-Za-z_][A-Za-z0-9_]*)\}', {
                param($match)
                $name = $match.Groups[1].Value
                if ($Arguments.ContainsKey($name)) { return [string]$Arguments[$name] }
                return $match.Value
            })
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($key in $Value.Keys) { $copy[$key] = Expand-MetaParameter -Value $Value[$key] -Arguments $Arguments }
        return $copy
    }
    if ($Value -isnot [string] -and $Value -is [System.Collections.IEnumerable]) {
        return , @($Value | ForEach-Object { Expand-MetaParameter -Value $_ -Arguments $Arguments })
    }
    return $Value
}

function Get-MetaStepDefinition {
    <#
    .SYNOPSIS
        Index a suite's meta steps by name.
    #>
    [CmdletBinding()]
    param($Model, [hashtable]$Imported)

    $definitions = @{}
    foreach ($name in @($Imported.Keys)) { if ($name) { $definitions[$name] = $Imported[$name] } }
    foreach ($meta in @($Model.metaSteps)) {
        if ($null -ne $meta -and $meta.name) { $definitions[[string]$meta.name] = $meta }
    }
    return $definitions
}

function Expand-SuiteStepList {
    <#
    .SYNOPSIS
        One step list, with every meta use site replaced by the steps it stands
        for and every table replaced by one step per row.
    .DESCRIPTION
        Returns a flat list. Each entry carries `__provenance`, a sentence naming
        where the step came from, which the runner prints and a failure quotes.
        A meta step may use another to a depth of five; deeper is refused here
        rather than left to recurse, because a cycle is otherwise a stack
        overflow rather than a diagnostic.
    #>
    [CmdletBinding()]
    param(
        [object]$Steps,
        [hashtable]$Definitions,
        [string]$Where,
        [int]$Depth = 0,
        [string]$Provenance = ''
    )

    $expanded = [Collections.Generic.List[object]]::new()
    $index = 0
    foreach ($step in @($Steps)) {
        if ($null -eq $step) { $index++; continue }
        $index++
        $position = if ($Provenance) { "$Provenance step $index" } else { "step $index" }

        if ($step.meta) {
            $name = [string]$step.meta
            if (-not $Definitions.ContainsKey($name)) {
                throw "$Where $position uses meta step $name, which is not declared or imported."
            }
            if ($Depth -ge $script:MetaDepthLimit) {
                throw "$Where $position nests meta steps deeper than $($script:MetaDepthLimit), which is the limit. A meta step that uses itself, directly or through another, is a cycle."
            }
            $definition = $Definitions[$name]
            $arguments = @{}
            foreach ($declared in @($definition.params)) {
                if ($null -eq $declared) { continue }
                if ($null -ne $declared.default) { $arguments[[string]$declared.name] = $declared.default }
            }
            foreach ($key in @(if ($step.with) { $step.with.Keys } else { @() })) {
                $arguments[$key] = $step.with[$key]
            }
            $body = Expand-MetaParameter -Value (Copy-SuiteValue -Value $definition.steps) -Arguments $arguments
            # The use site's own fields beyond meta, with and ifCapture (which
            # the core consumes here) are a workspace's, from a suite-schema
            # extension. The core does not interpret them, but each step the
            # use site stands for carries them in __useSites, innermost use
            # site first, so an extension's case hooks can (README.md).
            $site = @{}
            foreach ($key in @($step.Keys)) {
                if (@('meta', 'with', 'ifCapture') -cnotcontains $key) { $site[$key] = Copy-SuiteValue -Value $step[$key] }
            }
            $subIndex = 0
            foreach ($inner in Expand-SuiteStepList -Steps $body -Definitions $Definitions -Where $Where `
                    -Depth ($Depth + 1) -Provenance "meta $name") {
                # A nested step that carries a guard from the use site inherits
                # it, so `- meta: x` with ifCapture skips the whole group.
                if ($step.ifCapture -and -not $inner.ifCapture) { $inner['ifCapture'] = $step.ifCapture }
                $sites = [Collections.Generic.List[object]]::new()
                foreach ($nested in @($inner.__useSites)) { if ($null -ne $nested) { $sites.Add($nested) } }
                $sites.Add($site)
                $inner['__useSites'] = $sites.ToArray()
                # ST-10.3: where the step sits in what was authored. The index is
                # the use site's; the sub-index is the step's place in the whole
                # flattened group, where a nested group's steps and a table's
                # rows count one each. The outermost use site writes last, so
                # its numbering is the one that stays.
                $inner['__index'] = $index - 1
                $inner['__subIndex'] = $subIndex
                $subIndex++
                $expanded.Add($inner)
            }
            continue
        }

        # Y2.8: a step with a table is one step per row, in row order, with the
        # row bound in its own scope. The capture is collected into a list by the
        # runner, which is what `captureAs` on a table step publishes.
        if ($null -ne $step.table) {
            $rows = @($step.table | Where-Object { $null -ne $_ })
            $rowIndex = 0
            foreach ($row in $rows) {
                $rowIndex++
                $copy = Copy-SuiteValue -Value $step
                $copy.Remove('table')
                $copy['__provenance'] = $position
                $copy['__index'] = $index - 1
                $copy['__row'] = $row
                $copy['__rowIndex'] = $rowIndex
                $copy['__rowCount'] = $rows.Count
                $expanded.Add($copy)
            }
            continue
        }

        $copy = Copy-SuiteValue -Value $step
        $copy['__provenance'] = $position
        # ST-10.3: the 0-based place of the authored step in its list.
        $copy['__index'] = $index - 1
        $expanded.Add($copy)
    }
    return $expanded.ToArray()
}

function Import-SuiteLibrary {
    <#
    .SYNOPSIS
        Read the declaration libraries a suite imports, depth-first in order.
    .DESCRIPTION
        Y2.5 / DEC-Y17. A library declares `params`, `vars`, `metaSteps` and
        `defaults`, and nothing that runs. Imports resolve depth-first in the
        order listed, relative to the importing file, so a library may import
        another. The linter is what reports a cycle, a library that declares a
        case, and a local name that shadows an imported one without saying so;
        this is the half that executes, and it refuses a cycle rather than
        recursing into it.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$FilePath, $Model, [Collections.Generic.List[string]]$Visited)

    if (-not $Visited) {
        $Visited = [Collections.Generic.List[string]]::new()
        $Visited.Add([IO.Path]::GetFullPath($FilePath))
    }
    $library = @{ params = [ordered]@{}; vars = [ordered]@{}; metaSteps = @{}; defaults = @{} }
    foreach ($import in @($Model.imports)) {
        if (-not $import) { continue }
        $path = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $FilePath) $import))
        if ($Visited -contains $path) { throw "Import $import forms a cycle." }
        if (-not (Test-Path -LiteralPath $path)) { throw "Import $import does not exist at $path." }
        $Visited.Add($path)
        $imported = ConvertFrom-Yaml (Get-Content -LiteralPath $path -Raw) -Ordered
        # Depth first: what a library imports is in scope before the library's
        # own declarations, so the nearer file wins.
        $nested = Import-SuiteLibrary -FilePath $path -Model $imported -Visited $Visited
        foreach ($name in @($nested.params.Keys)) { $library.params[$name] = $nested.params[$name] }
        foreach ($name in @($nested.vars.Keys)) { $library.vars[$name] = $nested.vars[$name] }
        foreach ($name in @($nested.metaSteps.Keys)) { $library.metaSteps[$name] = $nested.metaSteps[$name] }
        foreach ($name in @($nested.defaults.Keys)) { $library.defaults[$name] = $nested.defaults[$name] }

        foreach ($param in @($imported.params)) {
            if ($null -ne $param) { $library.params[[string]$param.name] = $param }
        }
        foreach ($name in @(if ($imported.vars) { $imported.vars.Keys } else { @() })) { $library.vars[$name] = $imported.vars[$name] }
        foreach ($meta in @($imported.metaSteps)) {
            if ($null -ne $meta) { $library.metaSteps[[string]$meta.name] = $meta }
        }
        foreach ($name in @(if ($imported.defaults) { $imported.defaults.Keys } else { @() })) { $library.defaults[$name] = $imported.defaults[$name] }
    }
    return $library
}

function Resolve-SuiteParameter {
    <#
    .SYNOPSIS
        The value each declared parameter takes, highest source first.
    .DESCRIPTION
        DEC-Y18, in this order: the command line, the environment, the case, the
        file, the library. Every level is checked so that the answer is the same
        whichever level happens to hold a value, and a parameter with none
        anywhere is the linter's `E210` rather than an empty string mid-case.

        The environment variable is <EnvPrefix>PARAM_<NAME>; the prefix is
        BDD_SUITE_ unless an extension sets another (DEC-S03).
    #>
    [CmdletBinding()]
    param([hashtable]$Library, $Model, $Case, [hashtable]$CommandLine = @{}, [string]$EnvPrefix = 'BDD_SUITE_')

    $values = [ordered]@{}
    foreach ($name in @($Library.params.Keys)) {
        $declared = $Library.params[$name]
        if ($null -ne $declared.default) { $values[$name] = $declared.default }
    }
    foreach ($param in @($Model.params)) {
        if ($null -eq $param) { continue }
        if ($null -ne $param.default) { $values[[string]$param.name] = $param.default }
        if ($null -ne $param.value) { $values[[string]$param.name] = $param.value }
    }
    foreach ($param in @($Case.params)) {
        if ($null -eq $param) { continue }
        if ($null -ne $param.default) { $values[[string]$param.name] = $param.default }
        if ($null -ne $param.value) { $values[[string]$param.name] = $param.value }
    }
    foreach ($name in @($values.Keys) + @($Library.params.Keys) + @($Model.params | Where-Object { $_ } | ForEach-Object { [string]$_.name })) {
        $fromEnvironment = [Environment]::GetEnvironmentVariable("$($EnvPrefix)PARAM_$($name.ToUpperInvariant())")
        if ($null -ne $fromEnvironment) { $values[$name] = $fromEnvironment }
    }
    foreach ($name in @($CommandLine.Keys)) { $values[$name] = $CommandLine[$name] }
    return $values
}

function Format-TableRow {
    <#
    .SYNOPSIS
        One row as the text a report entry carries: column=value, in order.
    #>
    [CmdletBinding()]
    param($Row)
    return ((@($Row.Keys) | ForEach-Object { "$_=$($Row[$_])" }) -join ', ')
}

function Expand-SuiteOutline {
    <#
    .SYNOPSIS
        A case with `examples:` becomes one case per row (DEC-Y24).
    .DESCRIPTION
        Before the tag filter, so selecting the case selects all of its rows, and
        each row reports under its own name: `<case> [node=N2]`. The row is
        bound for the whole case, hooks and cleanup included, which is why it
        travels on the case rather than on a step.
    #>
    [CmdletBinding()]
    param($Cases)

    $expanded = [Collections.Generic.List[object]]::new()
    foreach ($case in @($Cases)) {
        if ($null -eq $case) { continue }
        if ($null -eq $case.examples) { $expanded.Add($case); continue }
        $rows = @($case.examples | Where-Object { $null -ne $_ })
        foreach ($row in $rows) {
            $copy = Copy-SuiteValue -Value $case
            $copy.Remove('examples')
            $copy['name'] = "$($case.name) [$(Format-TableRow -Row $row)]"
            $copy['__row'] = $row
            $expanded.Add($copy)
        }
    }
    return $expanded.ToArray()
}

function Resolve-SuiteKeyword {
    <#
    .SYNOPSIS
        Turn `and` into the keyword it continues, once, at expansion time.
    .DESCRIPTION
        DEC-Y22: nothing downstream has to know that `and` exists. The sentence
        stays the step's own; only the keyword is inherited.
    #>
    [CmdletBinding()]
    param([object]$Steps)

    $previous = ''
    foreach ($step in @($Steps)) {
        if ($null -eq $step) { continue }
        foreach ($keyword in @('given', 'when', 'then')) {
            if ($step.$keyword) { $previous = $keyword }
        }
        if ($step.and) {
            $step['__keyword'] = if ($previous) { $previous } else { 'and' }
            $step['__sentence'] = [string]$step.and
            continue
        }
        foreach ($keyword in @('given', 'when', 'then')) {
            if ($step.$keyword) {
                $step['__keyword'] = $keyword
                $step['__sentence'] = [string]$step.$keyword
            }
        }
    }
    return $Steps
}

function Format-StepLabel {
    <#
    .SYNOPSIS
        What the trace and a failure call one step.
    .DESCRIPTION
        The sentence first when the step has one, because that is what says what
        the step means; the action in brackets, because that is what ran.
    #>
    [CmdletBinding()]
    param([hashtable]$Step)

    $action = [string]$Step.action
    # The row, when there is one, comes last: the sentence says what the step
    # means and the row says which of them this is.
    $row = if ($Step.__rowIndex) { " row $($Step.__rowIndex) ($(Format-TableRow -Row $Step.__row))" } else { '' }
    if ($Step.__keyword -and $Step.__sentence) {
        return "$($Step.__keyword) $($Step.__sentence) ($action)$row"
    }
    if ($Step.__provenance) { return "$($Step.__provenance) ($action)$row" }
    return "step $action$row"
}

Export-ModuleMember -Function Copy-SuiteValue, Expand-MetaParameter, Get-MetaStepDefinition,
Expand-SuiteStepList, Resolve-SuiteKeyword, Format-StepLabel, Import-SuiteLibrary, Resolve-SuiteParameter,
Expand-SuiteOutline, Format-TableRow
