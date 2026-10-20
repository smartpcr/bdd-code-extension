<#
.SYNOPSIS
    Validates a YAML test suite with no lab, no credentials and no network.

.DESCRIPTION
    Y1.4 / DEC-Y05. Three layered passes over one parse:

      structure (E1xx)  the workspace's generated suite.schema.json, evaluated
                        with JsonSchema.Net (Invoke-SchemaValidation)
      semantics (E2xx)  duplicates, ceilings, meta steps, imports, parameters
      dataflow  (E3xx)  every ${...} reference resolves, every capture path
                        exists in the shape its action declares

    Every finding carries a code from spec/diagnostics.md, a file, a line and a
    column. Codes and positions are the contract every runtime is held to; the
    wording of a message is not.

    A runtime extension (BddSuite.psm1, DEC-S03) adds context keys the
    dataflow pass accepts, an environment prefix for parameter values, and
    lint rules that run after these three passes. Nothing here names a
    product: a tag-based time ceiling or a rule about one shared library is
    an extension rule of the workspace that owns it.

    Positions come from a second parse of the same bytes through YamlDotNet's
    YamlStream, which powershell-yaml already ships: ConvertFrom-Yaml gives the
    model, YamlStream gives the line and column of every node (DEC-Y13).

    One note on the structural pass. The generated schema validates a step
    against one if/then branch per action, which is what gives an editor
    per-action completion. The JSON Schema implementation also reports the
    failures of the conditions it did not select, so a step with one
    unknown key comes back with an error for every other action as well. This
    module therefore validates the document with the step definition swapped for
    the envelope the base schema already carries, and each step against its own
    generated branch, selected by its action name. No rule is re-expressed here;
    both subschemas are read out of the same committed file.
#>

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'
Import-Module powershell-yaml -ErrorAction Stop
# The dataflow pass reads a ${...} with the same tokeniser the evaluator uses,
# so a function call is a function call to both of them.
Import-Module (Join-Path $PSScriptRoot 'Expression.psm1') -DisableNameChecking

function ConvertFrom-SuiteYaml {
    <#
    .SYNOPSIS
        powershell-yaml's `ConvertFrom-Yaml -Ordered` for a suite file,
        answered the same way without its per-node advanced functions.
    .DESCRIPTION
        The same YamlDotNet parse, the first document only (as ConvertFrom-Yaml
        without -AllDocuments), mappings as ordered dictionaries and sequences
        as List[object]. An untagged scalar follows powershell-yaml 0.4.12's
        Convert-ValueToProperType line for line; a tagged one is handed to that
        function itself. Its per-node cmdlet binding was four fifths of the
        lint's time, which the two-second budget of Y1 cannot carry.
    #>
    param([string]$Text, [ref]$RootNode)
    $stream = [YamlDotNet.RepresentationModel.YamlStream]::new()
    $stream.Load([IO.StringReader]::new($Text + "`n"))
    if (-not $stream.Documents.Count) { return }
    if ($RootNode) { $RootNode.Value = $stream.Documents[0].RootNode }
    return ConvertFrom-SuiteYamlNode $stream.Documents[0].RootNode
}

$script:YamlCoreTags = @('str', 'null', 'bool', 'int', 'float', 'timestamp' | ForEach-Object { "tag:yaml.org,2002:$_" })

# A plain scalar that matches this can only come back as itself: no boolean
# (true, false), number (digit, sign, point, Infinity, NaN) or null word
# (null, ~) can be read out of it. Either it opens with a printable ASCII
# character none of those opens with, or it holds a space between two
# printable characters, which none of those holds; the parses only trim white
# space and NUL at the ends. Most suite scalars are words or sentences, and
# trying the parses on them was a fifth of the lint's time once the stage 10
# and 12 suites were added (the two-second budget of Y1).
$script:PlainTextPattern = '(?s)^[!-*,/:-@A-EG-HJ-MO-SU-Z\[-`a-eg-hj-mo-su-z{-}]|[!-~].* .*[!-~]'

function ConvertFrom-SuiteYamlNode {
    param($Node)
    if ($Node -is [YamlDotNet.RepresentationModel.YamlMappingNode]) {
        $map = [ordered]@{}
        foreach ($pair in $Node.Children) {
            # A child that can only be its own text is answered here, by the
            # same rules as below, rather than through one call per scalar.
            $child = $pair.Value
            if ($child -is [YamlDotNet.RepresentationModel.YamlScalarNode] -and $child.Value -is [string] -and
                [string]$child.Tag -notin $script:YamlCoreTags -and
                ($child.Style -ne 'Plain' -or $child.Value -cmatch $script:PlainTextPattern)) {
                $map[$pair.Key.Value] = $child.Value
                continue
            }
            $map[$pair.Key.Value] = ConvertFrom-SuiteYamlNode $child
        }
        return $map
    }
    if ($Node -is [YamlDotNet.RepresentationModel.YamlSequenceNode]) {
        $list = [System.Collections.Generic.List[object]]::new()
        foreach ($item in $Node.Children) {
            if ($item -is [YamlDotNet.RepresentationModel.YamlScalarNode] -and $item.Value -is [string] -and
                [string]$item.Tag -notin $script:YamlCoreTags -and
                ($item.Style -ne 'Plain' -or $item.Value -cmatch $script:PlainTextPattern)) {
                $list.Add($item.Value)
                continue
            }
            $list.Add((ConvertFrom-SuiteYamlNode $item))
        }
        return , $list
    }
    if ($Node -isnot [YamlDotNet.RepresentationModel.YamlScalarNode]) { return }
    # An untagged scalar's tag reads "?"; powershell-yaml treats only these
    # six tags specially and lets any other fall through to the rules below.
    if ($Node.Value -isnot [string] -or [string]$Node.Tag -in $script:YamlCoreTags) {
        return (& (Get-Module powershell-yaml) { param($Scalar) Convert-ValueToProperType $Scalar } $Node)
    }
    if ($Node.Style -eq 'Plain') {
        # Text no boolean, number or null word can be read out of comes back
        # as itself; the parses below could only fail for it.
        if ($Node.Value -cmatch $script:PlainTextPattern) { return $Node.Value }
        $boolean = $false
        if ([boolean]::TryParse($Node, [ref]$boolean)) { return $boolean }
        $integer = [System.Numerics.BigInteger]::Zero
        if ([System.Numerics.BigInteger]::TryParse($Node, @([Globalization.NumberStyles]::Float, [Globalization.NumberStyles]::Integer), [Globalization.CultureInfo]::InvariantCulture, [ref]$integer)) {
            foreach ($type in @([int], [long])) {
                $narrow = $integer -as $type
                if ($null -ne $narrow) { return $narrow }
            }
            return $integer
        }
        $number = [decimal]0
        if ([decimal]::TryParse($Node, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)) { return $number }
        $real = [double]0
        if ([double]::TryParse($Node, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$real)) { return $real }
        if ($Node.Value -in '', '~', 'null', 'Null', 'NULL') { return $null }
    }
    return $Node.Value
}

# The bare names the core's run context holds, beyond capture, param and var.
# A runtime extension adds its own context keys (Composite.ContextKeys).
$script:CoreContextKeys = @('timeoutSec', 'defaults')

# The prefix of <prefix>PARAM_<NAME> when no extension sets one.
$script:DefaultEnvPrefix = 'BDD_SUITE_'

# Every key that names a time limit, with the ceiling it is checked against.
# 14400 seconds is the bound the runner already enforces on cleanupTimeoutSec.
# A stricter ceiling for some suites is an extension rule (Rules.Lint and
# Rules.CaseLimitSec), never a rule of the core.
$script:LimitCeilingSec = 14400

# What a library file may declare. Anything else in an imported file is E211.
$script:LibraryKeys = @('params', 'vars', 'metaSteps', 'defaults', 'description', 'schemaVersion')

# Constructs no two of the four bindings' regular expression engines agree on.
$script:UnportablePatterns = [ordered]@{
    '\(\?='      = 'a lookahead'
    '\(\?!'      = 'a negative lookahead'
    '\(\?<='     = 'a lookbehind'
    '\(\?<!'     = 'a negative lookbehind'
    '\\[1-9]'    = 'a backreference'
}

function Get-KeyList {
    <#
    .SYNOPSIS
        The keys of a mapping that may be absent, as an empty list when it is.
    .DESCRIPTION
        @($absent.Keys) yields one null entry in PowerShell, which then reaches
        ContainsKey as a null key and throws. Every key walk goes through here.
    #>
    [CmdletBinding()]
    param($Value)
    if ($null -eq $Value) { return @() }
    if ($Value -isnot [System.Collections.IDictionary]) { return @() }
    # A loop rather than a pipeline: this runs for every mapping the lint walks.
    $keys = [Collections.Generic.List[object]]::new()
    foreach ($key in $Value.Keys) { if ($null -ne $key) { $keys.Add($key) } }
    return $keys.ToArray()
}

function Get-SuiteWorkspaceRoot {
    <#
    .SYNOPSIS
        The nearest ancestor of -Start (itself included) that holds
        test/e2e/schema, the layout a workspace uses by default; nothing when
        there is none.
    #>
    [CmdletBinding()]
    param([string]$Start = (Get-Location).Path)
    $here = [IO.Path]::GetFullPath($Start)
    while ($here) {
        if (Test-Path -LiteralPath (Join-Path $here 'test/e2e/schema') -PathType Container) { return $here }
        $parent = [IO.Path]::GetDirectoryName($here)
        if (-not $parent -or $parent -eq $here) { return $null }
        $here = $parent
    }
    return $null
}

function Resolve-SuiteRoot {
    <#
    .SYNOPSIS
        The workspace root (diagnostic paths are relative to it) and the schema
        root (suite.schema.json and actions.catalog.yaml).
    .DESCRIPTION
        With -SchemaRoot no walk is needed: the schema root is used as given,
        and findings are relative to the workspace root when there is one above
        the working directory, else to the working directory. Without it the
        workspace root has to be found, and its test/e2e/schema is the schema
        root.
    #>
    [CmdletBinding()]
    param([string]$SchemaRoot, [string]$Start = (Get-Location).Path)
    $root = Get-SuiteWorkspaceRoot -Start $Start
    if ($SchemaRoot) {
        $resolved = if ([IO.Path]::IsPathRooted($SchemaRoot)) { $SchemaRoot } else { Join-Path $Start $SchemaRoot }
        return @{
            root       = $(if ($root) { $root } else { [IO.Path]::GetFullPath($Start) })
            schemaRoot = [IO.Path]::GetFullPath($resolved)
        }
    }
    if (-not $root) {
        throw 'the workspace root cannot be found from this directory (no test/e2e/schema above it); pass -SchemaRoot.'
    }
    return @{ root = $root; schemaRoot = (Join-Path $root 'test/e2e/schema') }
}

function Read-SuiteCatalog {
    <#
    .SYNOPSIS
        Every action entry of a catalog and of the catalogs it imports, each
        with the file that declares it (DEC-S10).
    .DESCRIPTION
        Imports first, depth first in the order listed, each relative to the
        file that names it; then the catalog's own actions. A name declared
        twice is refused naming both files, and an import cycle is refused, as
        the generator and every other runtime refuse them.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    $entries = [Collections.Generic.List[hashtable]]::new()
    $declaredIn = @{}
    $visiting = [Collections.Generic.List[string]]::new()
    $visit = {
        param([string]$File)
        $key = [IO.Path]::GetFullPath($File)
        if ($visiting -contains $key) { throw "Catalog import cycle: $((@($visiting) + $key) -join ' -> ')" }
        $catalog = $null
        try { $catalog = ConvertFrom-SuiteYaml (Get-Content -LiteralPath $key -Raw) } catch { throw "$key is not YAML: $($_.Exception.Message)" }
        $visiting.Add($key)
        if ($catalog -is [System.Collections.IDictionary]) {
            foreach ($import in @($catalog['imports'])) {
                if (-not $import) { continue }
                # Combine, not Join-Path: an absolute import stays absolute.
                $imported = [IO.Path]::GetFullPath([IO.Path]::Combine((Split-Path -Parent $key), [string]$import))
                if (-not (Test-Path -LiteralPath $imported -PathType Leaf)) { throw "$key imports $import, which does not exist ($imported)." }
                & $visit $imported
            }
            foreach ($action in @($catalog['actions'])) {
                if ($action -isnot [System.Collections.IDictionary]) { continue }
                $name = [string]$action['name']
                if (-not $name) { continue }
                if ($declaredIn.ContainsKey($name)) { throw "Action $name is declared twice: in $($declaredIn[$name]) and in $key." }
                $declaredIn[$name] = $key
                $entries.Add(@{ action = $action; file = $key })
            }
        }
        $visiting.RemoveAt($visiting.Count - 1)
    }
    & $visit $Path
    return $entries.ToArray()
}

function Get-SuiteReferencedDefinitions {
    param([hashtable]$Definitions, [string]$Document)

    # JSON Schema ignores unreachable definitions. Keep exactly the transitive
    # closure of local references so the validator need not parse every action for
    # each suite. Follow cycles once; leave missing references to the validator.
    $selected = [ordered]@{}
    # The names one definition refers to, in the order it writes them. The
    # definitions are the same for every suite, so each one's text is read
    # once per session; an entry is reused only for the very text it was read
    # from.
    if ($null -eq $script:DefinitionReferenceCache) {
        $script:DefinitionReferenceCache = [Collections.Generic.Dictionary[string, object[]]]::new([StringComparer]::Ordinal)
    }
    $pending = [Collections.Generic.Queue[object[]]]::new()
    $pending.Enqueue(@($null, $Document))
    while ($pending.Count) {
        $definitionName, $text = $pending.Dequeue()
        $names = $null
        $cached = $null
        if ($null -ne $definitionName) { $cached = $script:DefinitionReferenceCache[$definitionName] }
        if ($null -ne $cached -and [object]::ReferenceEquals($cached[0], $text)) {
            $names = $cached[1]
        } else {
            $names = [string[]]@(foreach ($match in [regex]::Matches($text, '"\$ref"\s*:\s*"#/\$defs/([^"/]+)')) { $match.Groups[1].Value })
            if ($null -ne $definitionName) { $script:DefinitionReferenceCache[$definitionName] = @($text, $names) }
        }
        foreach ($name in $names) {
            if ($selected.Contains($name) -or -not $Definitions.ContainsKey($name)) { continue }
            $selected[$name] = $Definitions[$name]
            $pending.Enqueue(@($name, $Definitions[$name]))
        }
    }
    $members = foreach ($name in $selected.Keys) { '"' + $name + '":' + $selected[$name] }
    return '{' + ($members -join ',') + '}'
}

function Import-SuiteSchema {
    <#
    .SYNOPSIS
        The committed schema and catalog, parsed once per session.
    .DESCRIPTION
        Returns the schema text the structural pass validates against (the
        generated schema with its step union swapped for the envelope), the
        definitions the per-step pass needs, and the catalog, with everything
        it imports, indexed by action name. Nothing here hard-codes a key or an
        action.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$SchemaRoot, [switch]$Force)

    $cacheKey = [IO.Path]::GetFullPath($SchemaRoot)
    if (-not $Force -and $script:SchemaCache -and $script:SchemaCache.root -eq $cacheKey) { return $script:SchemaCache }

    $schemaPath = Join-Path $SchemaRoot 'suite.schema.json'
    $catalogPath = Join-Path $SchemaRoot 'actions.catalog.yaml'
    foreach ($path in @($schemaPath, $catalogPath)) {
        if (-not (Test-Path -LiteralPath $path)) {
            throw "Suite schema not found at $path. Generate it with the spec's Build-Schema.ps1 -Catalog <catalog>."
        }
    }

    $schema = Get-Content -LiteralPath $schemaPath -Raw | ConvertFrom-Json
    if (-not $schema.'$defs'.stepEnvelope) { throw 'suite.schema.json carries no stepEnvelope definition.' }

    # The document pass: the same schema, with the conditional step union
    # replaced by the envelope. Steps are then checked one branch at a time.
    $lintSchema = $schema | ConvertTo-Json -Depth 50 | ConvertFrom-Json
    $lintSchema.'$defs'.step = $schema.'$defs'.stepEnvelope
    $lintDefinitions = $lintSchema.'$defs'
    $definitionText = @{}
    foreach ($definition in $lintSchema.'$defs'.PSObject.Properties) {
        $definitionText[$definition.Name] = ConvertTo-Json -InputObject $definition.Value -Depth 50 -Compress
    }
    $lintSchema.PSObject.Properties.Remove('$defs')
    $documentText = $lintSchema | ConvertTo-Json -Depth 50 -Compress
    $documentDefinitions = Get-SuiteReferencedDefinitions -Definitions $definitionText -Document $documentText
    $documentText = $documentText.Substring(0, $documentText.Length - 1) + ',"$defs":' + $documentDefinitions + '}'

    $catalog = ConvertFrom-SuiteYaml (Get-Content -LiteralPath $catalogPath -Raw)
    $actions = @{}
    $declaredIn = @{}
    foreach ($entry in Read-SuiteCatalog -Path $catalogPath) {
        $actions[[string]$entry.action.name] = $entry.action
        $declaredIn[[string]$entry.action.name] = $entry.file
    }

    $script:SchemaCache = @{
        root            = $cacheKey
        schema          = $schema
        lintSchemaText  = $documentText
        defs            = $lintDefinitions
        # Serialise each definition once. Each pass includes only definitions
        # reachable from its references, instead of parsing every action.
        defsText        = $definitionText
        catalog         = $catalog
        actions         = $actions
        declaredIn      = $declaredIn
        actionNames     = @($actions.Keys | Sort-Object)
        assertOperators = @($schema.'$defs'.assert.properties.PSObject.Properties.Name | Where-Object { $_ -ne 'var' })
        stepCommonKeys  = @($schema.'$defs'.stepCommon.properties.PSObject.Properties.Name)
    }
    return $script:SchemaCache
}

function Get-SuiteNodePosition {
    <#
    .SYNOPSIS
        A JSON pointer to line and column map for one YAML document.
    .DESCRIPTION
        Each pointer carries the position of the key that names the value and
        the position of the value itself. A structural finding points at the
        key, because that is the word that is misspelled; a dataflow finding
        points at the value, because that is where the reference is written.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text, $RootNode)

    # Each pointer holds the YAML node itself, or for a mapping entry the
    # entry (its key and its value); New-SuiteDiagnostic reads the line and
    # column from it only when a finding is written. Building a small table
    # per node was a tenth of the lint's time once stage 6's suites were added.
    $map = @{}
    $reader = [IO.StringReader]::new($Text)
    try {
        if ($null -eq $RootNode) {
            $stream = [YamlDotNet.RepresentationModel.YamlStream]::new()
            $stream.Load($reader)
            if (-not $stream.Documents.Count) { return $map }
            $RootNode = $stream.Documents[0].RootNode
        }
        $root = $RootNode
        $map[''] = $root
        # Breadth first. Only a mapping or a sequence has children to visit, so
        # a scalar is recorded and never queued; most nodes are scalars.
        $pendingNode = [Collections.Generic.Queue[object]]::new()
        $pendingAt = [Collections.Generic.Queue[string]]::new()
        $pendingNode.Enqueue($root)
        $pendingAt.Enqueue('')
        while ($pendingNode.Count) {
            $node = $pendingNode.Dequeue()
            $at = $pendingAt.Dequeue()
            if ($node -is [YamlDotNet.RepresentationModel.YamlMappingNode]) {
                foreach ($pair in $node.Children) {
                    # Escaped as RFC 6901 says; most keys need no escape.
                    $key = [string]$pair.Key.Value
                    if ($key -cmatch '[~/]') { $key = $key.Replace('~', '~0').Replace('/', '~1') }
                    $pointer = $at + '/' + $key
                    $map[$pointer] = $pair
                    if ($pair.Value -isnot [YamlDotNet.RepresentationModel.YamlScalarNode]) {
                        $pendingNode.Enqueue($pair.Value)
                        $pendingAt.Enqueue($pointer)
                    }
                }
                continue
            }
            if ($node -is [YamlDotNet.RepresentationModel.YamlSequenceNode]) {
                $index = 0
                foreach ($item in $node.Children) {
                    $pointer = $at + '/' + $index
                    $map[$pointer] = $item
                    if ($item -isnot [YamlDotNet.RepresentationModel.YamlScalarNode]) {
                        $pendingNode.Enqueue($item)
                        $pendingAt.Enqueue($pointer)
                    }
                    $index++
                }
            }
        }
    } finally { $reader.Dispose() }
    return $map
}

function Get-NearestSpelling {
    <#
    .SYNOPSIS
        The nearest candidate within an edit distance of two, or the shortest
        one that shares a prefix with the word, or nothing.
    .DESCRIPTION
        This is what turns "unknown key" into "did you mean asserts". Two is
        the distance that catches a transposition, a doubled letter and a
        dropped one without suggesting an unrelated word.

        Distance alone is not enough for the mistake this format invites most:
        timeout for timeoutSec is three edits away, and so is cleanupTimeout
        for cleanupTimeoutSec. A candidate that one of the two is a prefix of,
        over at least four shared characters, is a strong enough signal on its
        own, so it is the fallback when nothing is within the distance.
    #>
    [CmdletBinding()]
    param([string]$Word, [string[]]$Candidates, [int]$MaxDistance = 2)

    if (-not $Word) { return $null }
    $best = $null
    $bestDistance = $MaxDistance + 1
    foreach ($candidate in @($Candidates)) {
        if (-not $candidate) { continue }
        $distance = Get-EditDistance -Left $Word -Right $candidate
        if ($distance -lt $bestDistance -or ($distance -eq $bestDistance -and $best -and $candidate -lt $best)) {
            if ($distance -le $MaxDistance) { $best = $candidate; $bestDistance = $distance }
        }
    }
    if ($best) { return $best }

    $lower = $Word.ToLowerInvariant()
    foreach ($candidate in @($Candidates | Where-Object { $_ } | Sort-Object Length, { $_ })) {
        $other = $candidate.ToLowerInvariant()
        $shared = [math]::Min($lower.Length, $other.Length)
        if ($shared -lt 4) { continue }
        if ($other.StartsWith($lower) -or $lower.StartsWith($other)) { return $candidate }
    }
    return $null
}

function Get-EditDistance {
    <#
    .SYNOPSIS
        Levenshtein distance, case-insensitive.
    #>
    [CmdletBinding()]
    param([string]$Left, [string]$Right)

    $left = $Left.ToLowerInvariant()
    $right = $Right.ToLowerInvariant()
    if ($left -eq $right) { return 0 }
    if (-not $left.Length) { return $right.Length }
    if (-not $right.Length) { return $left.Length }
    $previous = 0..$right.Length
    for ($i = 1; $i -le $left.Length; $i++) {
        $current = @($i) + (1..$right.Length | ForEach-Object { 0 })
        for ($j = 1; $j -le $right.Length; $j++) {
            $cost = if ($left[$i - 1] -eq $right[$j - 1]) { 0 } else { 1 }
            $current[$j] = [math]::Min([math]::Min($current[$j - 1] + 1, $previous[$j] + 1), $previous[$j - 1] + $cost)
        }
        $previous = $current
    }
    return $previous[$right.Length]
}

function New-SuiteDiagnostic {
    <#
    .SYNOPSIS
        One finding, in the shape diagnostic.schema.json defines.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Code,
        [Parameter(Mandatory)][string]$File,
        [Parameter(Mandatory)][string]$Message,
        $Position,
        [ValidateSet('key', 'value')][string]$At = 'key',
        [string]$Suggestion,
        [ValidateSet('error', 'warning')][string]$Severity = 'error'
    )

    $line = 1
    $column = 1
    if ($Position -is [System.Collections.IDictionary]) {
        $line = if ($At -eq 'value') { $Position.valueLine } else { $Position.keyLine }
        $column = if ($At -eq 'value') { $Position.valueColumn } else { $Position.keyColumn }
    } elseif ($null -ne $Position) {
        # What Get-SuiteNodePosition records: a YAML node, whose key and value
        # start where it does, or a mapping entry, its key and its value.
        $mark = if ($Position -is [YamlDotNet.RepresentationModel.YamlNode]) { $Position.Start } elseif ($At -eq 'value') { $Position.Value.Start } else { $Position.Key.Start }
        $line = $mark.Line
        $column = $mark.Column
    }
    $diagnostic = [ordered]@{
        code     = $Code
        severity = $Severity
        file     = $File
        line     = [int]$line
        column   = [int]$column
        message  = $Message
    }
    if ($Suggestion) { $diagnostic['suggestion'] = $Suggestion }
    return $diagnostic
}

function Split-SchemaErrorPointer {
    <#
    .SYNOPSIS
        The pointer a Test-Json message ends with, and the message without it.
    .DESCRIPTION
        Kept for a caller that still holds Test-Json text. The lint itself no
        longer goes through Test-Json (Invoke-SchemaValidation says why).
    #>
    [CmdletBinding()]
    param([string]$Text)

    $match = [regex]::Match($Text, "^(?:The JSON is not valid with the schema:\s*)?(?<body>.*?)\s+at\s+'(?<pointer>[^']*)'\s*$")
    if (-not $match.Success) { return @{ body = $Text; pointer = '' } }
    return @{ body = $match.Groups['body'].Value; pointer = $match.Groups['pointer'].Value }
}

function Get-RequiredKeyName {
    <#
    .SYNOPSIS
        The key names out of a "Required properties [...]" message.
    #>
    [CmdletBinding()]
    param([string]$Body)
    return @([regex]::Matches($Body, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
}

# Compiled schemas by their text. The document schema is the same for every
# file of a run, and compiling sixty kilobytes of schema per file is time the
# lint does not have; the cache is bounded because each file's per-step schema
# is its own.
$script:CompiledSchemas = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)

function Invoke-SchemaValidation {
    <#
    .SYNOPSIS
        Validate one JSON document against one schema and return every failure
        as @{ body = <message>; pointer = <JSON pointer into the document> }.
    .DESCRIPTION
        Evaluated with JsonSchema.Net directly, not through Test-Json. On
        PowerShell 7.6.7, `Test-Json -Json $j -Schema $s -ErrorVariable e`
        returns False for the suite schema and leaves $e without the failures
        under a nested location, so a lint built on it lost its structural
        (E1xx) findings: the corpus entry validate/typos.yml lost E101 at 4:5
        and 8:5. The library Test-Json wraps reports every failure, in the same
        words, so each one is read here: the message is the body and its
        instance location the pointer, as the Test-Json text
        "<message> at '<pointer>'" used to carry them.
    #>
    [CmdletBinding()]
    param([string]$Json, [string]$Schema)

    $compiled = $null
    if (-not $script:CompiledSchemas.TryGetValue($Schema, [ref]$compiled)) {
        if ($script:CompiledSchemas.Count -ge 64) { $script:CompiledSchemas.Clear() }
        $compiled = [Json.Schema.JsonSchema]::FromText($Schema)
        $script:CompiledSchemas[$Schema] = $compiled
    }
    $options = [Json.Schema.EvaluationOptions]::new()
    $options.OutputFormat = [Json.Schema.OutputFormat]::List
    $result = $compiled.Evaluate([System.Text.Json.Nodes.JsonNode]::Parse($Json), $options)
    if ($result.IsValid) { return @() }

    $found = [Collections.Generic.List[hashtable]]::new()
    $pending = [Collections.Generic.Queue[object]]::new()
    $pending.Enqueue($result)
    while ($pending.Count) {
        $node = $pending.Dequeue()
        if ($node.HasErrors) {
            # ToString, not interpolation: a JsonPointer is enumerable, and
            # "$pointer" would join its segments with spaces.
            $pointer = $node.InstanceLocation.ToString()
            foreach ($key in $node.Errors.Keys) { $found.Add(@{ body = [string]$node.Errors[$key]; pointer = $pointer }) }
        }
        if ($node.HasDetails) { foreach ($detail in $node.Details) { $pending.Enqueue($detail) } }
    }
    return $found.ToArray()
}

function Test-SuiteJson {
    <#
    .SYNOPSIS
        Whether one JSON document satisfies one schema, as Test-Json would say
        if it reported reliably; -Failure receives every failure.
    .DESCRIPTION
        The small helper every caller that used Test-Json goes through
        (Invoke-SchemaValidation says why). -SchemaFile reads the schema from
        a file.
    #>
    [CmdletBinding(DefaultParameterSetName = 'Text')]
    param(
        [Parameter(Mandatory)][string]$Json,
        [Parameter(Mandatory, ParameterSetName = 'Text')][string]$Schema,
        [Parameter(Mandatory, ParameterSetName = 'File')][string]$SchemaFile,
        [ref]$Failure
    )
    if ($SchemaFile) { $Schema = Get-Content -LiteralPath $SchemaFile -Raw }
    $failures = @(Invoke-SchemaValidation -Json $Json -Schema $Schema)
    if ($Failure) { $Failure.Value = $failures }
    return (-not $failures.Count)
}

function Get-SuiteStepEntry {
    <#
    .SYNOPSIS
        Flatten a step list into one entry per step, nested steps included.
    .DESCRIPTION
        An entry carries the step, its JSON pointer, the phase it runs in and an
        order number. Order is what the dataflow pass compares to decide
        whether a capture exists yet: a nested forStep publishes its capture
        just before the step that polls it, so its condition can read it.
    #>
    [CmdletBinding()]
    param($List, [string]$Pointer, [string]$Phase, [int]$BaseOrder)

    $entries = [Collections.Generic.List[hashtable]]::new()
    $index = 0
    foreach ($step in @($List)) {
        if ($null -eq $step) { $index++; continue }
        $order = $BaseOrder + ($index * 10)
        $stepPointer = "$Pointer/$index"
        if ($step -is [System.Collections.IDictionary] -and $step.forStep) {
            $entries.Add(@{ step = $step.forStep; pointer = "$stepPointer/forStep"; phase = $Phase; order = $order - 1 })
        }
        $entries.Add(@{ step = $step; pointer = $stepPointer; phase = $Phase; order = $order })
        $index++
    }
    return $entries.ToArray()
}

function Get-SuiteCasePlan {
    <#
    .SYNOPSIS
        One case as the ordered phases the runner executes it in.
    .DESCRIPTION
        Suite setup and beforeEach come first because their captures are in the
        bag before a case starts; asserts and cleanup come last because they
        can read anything the case produced.
    #>
    [CmdletBinding()]
    param($Model, $Case, [int]$CaseIndex, [hashtable]$HookEntries)

    # The suite's own hooks give every case the same entries. A caller that
    # plans each case of one model passes one table, and they are built once.
    if ($null -eq $HookEntries) { $HookEntries = @{} }
    if (-not $HookEntries.ContainsKey('before')) {
        $HookEntries['before'] = @(Get-SuiteStepEntry -List $Model.setup -Pointer '/setup' -Phase 'suite setup' -BaseOrder -4000) +
            @(Get-SuiteStepEntry -List $Model.beforeEach -Pointer '/beforeEach' -Phase 'beforeEach' -BaseOrder -3000)
        $HookEntries['after'] = @(Get-SuiteStepEntry -List $Model.afterEach -Pointer '/afterEach' -Phase 'afterEach' -BaseOrder 200000)
    }
    # An absent list has no entries, so it is not asked for them.
    $entries = [Collections.Generic.List[hashtable]]::new()
    foreach ($entry in $HookEntries['before']) { $entries.Add($entry) }
    if ($null -ne $Case.setup) { foreach ($entry in Get-SuiteStepEntry -List $Case.setup -Pointer "/tests/$CaseIndex/setup" -Phase 'case setup' -BaseOrder -2000) { $entries.Add($entry) } }
    if ($null -ne $Case.steps) { foreach ($entry in Get-SuiteStepEntry -List $Case.steps -Pointer "/tests/$CaseIndex/steps" -Phase 'steps' -BaseOrder 0) { $entries.Add($entry) } }
    if ($null -ne $Case.cleanup) { foreach ($entry in Get-SuiteStepEntry -List $Case.cleanup -Pointer "/tests/$CaseIndex/cleanup" -Phase 'cleanup' -BaseOrder 100000) { $entries.Add($entry) } }
    foreach ($entry in $HookEntries['after']) { $entries.Add($entry) }
    # The suite teardown is deliberately absent: it runs once, after the last
    # case, and reads the suite bag rather than any case copy (design 5.3), so
    # resolving it against a case would accept references that will not work.
    # Its own scope arrives with the step that executes hooks, Y2.1.
    return $entries.ToArray()
}

function Get-SuiteAllStepEntry {
    <#
    .SYNOPSIS
        Every step in the file, once, for the structural pass.
    #>
    [CmdletBinding()]
    param($Model)

    # Five passes ask for the same file's steps. While Invoke-SuiteLintFile
    # lints one model the answer is kept for it; outside that, or for any other
    # model, it is computed afresh, so a caller that changes a model between
    # calls never reads a stale list.
    $scoped = $null -ne $script:StepEntryScope -and [object]::ReferenceEquals($script:StepEntryScope.model, $Model)
    if ($scoped -and $null -ne $script:StepEntryScope.entries) { return $script:StepEntryScope.entries }

    $entries = [Collections.Generic.List[hashtable]]::new()
    foreach ($hook in @('setup', 'beforeEach', 'afterEach', 'teardown')) {
        # An absent list has no entries, so it is not asked for them.
        if ($null -eq $Model.$hook) { continue }
        foreach ($entry in Get-SuiteStepEntry -List $Model.$hook -Pointer "/$hook" -Phase $hook -BaseOrder 0) { $entries.Add($entry) }
    }
    $metaIndex = 0
    foreach ($meta in @($Model.metaSteps)) {
        if ($null -ne $meta) {
            foreach ($entry in Get-SuiteStepEntry -List $meta.steps -Pointer "/metaSteps/$metaIndex/steps" -Phase "meta $($meta.name)" -BaseOrder 0) { $entries.Add($entry) }
        }
        $metaIndex++
    }
    $caseIndex = 0
    foreach ($case in @($Model.tests)) {
        if ($null -ne $case) {
            foreach ($phase in @('setup', 'steps', 'cleanup')) {
                if ($null -eq $case.$phase) { continue }
                foreach ($entry in Get-SuiteStepEntry -List $case.$phase -Pointer "/tests/$caseIndex/$phase" -Phase $phase -BaseOrder 0) { $entries.Add($entry) }
            }
        }
        $caseIndex++
    }
    $all = $entries.ToArray()
    if ($scoped) { $script:StepEntryScope.entries = $all }
    return $all
}

function Test-SuiteStructure {
    <#
    .SYNOPSIS
        E100 to E105: the file parses, its keys are spelled and typed as the
        schema says, and every step's parameters belong to its action.
    #>
    [CmdletBinding()]
    param($Model, [hashtable]$Positions, [string]$File, [hashtable]$Schema)

    $found = [Collections.Generic.List[hashtable]]::new()
    $json = ConvertTo-Json -InputObject $Model -Depth 64

    # Pass one: the whole document, with per-action step checking deferred.
    foreach ($error in Invoke-SchemaValidation -Json $json -Schema $Schema.lintSchemaText) {
        foreach ($diagnostic in ConvertTo-StructuralDiagnostic -Error $error -Positions $Positions -File $File -Schema $Schema -Model $Model -PointerPrefix '') {
            $found.Add($diagnostic)
        }
    }

    # Pass two: one branch per step, selected by its action name.
    $entries = Get-SuiteAllStepEntry -Model $Model
    $documents = [Collections.Generic.List[object]]::new()
    $branches = [Collections.Generic.List[object]]::new()
    $checked = [Collections.Generic.List[hashtable]]::new()
    foreach ($entry in $entries) {
        $step = $entry.step
        if ($step -isnot [System.Collections.IDictionary]) {
            $found.Add((New-SuiteDiagnostic -Code 'E103' -File $File -Position $Positions[$entry.pointer] -At 'value' `
                        -Message "A step must be a mapping with an action."))
            continue
        }
        $action = [string]$step.action
        if ($action) {
            if (-not $Schema.actions.ContainsKey($action)) {
                $suggestion = Get-NearestSpelling -Word $action -Candidates $Schema.actionNames -MaxDistance 3
                $found.Add((New-SuiteDiagnostic -Code 'E104' -File $File -Position $Positions["$($entry.pointer)/action"] -At 'value' `
                            -Message "Unknown action $action." `
                            -Suggestion $(if ($suggestion) { "Did you mean $suggestion" } else { 'No action of that name is declared in actions.catalog.yaml.' })))
                continue
            }
            $branches.Add([ordered]@{ '$ref' = "#/`$defs/step.$action" })
        } elseif ($step.meta) {
            $branches.Add([ordered]@{ '$ref' = '#/$defs/step.meta' })
        } else {
            $found.Add((New-SuiteDiagnostic -Code 'E102' -File $File -Position $Positions[$entry.pointer] -At 'key' `
                        -Message 'A step declares no action and no meta. One of the two is required.'))
            continue
        }
        $documents.Add($step)
        $checked.Add($entry)
    }

    if ($checked.Count) {
        # One prefixItems branch per step, with its transitive definitions.
        $prefixItems = ConvertTo-Json -InputObject $branches.ToArray() -Depth 5 -Compress
        $stepSchema = '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"steps":{"type":"array","prefixItems":' +
            $prefixItems + '}},"$defs":' + (Get-SuiteReferencedDefinitions -Definitions $Schema.defsText -Document $prefixItems) + '}'
        $stepJson = ConvertTo-Json -InputObject @{ steps = $documents.ToArray() } -Depth 64
        foreach ($error in Invoke-SchemaValidation -Json $stepJson -Schema $stepSchema) {
            $match = [regex]::Match($error.pointer, '^/steps/(?<index>\d+)(?<rest>.*)$')
            if (-not $match.Success) { continue }
            $entry = $checked[[int]$match.Groups['index'].Value]
            $real = @{ body = $error.body; pointer = $entry.pointer + $match.Groups['rest'].Value }
            foreach ($diagnostic in ConvertTo-StructuralDiagnostic -Error $real -Positions $Positions -File $File -Schema $Schema -Model $Model -PointerPrefix '' -StepEntry $entry) {
                $found.Add($diagnostic)
            }
        }
    }
    return $found.ToArray()
}

function ConvertTo-StructuralDiagnostic {
    <#
    .SYNOPSIS
        One schema message as one or more diagnostics, with a position and a
        suggestion drawn from the keys that are legal where it happened.
    #>
    [CmdletBinding()]
    param([hashtable]$Error, [hashtable]$Positions, [string]$File, [hashtable]$Schema, $Model, [string]$PointerPrefix, [hashtable]$StepEntry)

    $found = [Collections.Generic.List[hashtable]]::new()
    $pointer = $Error.pointer
    $body = $Error.body

    if ($body -match '^Required properties') {
        foreach ($name in Get-RequiredKeyName -Body $body) {
            $found.Add((New-SuiteDiagnostic -Code 'E102' -File $File -Position $Positions[$pointer] -At 'key' `
                        -Message "Required key $name is missing from $(Format-PointerName -Pointer $pointer)."))
        }
        return $found.ToArray()
    }

    if ($body -match 'false schema') {
        # The pointer ends at the key nothing declares.
        $segments = @($pointer -split '/')
        $key = $segments[-1]
        $parent = ($segments[0..($segments.Count - 2)] -join '/')
        $legal = Get-LegalKey -Pointer $parent -Schema $Schema -Model $Model -StepEntry $StepEntry
        $suggestion = Get-NearestSpelling -Word $key -Candidates $legal.keys
        $code = if ($legal.kind -eq 'action') { 'E105' } else { 'E101' }
        $message = if ($code -eq 'E105') {
            "Action $($legal.action) takes no parameter $key."
        } else {
            "Unknown key $key in $(Format-PointerName -Pointer $parent)."
        }
        $found.Add((New-SuiteDiagnostic -Code $code -File $File -Position $Positions[$pointer] -At 'key' `
                    -Message $message -Suggestion $(if ($suggestion) { "Did you mean $suggestion" })))
        return $found.ToArray()
    }

    $found.Add((New-SuiteDiagnostic -Code 'E103' -File $File -Position $Positions[$pointer] -At 'value' `
                -Message ("$(Format-PointerName -Pointer $pointer) has a value the schema refuses: " + $body + '.')))
    return $found.ToArray()
}

function Format-PointerName {
    <#
    .SYNOPSIS
        A JSON pointer as something a suite author recognises.
    #>
    [CmdletBinding()]
    param([string]$Pointer)
    if (-not $Pointer) { return 'the suite' }
    return ('the suite at ' + $Pointer)
}

function Get-LegalKey {
    <#
    .SYNOPSIS
        The keys that are legal at one pointer, for a suggestion.
    .DESCRIPTION
        Read out of the schema and the catalog rather than listed here, so a
        key added to either is offered without this function changing.
    #>
    [CmdletBinding()]
    param([string]$Pointer, [hashtable]$Schema, $Model, [hashtable]$StepEntry)

    if ($StepEntry) {
        $action = [string]$StepEntry.step.action
        if ($action -and $Schema.actions.ContainsKey($action)) {
            $keys = @($Schema.stepCommonKeys)
            foreach ($param in @($Schema.actions[$action].params)) {
                if ($null -ne $param) { $keys += [string]$param.name }
            }
            return @{ kind = 'action'; action = $action; keys = $keys }
        }
        return @{ kind = 'step'; keys = @($Schema.schema.'$defs'.'step.meta'.properties.PSObject.Properties.Name) }
    }

    $definition = switch -Regex ($Pointer) {
        '^$' { $Schema.schema; break }
        '^/defaults$' { $Schema.schema.'$defs'.defaults; break }
        '^/tests/\d+$' { $Schema.schema.'$defs'.case; break }
        '^/tests/\d+/asserts/\d+$' { $Schema.schema.'$defs'.assert; break }
        '^/metaSteps/\d+$' { $Schema.schema.'$defs'.metaStep; break }
        '^/metaSteps/\d+/params/\d+$' { $Schema.schema.'$defs'.metaParamDecl; break }
        '(^|/)params/\d+$' { $Schema.schema.'$defs'.paramDecl; break }
        default { $null }
    }
    if ($definition) { return @{ kind = 'schema'; keys = @($definition.properties.PSObject.Properties.Name) } }
    return @{ kind = 'unknown'; keys = @() }
}

function Test-SuiteAssertionShape {
    <#
    .SYNOPSIS
        E204: an assertion that compares nothing, wherever it is written.
    .DESCRIPTION
        Only a declared operator counts. A misspelled one is both an unknown key
        and an assertion that compares nothing, and the author needs both
        sentences: one says the word is wrong, the other says the consequence.
    #>
    [CmdletBinding()]
    param($Assertions, [string]$Pointer, [string]$Where, [hashtable]$Schema, [hashtable]$Positions, [string]$File)

    $found = [Collections.Generic.List[hashtable]]::new()
    $index = 0
    foreach ($assertion in @($Assertions)) {
        if ($null -ne $assertion -and $assertion -is [System.Collections.IDictionary]) {
            $operators = @(foreach ($key in (Get-KeyList $assertion)) { if ($Schema.assertOperators -ccontains $key) { $key } })
            if (-not $operators.Count -and $assertion.var) {
                $found.Add((New-SuiteDiagnostic -Code 'E204' -File $File -Position $Positions["$Pointer/$index"] -At 'key' `
                            -Message "The assertion on $($assertion.var) in $Where names a subject and no comparison, so it asserts nothing." `
                            -Suggestion ('One of: ' + (@($Schema.assertOperators) -join ', '))))
            } elseif (-not $assertion.var -and -not $assertion.script) {
                $found.Add((New-SuiteDiagnostic -Code 'E204' -File $File -Position $Positions["$Pointer/$index"] -At 'key' `
                            -Message "An assertion in $Where names no subject. Add var, or use script."))
            }
        }
        $index++
    }
    return $found.ToArray()
}

function Get-SuiteStepList {
    <#
    .SYNOPSIS
        Every step list in the file, as a list, with its pointer and a name.
    .DESCRIPTION
        The Gherkin keyword rules are per list, not per file: a case's steps are
        one scenario, and its cleanup is not part of it. So this returns lists
        rather than the flattened steps Get-SuiteAllStepEntry gives.
    #>
    [CmdletBinding()]
    param($Model)

    $lists = [Collections.Generic.List[hashtable]]::new()
    foreach ($hook in @('setup', 'beforeEach', 'afterEach', 'teardown')) {
        if ($Model.$hook) { $lists.Add(@{ steps = $Model.$hook; pointer = "/$hook"; name = "the suite $hook" }) }
    }
    $metaIndex = 0
    foreach ($meta in @($Model.metaSteps)) {
        if ($null -ne $meta -and $meta.steps) {
            $lists.Add(@{ steps = $meta.steps; pointer = "/metaSteps/$metaIndex/steps"; name = "meta step $($meta.name)" })
        }
        $metaIndex++
    }
    $caseIndex = 0
    foreach ($case in @($Model.tests)) {
        if ($null -ne $case) {
            foreach ($phase in @('setup', 'steps', 'cleanup')) {
                if ($case.$phase) {
                    $lists.Add(@{ steps = $case.$phase; pointer = "/tests/$caseIndex/$phase"; name = "case $($case.name) $phase"; case = $case; caseIndex = $caseIndex })
                }
            }
        }
        $caseIndex++
    }
    return $lists.ToArray()
}

function Get-TableColumn {
    <#
    .SYNOPSIS
        The columns a table declares, from its first row.
    #>
    [CmdletBinding()]
    param($Table)
    foreach ($row in @($Table)) {
        if ($null -ne $row) { return (Get-KeyList $row) }
    }
    return @()
}

function Test-SuiteTable {
    <#
    .SYNOPSIS
        E213: a table whose rows do not agree, or repeat.
    #>
    [CmdletBinding()]
    param($Table, [string]$Pointer, [string]$Where, [hashtable]$Positions, [string]$File)

    $found = [Collections.Generic.List[hashtable]]::new()
    $rows = @($Table | Where-Object { $null -ne $_ })
    if (-not $rows.Count) {
        $found.Add((New-SuiteDiagnostic -Code 'E213' -File $File -Position $Positions[$Pointer] -At 'key' `
                    -Message "The table on $Where has no rows, so the step it drives would never run."))
        return $found.ToArray()
    }
    $columns = Get-TableColumn -Table $rows
    $seenRow = @{}
    $index = 0
    foreach ($row in @($Table)) {
        if ($null -eq $row) { $index++; continue }
        $rowColumns = Get-KeyList $row
        $missing = @($columns | Where-Object { $rowColumns -cnotcontains $_ })
        $extra = @($rowColumns | Where-Object { $columns -cnotcontains $_ })
        if ($missing.Count -or $extra.Count) {
            $found.Add((New-SuiteDiagnostic -Code 'E213' -File $File -Position $Positions["$Pointer/$index"] -At 'key' `
                        -Message ("Row $($index + 1) of the table on $Where does not declare the same columns as the first row: " +
                            (@(@($missing | ForEach-Object { "$_ is missing" }) + @($extra | ForEach-Object { "$_ is extra" })) -join ', ') + '.')))
        }
        $signature = (@($rowColumns | Sort-Object | ForEach-Object { "$_=$($row[$_])" }) -join "`u{1}")
        if ($seenRow.ContainsKey($signature)) {
            $found.Add((New-SuiteDiagnostic -Code 'E213' -File $File -Position $Positions["$Pointer/$index"] -At 'key' `
                        -Message "Row $($index + 1) of the table on $Where repeats row $($seenRow[$signature]), which would give two iterations the same name."))
        } else {
            $seenRow[$signature] = $index + 1
        }
        $index++
    }
    return $found.ToArray()
}

function Test-SuiteScenario {
    <#
    .SYNOPSIS
        E212, E213 and W304: the Gherkin keywords are used in order, and every
        table agrees with itself.
    .DESCRIPTION
        DEC-Y22 to DEC-Y24. A keyword is optional, so a suite can be labelled a
        case at a time and a half-labelled list is a warning. What is refused is
        a list that cannot be read as a scenario at all: two keywords on one
        step, an and with nothing to continue, or a given after a then.
    #>
    [CmdletBinding()]
    param($Model, [hashtable]$Positions, [string]$File)

    $found = [Collections.Generic.List[hashtable]]::new()
    $keywords = @('given', 'when', 'then', 'and')
    $rank = @{ given = 1; when = 2; then = 3 }

    foreach ($list in Get-SuiteStepList -Model $Model) {
        $previous = $null
        $highest = 0
        $labelled = 0
        $total = 0
        $index = 0
        foreach ($step in @($list.steps)) {
            if ($null -eq $step -or $step -isnot [System.Collections.IDictionary]) { $index++; continue }
            $stepPointer = "$($list.pointer)/$index"
            # A mapping's keys, which Get-KeyList would give, read in place.
            $present = @(foreach ($key in $step.Keys) { if ($null -ne $key -and $keywords -ccontains $key) { $key } })
            # A meta use site that carries no keyword of its own stands for the
            # steps of its definition, and those carry theirs. Counting it as an
            # unlabelled step would warn about a case that reads as a scenario
            # everywhere it is actually written.
            if ($present.Count -or $null -eq $step.meta) { $total++ }
            if ($present.Count -gt 1) {
                $found.Add((New-SuiteDiagnostic -Code 'E212' -File $File -Position $Positions["$stepPointer/$($present[1])"] -At 'key' `
                            -Message ("Step $($index + 1) of $($list.name) carries " + (@($present) -join ' and ') + '. A step carries one Gherkin keyword.')))
            }
            if ($present.Count) {
                $labelled++
                $keyword = $present[0]
                if ($keyword -eq 'and') {
                    if (-not $previous) {
                        $found.Add((New-SuiteDiagnostic -Code 'E212' -File $File -Position $Positions["$stepPointer/and"] -At 'key' `
                                    -Message "Step $($index + 1) of $($list.name) is an and with nothing before it to continue." `
                                    -Suggestion 'Start the list with given, when or then.'))
                    }
                } else {
                    if ($rank[$keyword] -lt $highest) {
                        $found.Add((New-SuiteDiagnostic -Code 'E212' -File $File -Position $Positions["$stepPointer/$keyword"] -At 'key' `
                                    -Message "Step $($index + 1) of $($list.name) is a $keyword after a $(($rank.Keys | Where-Object { $rank[$_] -eq $highest })). The order is given, then when, then then." `
                                    -Suggestion 'Continue with and, or move the step.'))
                    }
                    if ($rank[$keyword] -gt $highest) { $highest = $rank[$keyword] }
                    $previous = $keyword
                }
            }
            if ($null -ne $step.table) {
                foreach ($diagnostic in Test-SuiteTable -Table $step.table -Pointer "$stepPointer/table" `
                        -Where "step $($index + 1) of $($list.name)" -Positions $Positions -File $File) {
                    $found.Add($diagnostic)
                }
                if ($list.case -and $list.case.examples) {
                    $found.Add((New-SuiteDiagnostic -Code 'E213' -File $File -Position $Positions["$stepPointer/table"] -At 'key' `
                                -Message "Step $($index + 1) of $($list.name) carries a table inside a case that already carries examples. There is one row namespace, and two row scopes would shadow each other." `
                                -Suggestion 'Keep the table and drop the examples, or the other way round.'))
                }
            }
            $index++
        }
        if ($labelled -and $labelled -lt $total) {
            $found.Add((New-SuiteDiagnostic -Code 'W304' -Severity 'warning' -File $File -Position $Positions[$list.pointer] -At 'key' `
                        -Message "$($list.name) labels $labelled of its $total steps with a Gherkin keyword. Label all of them or none."))
        }
    }

    $caseIndex = 0
    foreach ($case in @($Model.tests)) {
        if ($null -ne $case -and $null -ne $case.examples) {
            foreach ($diagnostic in Test-SuiteTable -Table $case.examples -Pointer "/tests/$caseIndex/examples" `
                    -Where "case $($case.name)" -Positions $Positions -File $File) {
                $found.Add($diagnostic)
            }
        }
        $caseIndex++
    }
    return $found.ToArray()
}

function Test-SuiteLimit {
    <#
    .SYNOPSIS
        E205: every declared limit is a positive number under its ceiling.
    .DESCRIPTION
        The core's ceiling is the one the runner enforces on every limit,
        14400 seconds. A workspace that holds some suites to a stricter one (a
        tag-based budget, say) adds it as an extension rule, which reports
        E205 the same way and is run after this pass (DEC-S03).
    #>
    [CmdletBinding()]
    param($Model, [hashtable]$Positions, [string]$File)

    $found = [Collections.Generic.List[hashtable]]::new()
    $limits = [Collections.Generic.List[hashtable]]::new()
    foreach ($key in @('setupTimeoutSec', 'beforeEachTimeoutSec', 'afterEachTimeoutSec', 'teardownTimeoutSec')) {
        if ($null -ne $Model.$key) { $limits.Add(@{ pointer = "/$key"; name = $key; value = $Model.$key; scope = 'the suite' }) }
    }
    foreach ($key in @('timeoutSec', 'cleanupTimeoutSec')) {
        if ($Model.defaults -and $null -ne $Model.defaults.$key) {
            $limits.Add(@{ pointer = "/defaults/$key"; name = $key; value = $Model.defaults.$key; scope = 'the suite defaults' })
        }
    }
    $caseIndex = 0
    foreach ($case in @($Model.tests)) {
        if ($null -ne $case) {
            foreach ($key in @('timeoutSec', 'cleanupTimeoutSec', 'setupTimeoutSec')) {
                if ($null -ne $case.$key) {
                    $limits.Add(@{ pointer = "/tests/$caseIndex/$key"; name = $key; value = $case.$key; scope = "case $($case.name)" })
                }
            }
        }
        $caseIndex++
    }

    foreach ($limit in $limits) {
        $position = $Positions[$limit.pointer]
        $ceiling = $script:LimitCeilingSec
        if ($limit.value -is [string]) { continue }   # an expression; its value is checked when it is evaluated
        $seconds = 0
        if (-not [int]::TryParse([string]$limit.value, [ref]$seconds)) { continue }   # the schema already refused it
        if ($seconds -lt 1 -or $seconds -gt $ceiling) {
            $found.Add((New-SuiteDiagnostic -Code 'E205' -File $File -Position $position -At 'value' `
                        -Message "$($limit.name) on $($limit.scope) is $seconds seconds, outside 1 to $ceiling."))
        }
    }
    return $found.ToArray()
}

function Test-SuiteSemantics {
    <#
    .SYNOPSIS
        E201 to E211: what a schema cannot see.
    #>
    [CmdletBinding()]
    param($Model, [hashtable]$Positions, [string]$File, [string]$FilePath, [hashtable]$Schema,
        [string]$Binding, [bool]$BindingCheck, [hashtable]$Library, [hashtable]$CommandLineParam,
        [string]$EnvPrefix = $script:DefaultEnvPrefix)

    $found = [Collections.Generic.List[hashtable]]::new()

    # E202: two cases a report cannot tell apart. Names compare exactly, as in
    # every runtime: a PowerShell hashtable would ignore case and refuse
    # 'places an order' beside 'PLACES AN ORDER', which the others accept.
    $seenCase = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $caseIndex = 0
    foreach ($case in @($Model.tests)) {
        if ($null -eq $case) { $caseIndex++; continue }
        $name = [string]$case.name
        if (-not $seenCase.Add($name)) {
            $found.Add((New-SuiteDiagnostic -Code 'E202' -File $File -Position $Positions["/tests/$caseIndex/name"] -At 'value' `
                        -Message "Case $name is declared twice in this suite."))
        }
        $caseIndex++
    }

    # E203: one case capturing the same name twice, where the second silently
    # replaces the first. E204: an assertion that asserts nothing.
    $caseIndex = 0
    foreach ($case in @($Model.tests)) {
        if ($null -eq $case) { $caseIndex++; continue }
        $seenCapture = @{}
        foreach ($phase in @('setup', 'steps', 'cleanup')) {
            if ($null -eq $case.$phase) { continue }   # an absent list has no entries
            foreach ($entry in Get-SuiteStepEntry -List $case.$phase -Pointer "/tests/$caseIndex/$phase" -Phase $phase -BaseOrder 0) {
                $name = [string]$entry.step.captureAs
                if (-not $name) { continue }
                if ($seenCapture.ContainsKey($name)) {
                    $found.Add((New-SuiteDiagnostic -Code 'E203' -File $File -Position $Positions["$($entry.pointer)/captureAs"] -At 'value' `
                                -Message "Case $($case.name) already captures $name. The second would replace the first."))
                }
                $seenCapture[$name] = $true
            }
        }
        foreach ($diagnostic in Test-SuiteAssertionShape -Assertions $case.asserts -Pointer "/tests/$caseIndex/asserts" `
                -Where "case $($case.name)" -Schema $Schema -Positions $Positions -File $File) {
            $found.Add($diagnostic)
        }
        $caseIndex++
    }
    # A step may assert wherever it is written, so the check follows the steps
    # rather than the cases: a hook and a meta step are held to it too.
    foreach ($entry in Get-SuiteAllStepEntry -Model $Model) {
        # A step with no assertions has none to check.
        if ($null -eq $entry.step.asserts) { continue }
        foreach ($diagnostic in Test-SuiteAssertionShape -Assertions $entry.step.asserts -Pointer "$($entry.pointer)/asserts" `
                -Where "a $($entry.phase) step" -Schema $Schema -Positions $Positions -File $File) {
            $found.Add($diagnostic)
        }
    }

    foreach ($diagnostic in Test-SuiteLimit -Model $Model -Positions $Positions -File $File) { $found.Add($diagnostic) }
    foreach ($diagnostic in Test-SuiteScenario -Model $Model -Positions $Positions -File $File) { $found.Add($diagnostic) }

    # E206, E207, E208: meta steps exist, do not form a cycle, and are used
    # with the parameters they declare.
    $definitions = @{}
    $metaIndex = 0
    foreach ($meta in @($Model.metaSteps)) {
        if ($null -ne $meta) { $definitions[[string]$meta.name] = @{ definition = $meta; pointer = "/metaSteps/$metaIndex" } }
        $metaIndex++
    }
    foreach ($name in (Get-KeyList $Library.metaSteps)) {
        if (-not $definitions.ContainsKey($name)) { $definitions[$name] = @{ definition = $Library.metaSteps[$name]; pointer = '' } }
    }
    foreach ($entry in Get-SuiteAllStepEntry -Model $Model) {
        $used = [string]$entry.step.meta
        if (-not $used) { continue }
        if (-not $definitions.ContainsKey($used)) {
            $found.Add((New-SuiteDiagnostic -Code 'E206' -File $File -Position $Positions["$($entry.pointer)/meta"] -At 'value' `
                        -Message "No meta step named $used is declared or imported." `
                        -Suggestion (Get-NearestSpelling -Word $used -Candidates @($definitions.Keys))))
            continue
        }
        $declared = @()
        foreach ($param in @($definitions[$used].definition.params)) { if ($null -ne $param) { $declared += [string]$param.name } }
        $supplied = @()
        if ($entry.step.with) { $supplied = (Get-KeyList $entry.step.with) }
        foreach ($param in @($definitions[$used].definition.params)) {
            if ($null -eq $param) { continue }
            if ($param.required -and $supplied -cnotcontains [string]$param.name -and $null -eq $param.default) {
                $found.Add((New-SuiteDiagnostic -Code 'E208' -File $File -Position $Positions["$($entry.pointer)/meta"] -At 'value' `
                            -Message "Meta step $used requires the parameter $($param.name), and this use site does not pass it."))
            }
        }
        foreach ($name in $supplied) {
            if ($declared -cnotcontains $name) {
                $found.Add((New-SuiteDiagnostic -Code 'E208' -File $File -Position $Positions["$($entry.pointer)/with/$name"] -At 'key' `
                            -Message "Meta step $used declares no parameter $name." `
                            -Suggestion (Get-NearestSpelling -Word $name -Candidates $declared)))
            }
        }
    }
    foreach ($diagnostic in Test-MetaStepCycle -Definitions $definitions -Positions $Positions -File $File) { $found.Add($diagnostic) }

    # E209: a local declaration that silently shadows an imported one.
    foreach ($collision in @($Library.collisions)) {
        $found.Add((New-SuiteDiagnostic -Code 'E209' -File $File -Position $Positions[$collision.pointer] -At 'key' `
                    -Message "$($collision.kind) $($collision.name) is already declared by the imported $($collision.source)." `
                    -Suggestion 'Add override: true to say that the replacement is deliberate.'))
    }
    foreach ($diagnostic in @($Library.diagnostics)) { $found.Add($diagnostic) }

    # E210: a parameter with no value anywhere, and a --param nobody declared.
    $declaredParams = @{}
    foreach ($name in (Get-KeyList $Library.params)) { $declaredParams[$name] = $Library.params[$name] }
    $paramIndex = 0
    foreach ($param in @($Model.params)) {
        if ($null -ne $param) {
            $declaredParams[[string]$param.name] = @{ hasValue = ($null -ne $param.default -or $null -ne $param.value -or $param.input); pointer = "/params/$paramIndex" }
        }
        $paramIndex++
    }
    $caseIndex = 0
    foreach ($case in @($Model.tests)) {
        if ($null -ne $case) {
            $casePI = 0
            foreach ($param in @($case.params)) {
                if ($null -ne $param) {
                    $name = [string]$param.name
                    if (-not $declaredParams.ContainsKey($name)) {
                        $declaredParams[$name] = @{ hasValue = $false; pointer = "/tests/$caseIndex/params/$casePI" }
                    }
                    if ($null -ne $param.value -or $null -ne $param.default -or $param.input) { $declaredParams[$name].hasValue = $true }
                }
                $casePI++
            }
        }
        $caseIndex++
    }
    foreach ($name in @($declaredParams.Keys | Sort-Object)) {
        $declaration = $declaredParams[$name]
        if ($declaration.hasValue) { continue }
        if ($CommandLineParam -and $CommandLineParam.ContainsKey($name)) { continue }
        if ($null -ne [Environment]::GetEnvironmentVariable("$($EnvPrefix)PARAM_$($name.ToUpperInvariant())")) { continue }
        $found.Add((New-SuiteDiagnostic -Code 'E210' -File $File -Position $Positions[$declaration.pointer] -At 'key' `
                    -Message "Parameter $name has no value at any level and no default." `
                    -Suggestion "Give it a default, or pass --param $name=<value>."))
    }
    foreach ($name in (Get-KeyList $CommandLineParam)) {
        if (-not $declaredParams.ContainsKey($name)) {
            $found.Add((New-SuiteDiagnostic -Code 'E210' -File $File -Position $Positions[''] -At 'key' `
                        -Message "--param $name names a parameter this suite does not declare." `
                        -Suggestion (Get-NearestSpelling -Word $name -Candidates @($declaredParams.Keys))))
        }
    }

    # E201 and W302: the action exists for the binding that was asked for, and
    # is not one the catalog has retired.
    foreach ($entry in Get-SuiteAllStepEntry -Model $Model) {
        $action = [string]$entry.step.action
        if (-not $action -or -not $Schema.actions.ContainsKey($action)) { continue }
        $declaration = $Schema.actions[$action]
        if ($declaration.deprecated) {
            $found.Add((New-SuiteDiagnostic -Code 'W302' -Severity 'warning' -File $File -Position $Positions["$($entry.pointer)/action"] -At 'value' `
                        -Message "Action $action is marked deprecated in the catalog."))
        }
        if (-not $BindingCheck) { continue }
        $bindings = @($declaration.bindings)
        if ($bindings -cnotcontains $Binding) {
            $found.Add((New-SuiteDiagnostic -Code 'E201' -File $File -Position $Positions["$($entry.pointer)/action"] -At 'value' `
                        -Message "The $Binding binding does not implement $action. Implemented by: $(@($bindings) -join ', ')."))
        }
    }
    return $found.ToArray()
}

function Test-MetaStepCycle {
    <#
    .SYNOPSIS
        E207: meta steps that use each other in a circle, or nest too deeply.
    #>
    [CmdletBinding()]
    param([hashtable]$Definitions, [hashtable]$Positions, [string]$File)

    $found = [Collections.Generic.List[hashtable]]::new()
    foreach ($name in @($Definitions.Keys | Sort-Object)) {
        $seen = [Collections.Generic.List[string]]::new()
        $result = Measure-MetaStepDepth -Name $name -Definitions $Definitions -Path $seen
        if ($result.cycle) {
            $found.Add((New-SuiteDiagnostic -Code 'E207' -File $File -Position $Positions[$Definitions[$name].pointer] -At 'key' `
                        -Message "Meta step $name is part of a cycle: $($result.cycle -join ' uses ')."))
        } elseif ($result.depth -gt 5) {
            $found.Add((New-SuiteDiagnostic -Code 'E207' -File $File -Position $Positions[$Definitions[$name].pointer] -At 'key' `
                        -Message "Meta step $name nests $($result.depth) deep, and five is the limit."))
        }
    }
    return $found.ToArray()
}

function Measure-MetaStepDepth {
    <#
    .SYNOPSIS
        How deep one meta step nests, or the cycle it is part of.
    #>
    [CmdletBinding()]
    param([string]$Name, [hashtable]$Definitions, [Collections.Generic.List[string]]$Path)

    if ($Path -ccontains $Name) {
        $cycle = @($Path) + @($Name)
        return @{ depth = $Path.Count; cycle = $cycle }
    }
    if (-not $Definitions.ContainsKey($Name)) { return @{ depth = $Path.Count; cycle = $null } }
    $Path.Add($Name)
    $deepest = $Path.Count
    foreach ($step in @($Definitions[$Name].definition.steps)) {
        if ($null -eq $step -or -not $step.meta) { continue }
        $inner = Measure-MetaStepDepth -Name ([string]$step.meta) -Definitions $Definitions -Path $Path
        if ($inner.cycle) { $Path.RemoveAt($Path.Count - 1); return $inner }
        if ($inner.depth -gt $deepest) { $deepest = $inner.depth }
    }
    $Path.RemoveAt($Path.Count - 1)
    return @{ depth = $deepest; cycle = $null }
}

function Resolve-SuiteImport {
    <#
    .SYNOPSIS
        Read the declaration libraries a suite imports, depth-first in order.
    .DESCRIPTION
        Returns the names a library contributes, the collisions a local
        declaration makes without override: true (E209), the diagnostics the
        libraries themselves produce: a library that declares something that
        runs (E211) and an import cycle (E207), and `imports`: every import the
        suite names, in order, as written, with its full path and its pointer,
        which an extension's lint rule reads (a rule about one library is a
        workspace's, never the core's).
    #>
    [CmdletBinding()]
    param($Model, [hashtable]$Positions, [string]$File, [string]$FilePath, [string]$RepositoryRoot)

    $library = @{ params = @{}; vars = @{}; metaSteps = @{}; defaults = @{}; collisions = @(); diagnostics = @(); imports = @() }
    $imports = [Collections.Generic.List[hashtable]]::new()
    $diagnostics = [Collections.Generic.List[hashtable]]::new()
    $collisions = [Collections.Generic.List[hashtable]]::new()
    $visited = [Collections.Generic.List[string]]::new()
    $visited.Add([IO.Path]::GetFullPath($FilePath))

    $index = 0
    foreach ($import in @($Model.imports)) {
        if (-not $import) { $index++; continue }
        $position = $Positions["/imports/$index"]
        $path = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $FilePath) $import))
        $imports.Add(@{ import = [string]$import; path = $path; pointer = "/imports/$index" })
        if ($visited -contains $path) {
            $diagnostics.Add((New-SuiteDiagnostic -Code 'E207' -File $File -Position $position -At 'value' `
                        -Message "Import $import forms a cycle."))
            $index++
            continue
        }
        if (-not (Test-Path -LiteralPath $path)) {
            $diagnostics.Add((New-SuiteDiagnostic -Code 'E301' -File $File -Position $position -At 'value' `
                        -Message "Import $import does not exist."))
            $index++
            continue
        }
        $visited.Add($path)
        $text = Get-Content -LiteralPath $path -Raw
        $imported = $null
        # Most suites import the same library, and its model depends only on
        # its text, so each text is parsed once per session. Nothing writes to
        # an imported model; the library below only reads it.
        try {
            if ($null -ne $text -and $script:ImportModelCache.ContainsKey($text)) { $imported = $script:ImportModelCache[$text] }
            else {
                $imported = ConvertFrom-SuiteYaml $text
                if ($null -ne $text) { $script:ImportModelCache[$text] = $imported }
            }
        } catch {
            $diagnostics.Add((New-SuiteDiagnostic -Code 'E100' -File $File -Position $position -At 'value' `
                        -Message "Import $import is not valid YAML: $($_.Exception.Message)"))
            $index++
            continue
        }
        foreach ($key in (Get-KeyList $imported)) {
            if ($script:LibraryKeys -cnotcontains $key) {
                $diagnostics.Add((New-SuiteDiagnostic -Code 'E211' -File $File -Position $position -At 'value' `
                            -Message "Import $import declares $key. A library declares $(($script:LibraryKeys) -join ', ') and nothing that runs."))
            }
        }
        foreach ($param in @($imported.params)) {
            if ($null -ne $param) { $library.params[[string]$param.name] = @{ hasValue = ($null -ne $param.default -or $param.input); pointer = "/imports/$index" } }
        }
        foreach ($name in (Get-KeyList $imported.vars)) { $library.vars[$name] = $import }
        foreach ($meta in @($imported.metaSteps)) {
            if ($null -ne $meta) { $library.metaSteps[[string]$meta.name] = $meta }
        }
        foreach ($name in (Get-KeyList $imported.defaults)) { $library.defaults[$name] = $import }
        $index++
    }

    # A local declaration that reuses an imported name has to say so.
    $metaIndex = 0
    foreach ($meta in @($Model.metaSteps)) {
        if ($null -ne $meta -and $library.metaSteps.ContainsKey([string]$meta.name) -and -not $meta.override) {
            $collisions.Add(@{ kind = 'Meta step'; name = [string]$meta.name; source = 'library'; pointer = "/metaSteps/$metaIndex/name" })
        }
        $metaIndex++
    }
    $paramIndex = 0
    foreach ($param in @($Model.params)) {
        if ($null -ne $param -and $library.params.ContainsKey([string]$param.name) -and -not $param.override) {
            $collisions.Add(@{ kind = 'Parameter'; name = [string]$param.name; source = 'library'; pointer = "/params/$paramIndex/name" })
        }
        $paramIndex++
    }
    foreach ($name in (Get-KeyList $Model.vars)) {
        if ($library.vars.ContainsKey($name)) {
            $collisions.Add(@{ kind = 'Variable'; name = $name; source = $library.vars[$name]; pointer = "/vars/$name" })
        }
    }
    $library.collisions = $collisions.ToArray()
    $library.diagnostics = $diagnostics.ToArray()
    $library.imports = $imports.ToArray()
    return $library
}

function Read-ExpressionReference {
    <#
    .SYNOPSIS
        The paths and the function names inside one expression.
    .DESCRIPTION
        Y2.6 made `${...}` an expression rather than a dotted path, so the
        dataflow pass reads it with the same tokeniser the evaluator uses rather
        than splitting on dots: `${upper(var.region)}` names one function and one
        path, and only the path resolves against the model.

        A syntax error comes back as E305 rather than as a path nobody can
        resolve, because "resolves to nothing" is the wrong sentence for a
        missing bracket.
    #>
    [CmdletBinding()]
    param([string]$Text, [switch]$Stable)

    # The answer depends only on the text and the switch, and a suite repeats
    # the same few expressions many times, so each is read once per session
    # (the two-second lint budget of Y1). Callers only read the answer.
    $key = "$([bool]$Stable)|$Text"
    if ($script:ExpressionReferenceCache.ContainsKey($key)) { return $script:ExpressionReferenceCache[$key] }
    $result = Read-ExpressionReferenceUncached -Text $Text -Stable:$Stable
    $script:ExpressionReferenceCache[$key] = $result
    return $result
}

$script:ExpressionReferenceCache = @{}
# An imported library's text to its model; ordinal, because two texts that
# differ only in case are two different libraries.
$script:ImportModelCache = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
# Set by Invoke-SuiteLintFile for the model it is linting; read by Get-SuiteAllStepEntry.
$script:StepEntryScope = $null

function Read-ExpressionReferenceUncached {
    param([string]$Text, [switch]$Stable)

    $result = @{ paths = @(); functions = @(); error = $null }
    $tokens = $null
    try { $tokens = ConvertTo-ExpressionToken -Text $Text } catch {
        $result.error = $_.Exception.Message
        return $result
    }
    # Parsed as well as tokenised, with every value a benign 1, so that a
    # missing operand or an unclosed bracket is reported here rather than during
    # a lab run. E306 and E307 come back the same way, and E309 when the caller
    # says this value has to be the same on every run.
    try { $null = Invoke-SuiteExpression -Text $Text -SyntaxOnly -AllowNonDeterministic (-not $Stable) } catch {
        $result.error = $_.Exception.Message
        return $result
    }
    $paths = [Collections.Generic.List[string[]]]::new()
    $functions = [Collections.Generic.List[string]]::new()
    $keywords = @('and', 'or', 'not', 'true', 'false', 'null')
    $index = 0
    while ($index -lt $tokens.Count) {
        $token = $tokens[$index]
        if ($token.kind -ne 'name') { $index++; continue }
        if ($keywords -ccontains $token.value) { $index++; continue }
        # The list always ends with an end token, so a name always has a next.
        $next = $tokens[$index + 1]
        if ($next.kind -eq 'operator' -and $next.value -eq '(') {
            $functions.Add([string]$token.value)
            $index += 2
            continue
        }
        $segments = [Collections.Generic.List[string]]::new()
        $segments.Add([string]$token.value)
        $index++
        while ($index + 1 -lt $tokens.Count -and $tokens[$index].kind -eq 'operator' -and $tokens[$index].value -eq '.') {
            $segments.Add([string]$tokens[$index + 1].value)
            $index += 2
        }
        $paths.Add($segments.ToArray())
    }
    $result.paths = $paths.ToArray()
    $result.functions = $functions.ToArray()
    return $result
}

function Get-SuiteReference {
    <#
    .SYNOPSIS
        Every ${...} reference in a value, with the pointer it was written at.
    #>
    [CmdletBinding()]
    param($Value, [string]$Pointer)

    # Depth first, in the order the keys and items are written. A string child
    # is read where it is found, and only a collection costs a call; a stack
    # of pending nodes paid two method calls for every node it held, and that
    # was most of the dataflow pass once the stage 10 and 12 suites were added
    # (the two-second budget of Y1). The depth is the model's, which
    # ConvertFrom-SuiteYamlNode already walked the same way.
    $references = [Collections.Generic.List[hashtable]]::new()
    Add-SuiteReference -Node $Value -At $Pointer -References $references
    return $references.ToArray()
}

function Add-SuiteReference {
    param($Node, [string]$At, $References)
    if ($Node -is [string]) {
        foreach ($match in [regex]::Matches($Node, '\$\{([^}]*)\}')) { $References.Add(@{ pointer = $At; expression = $match.Groups[1].Value }) }
        return
    }
    # Only a string holding "${" or a collection is visited: a scalar or a
    # plain string holds no reference, and its pointer is never built. The
    # operator rather than String.IndexOf is the same literal test, at a
    # fraction of the cost of a method call per value.
    if ($Node -is [System.Collections.IDictionary]) {
        foreach ($key in $Node.Keys) {
            if ($null -eq $key) { continue }
            $child = $Node[$key]
            if ($child -is [string]) {
                if ($child -cmatch '\$\{') {
                    $childAt = "$At/$key"
                    foreach ($match in [regex]::Matches($child, '\$\{([^}]*)\}')) { $References.Add(@{ pointer = $childAt; expression = $match.Groups[1].Value }) }
                }
            } elseif ($child -is [System.Collections.IEnumerable]) {
                Add-SuiteReference -Node $child -At "$At/$key" -References $References
            }
        }
    } elseif ($Node -is [System.Collections.IEnumerable]) {
        $index = 0
        foreach ($item in $Node) {
            if ($item -is [string]) {
                if ($item -cmatch '\$\{') {
                    $childAt = "$At/$index"
                    foreach ($match in [regex]::Matches($item, '\$\{([^}]*)\}')) { $References.Add(@{ pointer = $childAt; expression = $match.Groups[1].Value }) }
                }
            } elseif ($item -is [System.Collections.IEnumerable]) {
                Add-SuiteReference -Node $item -At "$At/$index" -References $References
            }
            $index++
        }
    }
}

function Test-CapturePath {
    <#
    .SYNOPSIS
        E302: a dotted path has to exist in the shape its action declares.
    .DESCRIPTION
        Walking stops as soon as the shape is open or untyped, which is the
        honest answer for an API response: the path may well be there, and this
        file is not the place that knows.
    #>
    [CmdletBinding()]
    param([hashtable]$Shape, [string[]]$Segments)

    $current = $Shape
    $walked = @()
    foreach ($segment in $Segments) {
        if ($null -eq $current) { return @{ ok = $true } }
        $type = [string]$current.type
        if ($type -eq 'any' -or -not $type) { return @{ ok = $true } }
        if ($type -eq 'array') {
            if ($segment -notmatch '^\d+$' -and $segment -ne '<index>') {
                return @{ ok = $false; path = ($walked -join '.'); expected = 'an index into an array'; candidates = @() }
            }
            $current = $current.items
            $walked += $segment
            continue
        }
        if ($type -ne 'object') {
            return @{ ok = $false; path = ($walked -join '.'); expected = "a $type, which has no $segment inside it"; candidates = @() }
        }
        if ($current.additionalProperties) { return @{ ok = $true } }
        if (-not $current.properties -or -not $current.properties.Contains($segment)) {
            $candidates = if ($current.properties) { @($current.properties.Keys) } else { @() }
            return @{ ok = $false; path = ($walked -join '.'); expected = 'not declared'; candidates = $candidates }
        }
        $current = $current.properties[$segment]
        $walked += $segment
    }
    return @{ ok = $true }
}

function Test-SuiteDataflow {
    <#
    .SYNOPSIS
        E301 to E304, E308 and the warnings: every reference resolves, every
        capture path is declared, and nothing is captured for nobody.
    #>
    [CmdletBinding()]
    param($Model, [hashtable]$Positions, [string]$File, [hashtable]$Schema, [hashtable]$Library, [string[]]$ContextKeys = @())

    $found = [Collections.Generic.List[hashtable]]::new()
    # The core's context keys and every extension's.
    $contextKeys = @($script:CoreContextKeys) + @($ContextKeys | Where-Object { $_ })
    $declaredParams = @{}
    foreach ($name in (Get-KeyList $Library.params)) { $declaredParams[$name] = $true }
    foreach ($param in @($Model.params)) { if ($null -ne $param) { $declaredParams[[string]$param.name] = $true } }
    $suiteVars = @{}
    foreach ($name in (Get-KeyList $Library.vars)) { $suiteVars[$name] = $true }
    foreach ($name in (Get-KeyList $Model.vars)) { $suiteVars[$name] = $true }
    $readParams = @{}

    # Every capture name the file produces anywhere. A bare name that is one of
    # these is the mistake D2 found in drain.yml, and the message can say both
    # halves of it: the spelling is ${capture.<name>}, and a capture only
    # reaches the case that produced it.
    $fileCaptures = @{}
    foreach ($entry in Get-SuiteAllStepEntry -Model $Model) {
        if ($entry.step.captureAs) { $fileCaptures[[string]$entry.step.captureAs] = $true }
    }

    # Built once for the file and read by every case: the hook entries each
    # case plan starts and ends with, and the ${...} references under each
    # pointer. A pointer names one value of this model, and a suite hook's
    # steps are walked for every case otherwise.
    $hookEntries = @{}
    $referenceCache = [Collections.Generic.Dictionary[string, object[]]]::new([StringComparer]::Ordinal)
    $cleanSubjects = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)

    $caseIndex = 0
    foreach ($case in @($Model.tests)) {
        if ($null -eq $case) { $caseIndex++; continue }
        $plan = Get-SuiteCasePlan -Model $Model -Case $case -CaseIndex $caseIndex -HookEntries $hookEntries
        $caseVars = @{} + $suiteVars
        foreach ($name in (Get-KeyList $case.vars)) { $caseVars[$name] = $true }
        foreach ($param in @($case.params)) { if ($null -ne $param) { $declaredParams[[string]$param.name] = $true } }

        # Where every capture in this case comes from, and when.
        $produced = @{}
        foreach ($entry in $plan) {
            $name = [string]$entry.step.captureAs
            if (-not $name) { continue }
            if (-not $produced.ContainsKey($name) -or $entry.order -lt $produced[$name].order) {
                # A step that carries a table runs once per row and publishes a
                # list, so a path into that capture starts with an index
                # (DEC-Y23). Recording it here is what keeps E302 honest.
                $produced[$name] = @{
                    order   = $entry.order
                    action  = [string]$entry.step.action
                    pointer = $entry.pointer
                    list    = ($null -ne $entry.step.table)
                }
            }
        }
        foreach ($entry in $plan) {
            $used = [string]$entry.step.meta
            if (-not $used) { continue }
            $definition = $null
            foreach ($meta in @($Model.metaSteps)) { if ($null -ne $meta -and $meta.name -eq $used) { $definition = $meta } }
            if (-not $definition -and $Library.metaSteps.ContainsKey($used)) { $definition = $Library.metaSteps[$used] }
            foreach ($export in @($definition.exports)) {
                if ($export) { $produced[[string]$export] = @{ order = $entry.order; action = ''; pointer = $entry.pointer } }
            }
        }

        # The columns ${row.<column>} may name. An outline binds them for the
        # whole case; a step table binds its own for that step only.
        $caseColumns = @(Get-TableColumn -Table $case.examples)

        $read = @{}
        $checks = [Collections.Generic.List[hashtable]]::new()
        foreach ($entry in $plan) {
            # A step without a table adds no columns of its own.
            $stepColumns = if ($null -eq $entry.step.table) { @($caseColumns) } else { @($caseColumns) + @(Get-TableColumn -Table $entry.step.table) }
            $checks.Add(@{ value = $entry.step; pointer = $entry.pointer; order = $entry.order
                    inMeta = ($entry.phase -like 'meta *'); columns = $stepColumns
                })
            if ($entry.step.ifCapture) {
                # A guard is allowed to name a capture that is not there yet:
                # that is the whole point of it, and a cleanup after a failed
                # case is the main use. So this is an existence check and never
                # an ordering one. A name no step in the case declares at all is
                # a typo, and a typo here silently disables a cleanup step.
                $name = [string]$entry.step.ifCapture
                if (-not $produced.ContainsKey($name)) { $name = $name.Split('.')[0] }
                $read[$name] = $true
                if (-not $produced.ContainsKey($name)) {
                    $found.Add((New-SuiteDiagnostic -Code 'E301' -File $File -Position $Positions["$($entry.pointer)/ifCapture"] -At 'value' `
                                -Message "ifCapture names $name, which no step in case $($case.name) captures." `
                                -Suggestion (Get-NearestSpelling -Word $name -Candidates @($produced.Keys))))
                }
            }
        }
        # The case-level assertions read anything the case produced; a step's own
        # assertions read anything up to and including that step.
        foreach ($diagnostic in Add-AssertionCheck -Assertions $case.asserts -Pointer "/tests/$caseIndex/asserts" -Order 99999 `
                -Columns $caseColumns -Checks $checks -Read $read -Produced $produced -CaseName ([string]$case.name) `
                -Schema $Schema -Positions $Positions -File $File) {
            $found.Add($diagnostic)
        }
        foreach ($entry in $plan) {
            if (-not $entry.step.asserts) { continue }
            # Inside a table step's own assertions the capture is that row's
            # result, not the list the step publishes afterwards, so the subject
            # is checked against the action's shape rather than a list of it.
            $stepProduced = $produced
            if ($null -ne $entry.step.table -and $entry.step.captureAs) {
                $stepProduced = @{}
                foreach ($name in @($produced.Keys)) { $stepProduced[$name] = $produced[$name] }
                $own = @{} + $produced[[string]$entry.step.captureAs]
                $own.list = $false
                $stepProduced[[string]$entry.step.captureAs] = $own
            }
            foreach ($diagnostic in Add-AssertionCheck -Assertions $entry.step.asserts -Pointer "$($entry.pointer)/asserts" -Order ($entry.order + 1) `
                    -Columns (@($caseColumns) + @(Get-TableColumn -Table $entry.step.table)) -Checks $checks -Read $read -Produced $stepProduced `
                    -CaseName ([string]$case.name) -Schema $Schema -Positions $Positions -File $File) {
                $found.Add($diagnostic)
            }
        }

        foreach ($check in $checks) {
            # The indexer answers $null for a pointer not walked yet, at a
            # fraction of the cost of TryGetValue through a [ref].
            $references = $referenceCache[[string]$check.pointer]
            if ($null -eq $references) {
                # What Get-SuiteReference answers, without its call per check.
                $collected = [Collections.Generic.List[hashtable]]::new()
                Add-SuiteReference -Node $check.value -At ([string]$check.pointer) -References $collected
                $references = $collected.ToArray()
                $referenceCache[[string]$check.pointer] = $references
            }
            foreach ($reference in $references) {
                $position = $Positions[$reference.pointer]
                # Read-ExpressionReference's own session cache, read in place
                # when it already holds the answer.
                $parsed = $script:ExpressionReferenceCache["False|$($reference.expression)"]
                if ($null -eq $parsed) { $parsed = Read-ExpressionReference -Text $reference.expression }
                if ($parsed.error) {
                    # Every message New-ExpressionError builds starts with its
                    # own code, which is the contract that makes this a split
                    # rather than a guess.
                    $code = ($parsed.error -split ':', 2)[0]
                    $found.Add((New-SuiteDiagnostic -Code $code -File $File -Position $position -At 'value' `
                                -Message ("`${$($reference.expression)} does not parse: " + ($parsed.error -replace '^E\d+: ', '') + '.') `
                                -Suggestion $(if ($code -eq 'E306' -and $parsed.error -match 'Did you mean (\w+)') { "Did you mean $($Matches[1])" })))
                    continue
                }
                # An unknown function has already come back from the parse above,
                # with the evaluator's own suggestion; the names collected here
                # are what tells a call from a path, and nothing else needs them.
                foreach ($segments in $parsed.paths) {
                $expression = @($segments) -join '.'
                $root = $segments[0]
                switch ($root) {
                    'capture' {
                        if ($segments.Count -lt 2) {
                            $found.Add((New-SuiteDiagnostic -Code 'E301' -File $File -Position $position -At 'value' `
                                        -Message 'A capture reference needs a name: ${capture.<name>}.'))
                            break
                        }
                        $name = $segments[1]
                        $read[$name] = $true
                        if (-not $produced.ContainsKey($name)) {
                            $found.Add((New-SuiteDiagnostic -Code 'E301' -File $File -Position $position -At 'value' `
                                        -Message "No step in case $($case.name) captures $name." `
                                        -Suggestion (Get-NearestSpelling -Word $name -Candidates @($produced.Keys))))
                            break
                        }
                        if ($produced[$name].order -ge $check.order) {
                            $found.Add((New-SuiteDiagnostic -Code 'E303' -File $File -Position $position -At 'value' `
                                        -Message "Capture $name is read before the step that produces it."))
                            break
                        }
                        $subject = @($segments[1..($segments.Count - 1)]) -join '.'
                        # Whether a path is in a capture's shape depends only on
                        # the action and list flag of the step producing it and
                        # on the path itself; a path already found clean in
                        # this file is not walked again. $name is the subject's
                        # first segment unless it holds a dot of its own.
                        $verdict = $null
                        if ($name -cnotmatch '\.') {
                            $verdict = "$($produced[$name].action)|$([bool]$produced[$name].list)|$subject"
                            if ($cleanSubjects.Contains($verdict)) { break }
                        }
                        $subjectFound = @(Test-SuiteSubject -Subject $subject -Pointer $reference.pointer `
                                -Positions $Positions -File $File -Schema $Schema -Produced $produced -CaseName ([string]$case.name) -Read $read -At 'value')
                        foreach ($diagnostic in $subjectFound) { $found.Add($diagnostic) }
                        if ($null -ne $verdict -and -not $subjectFound.Count) { $null = $cleanSubjects.Add($verdict) }
                    }
                    'param' {
                        if ($segments.Count -lt 2) { break }
                        $readParams[$segments[1]] = $true
                        if ($check.inMeta) { break }   # a meta step parameter is resolved at its use site
                        if (-not $declaredParams.ContainsKey($segments[1])) {
                            $found.Add((New-SuiteDiagnostic -Code 'E301' -File $File -Position $position -At 'value' `
                                        -Message "No parameter named $($segments[1]) is declared or imported." `
                                        -Suggestion (Get-NearestSpelling -Word $segments[1] -Candidates @($declaredParams.Keys))))
                        }
                    }
                    'var' {
                        if ($segments.Count -lt 2) { break }
                        if (-not $caseVars.ContainsKey($segments[1])) {
                            $found.Add((New-SuiteDiagnostic -Code 'E301' -File $File -Position $position -At 'value' `
                                        -Message "No variable named $($segments[1]) is declared." `
                                        -Suggestion (Get-NearestSpelling -Word $segments[1] -Candidates @($caseVars.Keys))))
                        }
                    }
                    'defaults' {
                        if ($segments.Count -lt 2) { break }
                        if (-not $Model.defaults -or -not $Model.defaults.Contains($segments[1])) {
                            $found.Add((New-SuiteDiagnostic -Code 'E301' -File $File -Position $position -At 'value' `
                                        -Message "The defaults block declares no $($segments[1])."))
                        }
                    }
                    'row' {
                        # A row exists only inside a step that carries a table
                        # or a case that carries examples, and only for the
                        # columns that table declares.
                        if (-not @($check.columns).Count) {
                            $found.Add((New-SuiteDiagnostic -Code 'E301' -File $File -Position $position -At 'value' `
                                        -Message '${row} has no table in scope. A row exists inside a step that carries a table, or a case that carries examples.'))
                            break
                        }
                        if ($segments.Count -lt 2) {
                            $found.Add((New-SuiteDiagnostic -Code 'E301' -File $File -Position $position -At 'value' `
                                        -Message 'A row reference needs a column: ${row.<column>}.' `
                                        -Suggestion ('Declared: ' + (@($check.columns) -join ', '))))
                            break
                        }
                        if (@($check.columns) -cnotcontains $segments[1]) {
                            $found.Add((New-SuiteDiagnostic -Code 'E301' -File $File -Position $position -At 'value' `
                                        -Message "The table in scope declares no column $($segments[1])." `
                                        -Suggestion (Get-NearestSpelling -Word $segments[1] -Candidates @($check.columns))))
                        }
                    }
                    default {
                        if ($contextKeys -ccontains $root -and $segments.Count -eq 1) { break }
                        $suggestion = if ($produced.ContainsKey($root)) {
                            "Captures are read as `${capture.$expression}."
                        } elseif ($fileCaptures.ContainsKey($root)) {
                            "Captures are read as `${capture.$expression}, and only in the case that captured $root. Capture it in case $($case.name) too."
                        } else {
                            $nearest = Get-NearestSpelling -Word $root -Candidates (@($contextKeys) + @('capture', 'param', 'var'))
                            if ($nearest) { "Did you mean $nearest" } else { $null }
                        }
                        $found.Add((New-SuiteDiagnostic -Code 'E301' -File $File -Position $position -At 'value' `
                                    -Message "`${$expression} resolves to nothing. A path starts at capture, param, var or a context key." `
                                    -Suggestion $suggestion))
                    }
                }
                }
            }
        }

        # W301: a capture nothing reads is a step whose result nobody checked.
        # The candidates are found first and only they are sorted, in the same
        # order, so a case whose captures are all read starts no pipeline.
        $unread = @(foreach ($name in $produced.Keys) {
                if (-not $read.ContainsKey($name) -and $produced[$name].pointer -like "/tests/$caseIndex/*") { $name }
            })
        if ($unread.Count) { $unread = @($unread | Sort-Object) }
        foreach ($name in $unread) {
            $found.Add((New-SuiteDiagnostic -Code 'W301' -Severity 'warning' -File $File `
                        -Position $Positions["$($produced[$name].pointer)/captureAs"] -At 'value' `
                        -Message "Capture $name in case $($case.name) is never read by a later step, an assertion or a cleanup."))
        }
        $caseIndex++
    }

    # E304: a meta step promising an export no step of it captures.
    $metaIndex = 0
    foreach ($meta in @($Model.metaSteps)) {
        if ($null -ne $meta) {
            $captured = @()
            foreach ($step in @($meta.steps)) { if ($null -ne $step -and $step.captureAs) { $captured += [string]$step.captureAs } }
            $exportIndex = 0
            foreach ($export in @($meta.exports)) {
                if ($export -and $captured -cnotcontains [string]$export) {
                    $found.Add((New-SuiteDiagnostic -Code 'E304' -File $File -Position $Positions["/metaSteps/$metaIndex/exports/$exportIndex"] -At 'value' `
                                -Message "Meta step $($meta.name) exports $export, which none of its steps captures." `
                                -Suggestion (Get-NearestSpelling -Word ([string]$export) -Candidates $captured)))
                }
                $exportIndex++
            }
        }
        $metaIndex++
    }

    # E309: a `vars:` value has to be the same on every run, because a
    # conformance run compares it across four bindings and a report that differs
    # by a fresh uuid tells nobody anything. `env`, `uuid` and `nowIso` are the
    # three functions that are not stable.
    #
    # Only the determinism rule is checked on a var. A var's paths resolve
    # against parameters and other vars rather than against a case's captures,
    # so the ordering and shape rules the rest of this pass applies do not hold
    # for them, and applying them here would report a var that is perfectly
    # legal.
    $varBlocks = [Collections.Generic.List[hashtable]]::new()
    $varBlocks.Add(@{ pointer = '/vars'; block = $Model.vars })
    $varCaseIndex = 0
    foreach ($case in @($Model.tests)) {
        if ($null -ne $case -and $case.vars) { $varBlocks.Add(@{ pointer = "/tests/$varCaseIndex/vars"; block = $case.vars }) }
        $varCaseIndex++
    }
    foreach ($source in $varBlocks) {
        foreach ($name in (Get-KeyList $source.block)) {
            foreach ($reference in Get-SuiteReference -Value $source.block[$name] -Pointer "$($source.pointer)/$name") {
                $parsed = Read-ExpressionReference -Text $reference.expression -Stable
                if ($parsed.error -and $parsed.error -match '^E309') {
                    $found.Add((New-SuiteDiagnostic -Code 'E309' -File $File -Position $Positions[$reference.pointer] -At 'value' `
                                -Message ("`${$($reference.expression)} cannot be used in vars: " + ($parsed.error -replace '^E\d+: ', '') + '.') `
                                -Suggestion 'Pass the value in with --param, or capture it in a step where a changing value is fine.'))
                }
            }
        }
    }

    # W303: a declared parameter nothing reads.
    $paramIndex = 0
    foreach ($param in @($Model.params)) {
        if ($null -ne $param -and -not $readParams.ContainsKey([string]$param.name)) {
            $found.Add((New-SuiteDiagnostic -Code 'W303' -Severity 'warning' -File $File -Position $Positions["/params/$paramIndex/name"] -At 'value' `
                        -Message "Parameter $($param.name) is declared and never read."))
        }
        $paramIndex++
    }
    return $found.ToArray()
}

function Add-AssertionCheck {
    <#
    .SYNOPSIS
        Queue one assertion list for the reference walk, and check its subject,
        its pattern and what its script reads.
    .DESCRIPTION
        Case-level and step-level assertions get identical treatment, which is
        the point of having one function: a subject that is not in the capture's
        declared shape is E302 wherever the assertion is written.
    #>
    [CmdletBinding()]
    param(
        $Assertions, [string]$Pointer, [int]$Order, [string[]]$Columns,
        [Collections.Generic.List[hashtable]]$Checks, [hashtable]$Read, [hashtable]$Produced,
        [string]$CaseName, [hashtable]$Schema, [hashtable]$Positions, [string]$File
    )

    $found = [Collections.Generic.List[hashtable]]::new()
    $index = 0
    foreach ($assertion in @($Assertions)) {
        if ($null -ne $assertion -and $assertion -is [System.Collections.IDictionary]) {
            $Checks.Add(@{ value = $assertion; pointer = "$Pointer/$index"; order = $Order; inMeta = $false; columns = $Columns })
            if ($assertion.var) {
                foreach ($diagnostic in Test-SuiteSubject -Subject ([string]$assertion.var) -Pointer "$Pointer/$index/var" `
                        -Positions $Positions -File $File -Schema $Schema -Produced $Produced -CaseName $CaseName -Read $Read) {
                    $found.Add($diagnostic)
                }
            }
            if ($assertion.matches) {
                foreach ($diagnostic in Test-PortablePattern -Pattern ([string]$assertion.matches) -Pointer "$Pointer/$index/matches" -Positions $Positions -File $File) {
                    $found.Add($diagnostic)
                }
            }
            if ($assertion.script) {
                # A script assertion reads the capture bag directly, so what it
                # names is read even though it is not a ${...} reference.
                foreach ($match in [regex]::Matches([string]$assertion.script, 'capture\.([A-Za-z_][A-Za-z0-9_]*)')) {
                    $Read[$match.Groups[1].Value] = $true
                }
            }
        }
        $index++
    }
    return $found.ToArray()
}

function Test-SuiteSubject {
    <#
    .SYNOPSIS
        E301, E302, E303 for a dotted path into the capture bag.
    #>
    [CmdletBinding()]
    param([string]$Subject, [string]$Pointer, [hashtable]$Positions, [string]$File, [hashtable]$Schema,
        [hashtable]$Produced, [string]$CaseName, [hashtable]$Read, [ValidateSet('key', 'value')][string]$At = 'value')

    $found = [Collections.Generic.List[hashtable]]::new()
    $segments = @($Subject -split '\.')
    $name = $segments[0]
    $Read[$name] = $true
    $position = $Positions[$Pointer]
    if (-not $Produced.ContainsKey($name)) {
        $found.Add((New-SuiteDiagnostic -Code 'E301' -File $File -Position $position -At $At `
                    -Message "No step in case $CaseName captures $name." `
                    -Suggestion (Get-NearestSpelling -Word $name -Candidates @($Produced.Keys))))
        return $found.ToArray()
    }
    $action = $Produced[$name].action
    if (-not $action -or -not $Schema.actions.ContainsKey($action)) { return $found.ToArray() }
    $shape = $Schema.actions[$action].captures
    if ($Produced[$name].list) { $shape = @{ type = 'array'; items = $shape } }
    if ($segments.Count -le 1) { return $found.ToArray() }
    $result = Test-CapturePath -Shape $shape -Segments @($segments[1..($segments.Count - 1)])
    if (-not $result.ok) {
        $suggestion = if ($result.candidates.Count) {
            $nearest = Get-NearestSpelling -Word $segments[-1] -Candidates $result.candidates
            if ($nearest) { "Did you mean $nearest" } else { 'Declared: ' + (@($result.candidates) -join ', ') }
        } else { $null }
        $found.Add((New-SuiteDiagnostic -Code 'E302' -File $File -Position $position -At $At `
                    -Message "Action $action does not declare $Subject in what it captures." `
                    -Suggestion $suggestion))
    }
    return $found.ToArray()
}

function Test-PortablePattern {
    <#
    .SYNOPSIS
        E308: a regular expression only some of the bindings can run.
    #>
    [CmdletBinding()]
    param([string]$Pattern, [string]$Pointer, [hashtable]$Positions, [string]$File)

    $found = [Collections.Generic.List[hashtable]]::new()
    foreach ($construct in $script:UnportablePatterns.Keys) {
        if ($Pattern -match $construct) {
            $found.Add((New-SuiteDiagnostic -Code 'E308' -File $File -Position $Positions[$Pointer] -At 'value' `
                        -Message "The pattern uses $($script:UnportablePatterns[$construct]), which the Go binding's RE2 engine cannot run." `
                        -Suggestion 'Restrict the pattern to the subset RE2 and .NET agree on.'))
        }
    }
    return $found.ToArray()
}

function Invoke-SuiteLintFile {
    <#
    .SYNOPSIS
        Every diagnostic for one suite file.
    .PARAMETER Composite
        The run's extensions, composed (New-SuiteComposite in BddSuite.psm1):
        ContextKeys the dataflow pass accepts, the EnvPrefix of parameter
        variables, and LintRules run after the core's passes. The core alone
        when absent.
    .PARAMETER RepositoryRoot
        What each diagnostic's file path is relative to: the workspace root.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string]$Binding = 'powershell',
        [switch]$BindingCheck,
        [hashtable]$Param = @{},
        [Parameter(Mandatory)][string]$SchemaRoot,
        [string]$RepositoryRoot,
        [hashtable]$Composite
    )

    if (-not $RepositoryRoot) { $RepositoryRoot = (Get-Location).Path }
    $RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
    $contextKeys = if ($Composite) { @($Composite.ContextKeys) } else { @() }
    $envPrefix = if ($Composite -and $Composite.EnvPrefix) { [string]$Composite.EnvPrefix } else { $script:DefaultEnvPrefix }
    $schema = Import-SuiteSchema -SchemaRoot $SchemaRoot
    $full = [IO.Path]::GetFullPath($FilePath)
    $relative = $full
    if ($full.StartsWith($RepositoryRoot, [StringComparison]::OrdinalIgnoreCase)) {
        $relative = $full.Substring($RepositoryRoot.Length).TrimStart('\', '/')
    }
    $relative = $relative -replace '\\', '/'

    $text = Get-Content -LiteralPath $full -Raw
    $model = $null
    $rootNode = $null
    try { $model = ConvertFrom-SuiteYaml $text -RootNode ([ref]$rootNode) } catch {
        return @(New-SuiteDiagnostic -Code 'E100' -File $relative -Message "The file is not valid YAML: $($_.Exception.Message)")
    }
    if ($null -eq $model -or $model -isnot [System.Collections.IDictionary]) {
        return @(New-SuiteDiagnostic -Code 'E100' -File $relative -Message 'The file does not hold a YAML mapping, so it cannot be a suite.')
    }

    # Both the model and diagnostic positions come from this same parse.
    $positions = Get-SuiteNodePosition -Text $text -RootNode $rootNode
    $library = Resolve-SuiteImport -Model $model -Positions $positions -File $relative -FilePath $full -RepositoryRoot $RepositoryRoot

    $found = [Collections.Generic.List[hashtable]]::new()
    $script:StepEntryScope = @{ model = $model; entries = $null }
    try {
        foreach ($diagnostic in Test-SuiteStructure -Model $model -Positions $positions -File $relative -Schema $schema) { $found.Add($diagnostic) }
        foreach ($diagnostic in Test-SuiteSemantics -Model $model -Positions $positions -File $relative -FilePath $full -Schema $schema `
                -Binding $Binding -BindingCheck ([bool]$BindingCheck) -Library $library -CommandLineParam $Param -EnvPrefix $envPrefix) {
            $found.Add($diagnostic)
        }
        foreach ($diagnostic in Test-SuiteDataflow -Model $model -Positions $positions -File $relative -Schema $schema -Library $library -ContextKeys $contextKeys) { $found.Add($diagnostic) }
        # The extensions' rules, after the core's passes (DEC-S03). A rule sees
        # the parsed file, where each pointer is, what the imports declare and
        # the import list, and answers diagnostics made with New-SuiteDiagnostic.
        if ($Composite) {
            $ruleInput = @{
                Model     = $model
                Positions = $positions
                File      = $relative
                FilePath  = $full
                Library   = $library
                Imports   = @($library.imports)
                Schema    = $schema
            }
            foreach ($rule in @($Composite.LintRules)) {
                if ($null -eq $rule) { continue }
                $answered = $null
                try { $answered = & $rule.Rule $ruleInput }
                catch { throw "The lint rule of $($rule.Owner) failed on ${relative}: $($_.Exception.Message)" }
                foreach ($diagnostic in @($answered)) {
                    if ($diagnostic -is [System.Collections.IDictionary]) { $found.Add([hashtable]([ordered]@{} + $diagnostic)) }
                }
            }
        }
    } finally {
        $script:StepEntryScope = $null
    }
    # Sorted here as well as across files, so one file's findings come back in
    # the order the contract states whichever entry point asked for them.
    return Get-SortedSuiteDiagnostic -Diagnostic $found.ToArray()
}

function Get-SortedSuiteDiagnostic {
    <#
    .SYNOPSIS
        File, line, column, code, message: a total order, so two bindings that
        find the same problems write the same document.
    #>
    [CmdletBinding()]
    param([object[]]$Diagnostic)

    $unique = [ordered]@{}
    foreach ($item in @($Diagnostic)) {
        if ($null -eq $item) { continue }
        $key = '{0}|{1:0000000}|{2:0000000}|{3}|{4}' -f $item.file, $item.line, $item.column, $item.code, $item.message
        if (-not $unique.Contains($key)) { $unique[$key] = $item }
    }
    return @(@($unique.Keys | Sort-Object) | ForEach-Object { $unique[$_] })
}

function Invoke-SuiteLint {
    <#
    .SYNOPSIS
        Validate every suite a glob matches, with no lab and no network.
    .PARAMETER Path
        One or more paths or globs, relative to the current directory.
    .PARAMETER Binding
        The binding a -BindingCheck run holds the suites to: any binding name
        the catalog may list (^[a-z][a-z0-9]*$).
    .PARAMETER BindingCheck
        Report E201 for an action the selected binding does not implement.
    .PARAMETER Param
        Command-line parameter values, as a name to value map.
    .PARAMETER SchemaRoot
        Where suite.schema.json and actions.catalog.yaml are. Without it the
        workspace root is found by walking up to test/e2e/schema.
    .PARAMETER Composite
        The run's extensions, composed (New-SuiteComposite).
    .EXAMPLE
        Invoke-SuiteLint -Path suites/*.yml -SchemaRoot schema
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$Path,
        [ValidatePattern('^[a-z][a-z0-9]*$')][string]$Binding = 'powershell',
        [switch]$BindingCheck,
        [hashtable]$Param = @{},
        [string]$SchemaRoot,
        [string]$RepositoryRoot,
        [hashtable]$Composite
    )

    $roots = Resolve-SuiteRoot -SchemaRoot $SchemaRoot
    if (-not $RepositoryRoot) { $RepositoryRoot = $roots.root }
    $files = [Collections.Generic.List[string]]::new()
    foreach ($pattern in @($Path)) {
        $absolute = if ([IO.Path]::IsPathRooted($pattern)) { $pattern } else { Join-Path (Get-Location).Path $pattern }
        foreach ($item in @(Get-ChildItem -Path $absolute -File -ErrorAction SilentlyContinue | Sort-Object FullName)) {
            if (-not $files.Contains($item.FullName)) { $files.Add($item.FullName) }
        }
    }
    if (-not $files.Count) { throw "No suite files matched $($Path -join ', ')" }

    $found = [Collections.Generic.List[object]]::new()
    foreach ($file in $files) {
        foreach ($diagnostic in Invoke-SuiteLintFile -FilePath $file -Binding $Binding -BindingCheck:$BindingCheck -Param $Param `
                -SchemaRoot $roots.schemaRoot -RepositoryRoot $RepositoryRoot -Composite $Composite) {
            $found.Add($diagnostic)
        }
    }
    return Get-SortedSuiteDiagnostic -Diagnostic $found.ToArray()
}

function Format-SuiteDiagnostic {
    <#
    .SYNOPSIS
        One diagnostic as the line a person reads.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory, ValueFromPipeline)]$Diagnostic)

    process {
        $line = '{0}:{1}:{2}  {3}  {4}' -f $Diagnostic.file, $Diagnostic.line, $Diagnostic.column, $Diagnostic.code, $Diagnostic.message
        if ($Diagnostic.suggestion) { $line += ([Environment]::NewLine + '    ' + $Diagnostic.suggestion) }
        return $line
    }
}

function Test-SuiteDiagnosticFailure {
    <#
    .SYNOPSIS
        Whether a set of diagnostics fails the lint. Warnings only do under
        -Strict.
    #>
    [CmdletBinding()]
    param([object[]]$Diagnostic, [switch]$Strict)

    foreach ($item in @($Diagnostic)) {
        if ($null -eq $item) { continue }
        if ($item.severity -eq 'error') { return $true }
        if ($Strict) { return $true }
    }
    return $false
}

Export-ModuleMember -Function Invoke-SuiteLint, Invoke-SuiteLintFile, Format-SuiteDiagnostic,
Test-SuiteDiagnosticFailure, Get-SortedSuiteDiagnostic, Get-SuiteNodePosition, Get-SuiteWorkspaceRoot, Resolve-SuiteRoot,
Import-SuiteSchema, Read-SuiteCatalog, Get-NearestSpelling, Get-EditDistance, Test-CapturePath, New-SuiteDiagnostic,
Get-KeyList, Get-TableColumn, Test-SuiteTable, Get-SuiteStepList, Split-SchemaErrorPointer, Read-ExpressionReference,
Invoke-SchemaValidation, Test-SuiteJson, ConvertFrom-SuiteYaml, Get-SuiteAllStepEntry
