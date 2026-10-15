<#
.SYNOPSIS
    Generates a workspace's suite.schema.json and suite.schema.md from the core
    suite schema, the workspace's catalog (with everything it imports) and
    diagnostics.md.

.DESCRIPTION
    The structure of a suite is hand-written once, in suite.core.json beside
    this script. The action vocabulary is data, in a catalog. A catalog imports
    other catalogs (the core catalog, core.catalog.yaml, first of all) and
    suite-schema extensions that add fields to the suite, its defaults, a case
    or a step (DEC-S10). This script resolves the imports, folds the extensions
    into the core structure, emits one if/then branch per action so a step's
    parameters are checked against that action only, and renders the result as
    one human-readable reference page.

    Both outputs are committed beside the catalog, because an editor cannot
    read a generated file that is not in the tree, and every runtime loads the
    schema at run time. -Check regenerates into memory and compares against
    what is committed, which is what keeps them from drifting.

.PARAMETER Catalog
    The workspace catalog. Defaults to core.catalog.yaml beside this script.

.PARAMETER Check
    Write nothing. Compare the committed files with a fresh generation and exit
    2 naming every file that differs.

.PARAMETER OutputDirectory
    Write the generated files here instead of beside the catalog.

.EXAMPLE
    pwsh -File spec/Build-Schema.ps1 -Catalog test/e2e/schema/actions.catalog.yaml
    pwsh -File spec/Build-Schema.ps1 -Catalog test/e2e/schema/actions.catalog.yaml -Check
#>
[CmdletBinding()]
param(
    [string]$Catalog,
    [switch]$Check,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Import-Module powershell-yaml -ErrorAction Stop

$script:SpecRoot = $PSScriptRoot
$script:CatalogPath = if ($Catalog) { [IO.Path]::GetFullPath($Catalog) } else { Join-Path $script:SpecRoot 'core.catalog.yaml' }
$script:SchemaRoot = Split-Path -Parent $script:CatalogPath

function Resolve-Catalog {
    <#
    .SYNOPSIS
        A catalog with everything it imports, merged: actions and binding names
        from the imports first (depth first, in listed order), then its own;
        and every suite-schema extension any of them names, in the same order.
    .DESCRIPTION
        A name declared twice is an error naming both files, and so is an
        import cycle: either would make the meaning of a step depend on which
        file happened to be read last.
    #>
    param([string]$Path)

    $merged = [ordered]@{ catalogVersion = 1; bindings = [Collections.Generic.List[string]]::new(); actions = [Collections.Generic.List[object]]::new() }
    $extensions = [Collections.Generic.List[string]]::new()
    $declaredIn = @{}
    $visiting = [Collections.Generic.List[string]]::new()
    $done = @{}

    $visit = {
        param([string]$File)
        $full = [IO.Path]::GetFullPath($File)
        if ($visiting -contains $full) { throw "Catalog import cycle: $(($visiting + $full) -join ' -> ')" }
        if ($done.ContainsKey($full)) { return }
        if (-not (Test-Path -LiteralPath $full)) { throw "Catalog not found: $full" }
        $visiting.Add($full)
        $catalog = ConvertFrom-Yaml (Get-Content -LiteralPath $full -Raw) -Ordered
        $directory = Split-Path -Parent $full
        # Combine, not Join-Path: an absolute import stays absolute.
        foreach ($import in Get-CatalogList $catalog.imports) { & $visit ([IO.Path]::Combine($directory, [string]$import)) }
        foreach ($binding in Get-CatalogList $catalog.bindings) {
            if (-not $merged.bindings.Contains([string]$binding)) { $merged.bindings.Add([string]$binding) }
        }
        foreach ($action in Get-CatalogList $catalog.actions) {
            $name = [string]$action.name
            if ($declaredIn.ContainsKey($name)) { throw "Action $name is declared twice: in $($declaredIn[$name]) and in $full" }
            $declaredIn[$name] = $full
            $merged.actions.Add($action)
        }
        foreach ($extension in Get-CatalogList $catalog.suiteSchema) {
            $extensionPath = [IO.Path]::GetFullPath([IO.Path]::Combine($directory, [string]$extension))
            if (-not $extensions.Contains($extensionPath)) { $extensions.Add($extensionPath) }
        }
        $visiting.Remove($full) | Out-Null
        $done[$full] = $true
    }
    & $visit $Path
    return @{ catalog = $merged; extensions = $extensions.ToArray() }
}

function Add-SchemaExtension {
    <#
    .SYNOPSIS
        Folds one suite-schema extension into the core structure, refusing any
        field or definition the structure already has.
    #>
    param($Base, [string]$Path)

    $extension = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $allowed = @('$schema', 'description', 'suite', 'defaults', 'case', 'step', '$defs')
    foreach ($key in $extension.PSObject.Properties.Name) {
        if ($allowed -notcontains $key) { throw "$Path`: an extension may add to suite, defaults, case, step and `$defs only, not $key." }
    }
    $add = {
        param($Target, [string]$Where, $Fields)
        if ($null -eq $Fields) { return }
        foreach ($field in $Fields.PSObject.Properties) {
            if ($Target.PSObject.Properties.Name -contains $field.Name) { throw "$Path`: $Where already has $($field.Name); an extension may only add." }
            $Target | Add-Member -NotePropertyName $field.Name -NotePropertyValue $field.Value
        }
    }
    $defs = $Base.'$defs'
    & $add $Base.properties 'the suite' $extension.suite
    & $add $defs.defaults.properties 'defaults' $extension.defaults
    & $add $defs.case.properties 'a case' $extension.case
    & $add $defs.stepCommon.properties 'a step' $extension.step
    & $add $defs.stepEnvelope.properties 'the step envelope' $extension.step
    & $add $defs.'step.meta'.properties 'a meta step use site' $extension.step
    & $add $defs '$defs' $extension.'$defs'
}

function Get-SchemaInput {
    <#
    .SYNOPSIS
        The inputs, parsed: the core schema with the catalog's extensions
        folded in, the merged catalog, diagnostics.md.
    #>
    $basePath = Join-Path $script:SpecRoot 'suite.core.json'
    $diagnosticsPath = Join-Path $script:SpecRoot 'diagnostics.md'
    foreach ($path in @($basePath, $script:CatalogPath, $diagnosticsPath)) {
        if (-not (Test-Path -LiteralPath $path)) { throw "Schema input not found: $path" }
    }
    $resolved = Resolve-Catalog -Path $script:CatalogPath
    $base = Get-Content -LiteralPath $basePath -Raw | ConvertFrom-Json
    foreach ($extension in $resolved.extensions) { Add-SchemaExtension -Base $base -Path $extension }
    return @{
        base        = $base
        catalog     = $resolved.catalog
        catalogName = [IO.Path]::GetFileName($script:CatalogPath)
        diagnostics = (Get-Content -LiteralPath $diagnosticsPath -Raw)
    }
}

function Get-CatalogList {
    <#
    .SYNOPSIS
        A catalog list that is absent reads as empty, not as one null entry.
    #>
    param($Value)
    if ($null -eq $Value) { return @() }
    return @($Value | Where-Object { $null -ne $_ })
}

function ConvertTo-SchemaProperty {
    <#
    .SYNOPSIS
        One catalog parameter as one JSON Schema property.
    .DESCRIPTION
        A typed value may always be written as an expression instead, so every
        type but string is a union of that type and an expression-shaped
        string. The definition is inlined rather than referenced so that a
        branch reads on its own in an editor's hover.
    #>
    param([System.Collections.IDictionary]$Param)

    $property = [ordered]@{}
    switch ([string]$Param.ref) {
        'step' { $property['$ref'] = '#/$defs/step' }
        'assert' { $property['$ref'] = '#/$defs/assert' }
        default {
            switch ([string]$Param.type) {
                'string' { $property['type'] = 'string' }
                'any' { }
                default {
                    $property['type'] = @([string]$Param.type, 'string')
                    $property['pattern'] = '^\$\{[^}]+\}$'
                }
            }
        }
    }
    if ($Param.description) { $property['description'] = [string]$Param.description }
    if ($null -ne $Param.default) { $property['default'] = $Param.default }
    if (-not $property.Count) { $property['$comment'] = 'Any value; this action imposes no type.' }
    return $property
}

function New-StepBranch {
    <#
    .SYNOPSIS
        The schema one action's step is validated against, on its own.
    .DESCRIPTION
        Closed, so an unknown parameter is an error (E105); narrowed on the
        action name, so the branch cannot be selected for another action; and
        carrying the fields every step has, copied from the base schema's
        stepCommon so they are written down once.
    #>
    param([System.Collections.IDictionary]$Action, $StepCommon)

    $properties = [ordered]@{}
    foreach ($common in $StepCommon.PSObject.Properties) {
        $properties[$common.Name] = $common.Value
    }
    $properties['action'] = [ordered]@{ const = [string]$Action.name }
    $required = @('action')
    foreach ($param in Get-CatalogList $Action.params) {
        if ($properties.Contains($param.name)) {
            throw "Action $($Action.name) declares a parameter named $($param.name), which every step already has."
        }
        $properties[$param.name] = ConvertTo-SchemaProperty -Param $param
        if ($param.required) { $required += [string]$param.name }
    }
    $branch = [ordered]@{
        description          = [string]$Action.summary
        type                 = 'object'
        additionalProperties = $false
        required             = $required
        properties           = $properties
    }
    return $branch
}

function New-SuiteSchemaObject {
    <#
    .SYNOPSIS
        The base schema with its step placeholder replaced by the generated
        union, and one branch definition added per action.
    #>
    param($Base, [System.Collections.IDictionary]$Catalog, [string]$CatalogName)

    $defs = [ordered]@{}
    foreach ($def in $Base.'$defs'.PSObject.Properties) {
        if ($def.Name -eq 'step') { continue }
        $defs[$def.Name] = $def.Value
    }

    $names = @()
    $union = [Collections.Generic.List[object]]::new()
    $union.Add([ordered]@{ '$ref' = '#/$defs/stepEnvelope' })
    foreach ($action in Get-CatalogList $Catalog.actions) {
        $name = [string]$action.name
        $names += $name
        $defs["step.$name"] = New-StepBranch -Action $action -StepCommon $Base.'$defs'.stepCommon.properties
        $union.Add([ordered]@{
                'if'   = [ordered]@{ properties = [ordered]@{ action = [ordered]@{ const = $name } }; required = @('action') }
                'then' = [ordered]@{ '$ref' = "#/`$defs/step.$name" }
            })
    }
    $union.Add([ordered]@{
            'if'   = [ordered]@{ required = @('meta') }
            'then' = [ordered]@{ '$ref' = '#/$defs/step.meta' }
        })

    # The enum is what gives an editor a completion list and a squiggle under a
    # misspelled action. A validator reports the same thing as E104.
    $defs['step'] = [ordered]@{
        '$comment'           = "Generated by Build-Schema.ps1 from $CatalogName and the catalogs it imports. One branch per action, so the parameters of one action are never checked against another."
        type                 = 'object'
        properties           = [ordered]@{ action = [ordered]@{ enum = $names } }
        allOf                = $union.ToArray()
    }

    $schema = [ordered]@{}
    foreach ($property in $Base.PSObject.Properties) {
        if ($property.Name -eq '$defs') { continue }
        # A workspace's generated schema has no identity of its own on the web.
        if ($property.Name -eq '$id') { continue }
        if ($property.Name -eq 'title') {
            $schema['title'] = 'BDD test suite'
            continue
        }
        if ($property.Name -eq 'description') {
            $schema['description'] = "Generated by Build-Schema.ps1 from suite.core.json, $CatalogName and what it imports. Do not edit: regenerate it, and run the generator with -Check in CI so a stale copy fails the build."
            continue
        }
        $schema[$property.Name] = $property.Value
    }
    $schema['$defs'] = $defs
    return $schema
}

function Format-ShapePath {
    <#
    .SYNOPSIS
        A capture shape as one line per readable path.
    #>
    param([System.Collections.IDictionary]$Shape, [string]$Prefix, [int]$Depth = 0)

    $lines = [Collections.Generic.List[string]]::new()
    $type = [string]$Shape.type
    if ($type -eq 'array') {
        $lines.Add(('{0} -> array' -f $Prefix))
        if ($Shape.items) {
            foreach ($line in Format-ShapePath -Shape $Shape.items -Prefix ($Prefix + '.<index>') -Depth ($Depth + 1)) { $lines.Add($line) }
        }
        return $lines.ToArray()
    }
    if ($type -eq 'object') {
        $open = if ($Shape.additionalProperties) { ' (open: any other path is accepted unchecked)' } else { '' }
        $lines.Add(('{0} -> object{1}' -f $Prefix, $open))
        if ($Shape.properties) {
            foreach ($name in $Shape.properties.Keys) {
                foreach ($line in Format-ShapePath -Shape $Shape.properties[$name] -Prefix ("$Prefix.$name") -Depth ($Depth + 1)) { $lines.Add($line) }
            }
        }
        return $lines.ToArray()
    }
    $lines.Add(('{0} -> {1}' -f $Prefix, $type))
    return $lines.ToArray()
}

function Format-SchemaTypeName {
    param($Property)
    if ($null -eq $Property) { return 'any' }
    if ($Property -is [bool]) { return 'any' }
    $ref = [string]$Property.'$ref'
    if ($ref) { return ($ref -replace '^#/\$defs/', '') }
    if ($null -eq $Property.type) { return 'any' }
    return (@($Property.type) -join ' or ')
}

function Format-PropertyTable {
    <#
    .SYNOPSIS
        A schema object's properties as a Markdown table.
    #>
    param($Object, [string[]]$Required = @())

    $rows = [Collections.Generic.List[string]]::new()
    $rows.Add('| Key | Type | Required | Default | Meaning |')
    $rows.Add('| --- | --- | --- | --- | --- |')
    foreach ($property in $Object.properties.PSObject.Properties) {
        $value = $property.Value
        $isRequired = if ($Required -contains $property.Name) { 'yes' } else { '' }
        $default = if ($null -ne $value.default) { '`' + [string]$value.default + '`' } else { '' }
        $meaning = if ($value.description) { [string]$value.description } else { '' }
        $rows.Add(('| `{0}` | {1} | {2} | {3} | {4} |' -f $property.Name, (Format-SchemaTypeName $value), $isRequired, $default, $meaning))
    }
    return $rows.ToArray()
}

function Get-DiagnosticRows {
    <#
    .SYNOPSIS
        Every code row out of diagnostics.md, so the page cannot invent one.
    #>
    param([string]$Text)
    $rows = [Collections.Generic.List[string]]::new()
    foreach ($line in ($Text -split "\r?\n")) {
        if ($line -match '^\|\s*`([EW][0-9]{3})`\s*\|') { $rows.Add($line.Trim()) }
    }
    if (-not $rows.Count) { throw 'diagnostics.md declares no codes; the reference cannot be generated from it.' }
    return $rows.ToArray()
}

function New-SuiteReference {
    <#
    .SYNOPSIS
        The human-readable reference page, rendered from the same two files the
        schema is generated from.
    #>
    param($Base, [System.Collections.IDictionary]$Catalog, [string]$CatalogName, [string]$Diagnostics)

    $md = [Collections.Generic.List[string]]::new()
    $add = { param([string]$Line) $md.Add($Line) }

    & $add '# Test suite reference'
    & $add ''
    & $add ('Generated by `Build-Schema.ps1` from `suite.core.json`, `{0}` (with the' -f $CatalogName)
    & $add 'catalogs and suite-schema extensions it imports) and `diagnostics.md`. Do not'
    & $add 'edit this file: regenerate it, and run the generator with `-Check` in CI so a'
    & $add 'stale copy fails the build.'
    & $add ''
    & $add 'A suite file is a YAML document. It is validated against `suite.schema.json`,'
    & $add 'which is generated beside this page, and run by any binding'"'"'s `suiterun`.'
    & $add ''
    & $add '## The suite'
    & $add ''
    foreach ($row in Format-PropertyTable -Object $Base -Required @($Base.required)) { & $add $row }
    & $add ''
    & $add '## defaults'
    & $add ''
    foreach ($row in Format-PropertyTable -Object $Base.'$defs'.defaults) { & $add $row }
    & $add ''
    & $add '## A case'
    & $add ''
    foreach ($row in Format-PropertyTable -Object $Base.'$defs'.case -Required @($Base.'$defs'.case.required)) { & $add $row }
    & $add ''
    & $add '## A step'
    & $add ''
    & $add 'Every step carries these, whatever its action:'
    & $add ''
    foreach ($row in Format-PropertyTable -Object $Base.'$defs'.stepCommon -Required @('action')) { & $add $row }
    & $add ''
    & $add 'A meta step use site carries these instead:'
    & $add ''
    foreach ($row in Format-PropertyTable -Object $Base.'$defs'.'step.meta' -Required @($Base.'$defs'.'step.meta'.required)) { & $add $row }
    & $add ''
    & $add 'Everything else a step may carry is a parameter of its action, listed under'
    & $add '[the actions](#the-actions) below. A parameter that is not in that list is'
    & $add '`E105`, which is what catches `valeu:` for `value:`.'
    & $add ''
    & $add '## Reading a case as a scenario'
    & $add ''
    & $add 'A step may say which part of the scenario it is, and what it means, in the'
    & $add 'language of the thing being tested rather than the language of the action.'
    & $add 'The rules, all checked before anything runs:'
    & $add ''
    & $add '* Exactly one of `given`, `when`, `then`, `and` per step. Two is `E212`.'
    & $add '* `and` continues the keyword above it. First in a list it is `E212`,'
    & $add '  because there is nothing to continue.'
    & $add '* The order inside one step list is `given`, then `when`, then `then`. Going'
    & $add '  backwards is `E212`. An `and` never counts as going backwards.'
    & $add '* A keyword is optional, so a suite can be labelled a case at a time. A list'
    & $add '  that labels some of its steps and not others is `W304`.'
    & $add '* A step may carry its own `asserts:`, checked immediately after it and'
    & $add '  before the next step. The case-level `asserts:` block is unchanged and'
    & $add '  still runs after every step. This is what makes a `then` step a real Then'
    & $add '  rather than a label on a step that asserts nothing.'
    & $add '* The sentence is what the report prints and what a failure names:'
    & $add '  `case greets / when the greeting is published (core.set)`.'
    & $add ''
    & $add 'A `then` step still needs an action, because the sentence is documentation'
    & $add 'and the action is what runs. A `then` that only asserts uses the'
    & $add 'side-effect-free `core.noop`.'
    & $add ''
    & $add '### Table data'
    & $add ''
    & $add 'A step that carries a `table:` runs once per row, in row order, with'
    & $add '`${row.<column>}` bound to that row. Its `captureAs` publishes a list with'
    & $add 'one entry per row, in the same order.'
    & $add ''
    & $add '```yaml'
    & $add '      - given: a greeting for each person'
    & $add '        action: core.set'
    & $add '        value: Hello, ${row.name}'
    & $add '        captureAs: greetings'
    & $add '        table:'
    & $add '          - { name: Ada }'
    & $add '          - { name: Lin }'
    & $add '```'
    & $add ''
    & $add 'A case that carries `examples:` runs once per row and reports once per row,'
    & $add 'named `<case name> [<column>=<value>, ...]`, with `${row.<column>}` bound for'
    & $add 'the whole case, hooks and cleanup included. The tag filter selects the case,'
    & $add 'which selects all of its rows.'
    & $add ''
    & $add 'Every row of a table declares the same columns, and no two rows are'
    & $add 'identical: both are `E213`. A step `table:` inside a case that carries'
    & $add '`examples:` is `E213` as well, because there is one `row` namespace and two'
    & $add 'row scopes would shadow each other. A `${row.<column>}` the table in scope'
    & $add 'does not declare is `E301`.'
    & $add ''
    & $add '## The order of everything'
    & $add ''
    & $add 'For a suite with cases C1 and C2 selected by the tag filter:'
    & $add ''
    & $add '```'
    & $add 'suite setup'
    & $add '  beforeEach -> C1 setup -> C1 steps -> C1 asserts -> C1 cleanup -> afterEach'
    & $add '  beforeEach -> C2 setup -> C2 steps -> C2 asserts -> C2 cleanup -> afterEach'
    & $add 'suite teardown'
    & $add '```'
    & $add ''
    & $add 'Inside a step list, one step is:'
    & $add ''
    & $add '```'
    & $add 'the step runs -> its own asserts, if it has any -> the next step'
    & $add '```'
    & $add ''
    & $add 'and a step with a `table:` is that, once per row, in row order. A case with'
    & $add '`examples:` is the whole line above, once per row, with its own report entry'
    & $add 'each time.'
    & $add ''
    & $add 'No hook is ever a passed or failed entry in the report, and no hook draws on'
    & $add 'a case deadline. Failure is attributed like this:'
    & $add ''
    & $add '| What fails | Cases affected | Still runs | Report |'
    & $add '| --- | --- | --- | --- |'
    & $add '| suite `setup` | all | `teardown` | every case errored with the setup message |'
    & $add '| `beforeEach` | that case | that case cleanup, `afterEach` | case failed |'
    & $add '| case `setup` | that case | that case cleanup, `afterEach` | case failed |'
    & $add '| a step | that case | remaining steps skipped, cleanup, `afterEach` | case failed |'
    & $add '| a step own assertion | that case | remaining steps skipped, cleanup, `afterEach` | case failed at that step |'
    & $add '| one row of a step table | that case | remaining rows and steps skipped, cleanup, `afterEach` | case failed, naming the row |'
    & $add '| an assertion | that case | remaining asserts skipped, cleanup, `afterEach` | case failed |'
    & $add '| one row of an outline | that row only | the next row, as its own case | that row entry failed |'
    & $add '| case `cleanup` | that case | `afterEach` | case failed, cleanup error appended |'
    & $add '| `afterEach` | that case | the next case | case failed, hook error appended |'
    & $add '| suite `teardown` | none | nothing | its own entry, exit code 1 |'
    & $add ''
    & $add '## Where captures live'
    & $add ''
    & $add 'One bag per case. It starts as a copy of what the suite `setup` captured, so'
    & $add '`${capture.agent}` reaches a case that never produced it. `beforeEach` and the'
    & $add 'case own `setup` write into that copy. Nothing a case captures is visible to'
    & $add 'the next case, which is what lets cases run in any order.'
    & $add ''
    & $add '## Reading a value'
    & $add ''
    & $add 'Anything between `${` and `}` is an expression. A string that is exactly one'
    & $add 'expression yields that value with its type intact, so `timeoutSec: ${var.x}`'
    & $add 'is a number; a string with an expression inside other text is substituted'
    & $add 'into, so `name: run-${param.name}-a` is a string.'
    & $add ''
    & $add 'A path starts at one of four roots, and nothing else:'
    & $add ''
    & $add '| Root | Reads |'
    & $add '| --- | --- |'
    & $add '| `capture.<name>` | what an earlier step in this case, or a hook before it, captured |'
    & $add '| `param.<name>` | a declared parameter, or a meta step parameter inside a definition |'
    & $add '| `var.<name>` | a calculated variable |'
    & $add '| `row.<column>` | one row of the table in scope: a step that carries a `table`, or a case that carries `examples` |'
    & $add '| `timeoutSec`, `defaults.<key>`, and the context keys a runtime extension adds | the run context |'
    & $add ''
    & $add 'A bare capture name is **not** a capture. `${origOwner}` is `E301`; the'
    & $add 'spelling is `${capture.origOwner}`. There is one way to read a capture, which'
    & $add 'is why a capture can never shadow a context key of the same name.'
    & $add ''
    & $add 'The operators and the closed function list of the expression language are'
    & $add 'specified, case by case, by the conformance corpus (`conformance/expressions`),'
    & $add 'which every runtime passes.'
    & $add ''
    & $add '## Assertions'
    & $add ''
    & $add 'An assertion names a subject with `var:`, a dotted path into the capture bag,'
    & $add 'and applies one or more operators. All of them must pass. A subject with no'
    & $add 'operator is `E204`. An expected value may itself be an expression, so an'
    & $add 'assertion can compare against a parameter or an earlier capture.'
    & $add ''
    foreach ($row in Format-PropertyTable -Object $Base.'$defs'.assert) { & $add $row }
    & $add ''
    & $add '## Limits'
    & $add ''
    & $add '```'
    & $add 'case deadline  = case.timeoutSec or defaults.timeoutSec or 600'
    & $add 'step deadline  = min(step.timeoutSec or infinity, what remains of the case deadline)'
    & $add 'hook deadline  = the hook own key, independent of the case deadline'
    & $add '```'
    & $add ''
    & $add 'The runner fails a case that exceeds its deadline. The ceiling each limit'
    & $add 'is checked against is in [diagnostics.md](diagnostics.md); a runtime'
    & $add 'extension may add a stricter one, for example for suites with a given tag.'
    & $add ''
    & $add '## The actions'
    & $add ''
    & $add ('{0} actions, from `{1}` and the catalogs it imports. `bindings` is which' -f (Get-CatalogList $Catalog.actions).Count, $CatalogName)
    & $add 'runtimes implement the action; naming one the selected binding does not implement is'
    & $add '`E201`. `interruptible: false` means the runner cannot cancel the work, so a'
    & $add 'timeout on it is reported as abandoned rather than cancelled.'
    & $add ''
    foreach ($action in Get-CatalogList $Catalog.actions) {
        & $add ('### `{0}`' -f $action.name)
        & $add ''
        & $add ([string]$action.summary)
        & $add ''
        & $add ('Bindings: {0}. Interruptible: {1}.{2}' -f ((Get-CatalogList $action.bindings | ForEach-Object { "``$_``" }) -join ', '), ([string]$action.interruptible).ToLowerInvariant(), $(if ($action.deprecated) { ' Deprecated.' } else { '' }))
        & $add ''
        if ($action.notes) {
            & $add (($action.notes -replace '\s+', ' ').Trim())
            & $add ''
        }
        if ((Get-CatalogList $action.params).Count) {
            & $add '| Parameter | Type | Required | Default | Meaning |'
            & $add '| --- | --- | --- | --- | --- |'
            foreach ($param in Get-CatalogList $action.params) {
                $required = if ($param.required) { 'yes' } else { '' }
                $default = if ($null -ne $param.default) { '`' + [string]$param.default + '`' } else { '' }
                $type = switch ([string]$param.ref) {
                    'step' { 'a nested step' }
                    'assert' { 'a nested assertion' }
                    default { [string]$param.type }
                }
                & $add ('| `{0}` | {1} | {2} | {3} | {4} |' -f $param.name, $type, $required, $default, [string]$param.description)
            }
            & $add ''
        } else {
            & $add 'No parameters.'
            & $add ''
        }
        & $add 'Captures:'
        & $add ''
        & $add '```'
        foreach ($line in Format-ShapePath -Shape $action.captures -Prefix '<captureAs>') { & $add $line }
        & $add '```'
        & $add ''
    }
    & $add '## Diagnostics'
    & $add ''
    & $add 'Every code, from [diagnostics.md](diagnostics.md), which also states the'
    & $add 'output formats and the sort order a `--json` run writes.'
    & $add ''
    & $add '| Code | Severity | Meaning |'
    & $add '| --- | --- | --- |'
    foreach ($row in Get-DiagnosticRows -Text $Diagnostics) { & $add $row }
    & $add ''
    & $add '## Exit codes'
    & $add ''
    & $add '| Code | Meaning |'
    & $add '| --- | --- |'
    & $add '| 0 | every selected case passed |'
    & $add '| 1 | a case failed |'
    & $add '| 2 | a harness error, or a diagnostic from the lint that runs first |'
    & $add ''
    & $add '## Output format'
    & $add ''
    & $add 'NUnit 3 XML by default, or JUnit; the report format is chosen on the'
    & $add 'command line (`--format`).'

    return (($md.ToArray() -join "`n") + "`n")
}

function Get-GeneratedSchemaText {
    # $Input is an automatic variable in PowerShell: a parameter of that name is
    # handed an empty pipeline enumerator rather than the argument. The parsed
    # inputs travel as $Parsed for that reason.
    param([hashtable]$Parsed)
    $schema = New-SuiteSchemaObject -Base $Parsed.base -Catalog $Parsed.catalog -CatalogName $Parsed.catalogName
    return (((ConvertTo-Json -InputObject $schema -Depth 50) -replace "`r`n", "`n") + "`n")
}

function Get-GeneratedReferenceText {
    param([hashtable]$Parsed)
    return (New-SuiteReference -Base $Parsed.base -Catalog $Parsed.catalog -CatalogName $Parsed.catalogName -Diagnostics $Parsed.diagnostics)
}

function Compare-GeneratedFile {
    param([string]$Path, [string]$Expected)
    if (-not (Test-Path -LiteralPath $Path)) { return "$([IO.Path]::GetFileName($Path)) is missing" }
    $actual = (Get-Content -LiteralPath $Path -Raw) -replace "`r`n", "`n"
    if ($actual -ne ($Expected -replace "`r`n", "`n")) { return "$([IO.Path]::GetFileName($Path)) is stale" }
    return $null
}

$inputs = Get-SchemaInput
$outputs = [ordered]@{
    'suite.schema.json' = Get-GeneratedSchemaText -Parsed $inputs
    'suite.schema.md'   = Get-GeneratedReferenceText -Parsed $inputs
}

if ($Check) {
    $differences = @()
    foreach ($name in $outputs.Keys) {
        $difference = Compare-GeneratedFile -Path (Join-Path $script:SchemaRoot $name) -Expected $outputs[$name]
        if ($difference) { $differences += $difference }
    }
    if ($differences.Count) {
        Write-Host 'The committed schema does not match a fresh generation:' -ForegroundColor Red
        $differences | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        Write-Host "Run: pwsh -File $PSCommandPath -Catalog $script:CatalogPath" -ForegroundColor Yellow
        exit 2
    }
    Write-Host 'The committed schema and reference match a fresh generation.' -ForegroundColor Green
    exit 0
}

$target = if ($OutputDirectory) { $OutputDirectory } else { $script:SchemaRoot }
if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
foreach ($name in $outputs.Keys) {
    $path = Join-Path $target $name
    [IO.File]::WriteAllText($path, $outputs[$name], [Text.UTF8Encoding]::new($false))
    Write-Host "wrote $path" -ForegroundColor Cyan
}
exit 0
