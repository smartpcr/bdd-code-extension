<# .SYNOPSIS The conformance corpus, run by the PowerShell runtime. #>
<#
.DESCRIPTION
    `conformance/` at the repository root is what "the same behaviour" means
    across the five runtimes: suites with the diagnostics they must produce,
    suites with the trace a run must emit, and tables for the expression
    language, the assertion operators and the report form. This file is the
    PowerShell runtime's side of that contract. Copied from the PowerShell
    binding's Conformance.Tests.ps1 at 7633e176 and pointed at the relocated
    corpus.

    Nothing here needs a lab. Every corpus suite that runs calls `core.*`
    actions only. The corpus is linted and run with its test extension
    (tests/CorpusExtension), which supplies the context keys the corpus reads;
    the core defines none.

    Set BDD_CONFORMANCE_DUMP to rewrite every expectation from what the current
    code produces instead of asserting against them. That is how an expectation
    is created and how one is updated after a deliberate change; it asserts
    nothing, and it says so, because a test that silently rewrites what it was
    about to check is not a test.
#>
[CmdletBinding()]param([switch]$RunHarness)
if (-not $RunHarness -and (Get-Command Describe -ListImported -ErrorAction SilentlyContinue)) {
    Describe 'E2: the conformance corpus, PowerShell' -ForEach @(@{ HarnessPath = $PSCommandPath }) {
        It 'produces the diagnostics, traces, values and reports the corpus expects' { & $HarnessPath -RunHarness }
    }
    return
}

$ErrorActionPreference = 'Stop'
$script:checks = 0
function Assert([bool]$Condition, [string]$Message) {
    $script:checks++
    if (-not $Condition) { throw "FAIL: $Message" }
}

$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $runtimeRoot '../..'))
$specRoot = Join-Path $repoRoot 'spec'
$corpusRoot = Join-Path $repoRoot 'conformance'
$corpusExtension = Join-Path $PSScriptRoot 'CorpusExtension/BddSuite.Corpus.psm1'
$dump = [bool]$env:BDD_CONFORMANCE_DUMP
# The stored canonical reports are written on the same switch.
$dumpReports = $dump
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('conformance-' + [guid]::NewGuid().ToString('N'))

Import-Module powershell-yaml -ErrorAction Stop
Import-Module (Join-Path $runtimeRoot 'BddSuite/BddSuite.psd1') -Force -DisableNameChecking

# The schema folder the manifest names, and the corpus's test extension,
# composed the way a run composes it.
$manifestPath = Join-Path $corpusRoot 'run-manifest.yaml'
$manifest = ConvertFrom-Yaml (Get-Content -LiteralPath $manifestPath -Raw) -Ordered
$schemaRoot = [IO.Path]::GetFullPath((Join-Path $corpusRoot ([string]$manifest.schemaRoot)))
$composite = New-SuiteComposite -Extension @(Import-SuiteExtension -Path $corpusExtension)

function Get-CorpusPath {
    <#
    .SYNOPSIS
        A corpus-relative path as a full path on this machine.
    #>
    param([string]$Relative)
    return [IO.Path]::GetFullPath((Join-Path $corpusRoot $Relative))
}

function ConvertTo-ComparableJson {
    <#
    .SYNOPSIS
        One object as the text a diff can be read from: sorted keys, two-space
        indent, forward slashes, and a trailing newline.
    #>
    param($Value)
    return ((ConvertTo-Json -InputObject $Value -Depth 20) -replace "`r`n", "`n")
}

function Get-DiagnosticList {
    <#
    .SYNOPSIS
        What a validate entry must produce: code, severity, line and column, in
        the validator's own sort order, and the file only when the finding is in
        a file other than the entry's own suite.
    .DESCRIPTION
        No message and no suggestion. Those are not part of the contract
        (diagnostics.md), so an expectation that held them would fail a binding
        for wording rather than for behaviour.
    #>
    param($Findings, [string]$SuiteRelative)
    $list = [Collections.Generic.List[object]]::new()
    foreach ($finding in @($Findings)) {
        if ($null -eq $finding) { continue }
        $entry = [ordered]@{
            code     = [string]$finding.code
            severity = [string]$finding.severity
            line     = [int]$finding.line
            column   = [int]$finding.column
        }
        $file = ([string]$finding.file) -replace '\\', '/'
        if ($file -and -not $file.EndsWith($SuiteRelative)) { $entry['file'] = $file }
        $list.Add($entry)
    }
    # Wrapped once. A one-entry list returned bare comes back as the entry
    # itself and an empty one as nothing, so an expectation would hold an object
    # or a null where an array belongs.
    return , $list.ToArray()
}

function New-OverlaySchemaRoot {
    <#
    .SYNOPSIS
        A schema root whose action catalog carries an overlay, generated the way
        the corpus's own is.
    .DESCRIPTION
        An overlay exists so a rule the catalog drives - a deprecated action, a
        parameter the corpus catalog does not declare - can be proved without
        changing the catalog every runtime ships. Merge by action name: each key
        given replaces the key in the catalog, and a params entry replaces the
        one with the same name or is appended when there is none.

        The merged catalog is written to a scratch folder with its imports and
        suite-schema extensions made absolute, so it still imports the core
        from where it is, and spec/Build-Schema.ps1 generates its schema there.
    #>
    param([string]$OverlayRelative)

    $target = Join-Path $scratch ('schema-' + [IO.Path]::GetFileNameWithoutExtension($OverlayRelative))
    if (Test-Path -LiteralPath $target) { return $target }
    $null = New-Item -ItemType Directory -Path $target -Force

    $sourceCatalog = Join-Path $schemaRoot 'actions.catalog.yaml'
    $catalog = ConvertFrom-Yaml (Get-Content -LiteralPath $sourceCatalog -Raw) -Ordered
    $catalog['imports'] = @(foreach ($import in @($catalog.imports)) { if ($import) { [IO.Path]::GetFullPath([IO.Path]::Combine($schemaRoot, [string]$import)) } })
    if ($catalog.Contains('suiteSchema')) {
        $catalog['suiteSchema'] = @(foreach ($extension in @($catalog.suiteSchema)) { if ($extension) { [IO.Path]::GetFullPath([IO.Path]::Combine($schemaRoot, [string]$extension)) } })
    }
    $overlay = ConvertFrom-Yaml (Get-Content -LiteralPath (Get-CorpusPath $OverlayRelative) -Raw) -Ordered
    foreach ($patch in @($overlay.actions)) {
        $action = @($catalog.actions | Where-Object { [string]$_.name -eq [string]$patch.name })[0]
        if (-not $action) { throw "The overlay patches $($patch.name), which the catalog does not declare." }
        foreach ($key in @($patch.Keys)) {
            if ($key -eq 'name') { continue }
            if ($key -ne 'params') { $action[$key] = $patch[$key]; continue }
            $params = [Collections.Generic.List[object]]::new()
            foreach ($existing in @($action.params)) { $params.Add($existing) }
            foreach ($added in @($patch.params)) {
                $at = -1
                for ($index = 0; $index -lt $params.Count; $index++) {
                    if ([string]$params[$index].name -eq [string]$added.name) { $at = $index }
                }
                if ($at -ge 0) { $params[$at] = $added } else { $params.Add($added) }
            }
            $action['params'] = $params.ToArray()
        }
    }
    $catalogPath = Join-Path $target 'actions.catalog.yaml'
    Set-Content -LiteralPath $catalogPath -Value (ConvertTo-Yaml $catalog)
    $output = & pwsh -NoProfile -File (Join-Path $specRoot 'Build-Schema.ps1') -Catalog $catalogPath 2>&1
    if ($LASTEXITCODE -ne 0) { throw "The overlay would not generate a schema: $output" }
    return $target
}

function Invoke-ValidateEntry {
    <#
    .SYNOPSIS
        One validate entry: the diagnostics it produces and the exit code it
        would leave.
    #>
    param([hashtable]$Entry)

    $options = @{}
    if ($Entry.binding) { $options['Binding'] = [string]$Entry.binding }
    if ($Entry.bindingCheck) { $options['BindingCheck'] = $true }
    if ($Entry.catalogOverlay) { $options['SchemaRoot'] = New-OverlaySchemaRoot -OverlayRelative ([string]$Entry.catalogOverlay) }
    if ($Entry.params) {
        $param = @{}
        foreach ($name in @($Entry.params.Keys)) { $param[$name] = [string]$Entry.params[$name] }
        $options['Param'] = $param
    }
    if (-not $options.ContainsKey('SchemaRoot')) { $options['SchemaRoot'] = $schemaRoot }
    $strict = [bool]$Entry.strict
    $found = @(Invoke-SuiteLintFile -FilePath (Get-CorpusPath ([string]$Entry.suite)) -RepositoryRoot $corpusRoot -Composite $composite @options |
        Where-Object { $null -ne $_ })
    $failed = Test-SuiteDiagnosticFailure -Diagnostic $found -Strict:$strict
    return @{
        diagnostics = Get-DiagnosticList -Findings $found -SuiteRelative ([string]$Entry.suite)
        exitCode    = $(if ($failed) { 2 } else { 0 })
    }
}

function Invoke-ExecuteEntry {
    <#
    .SYNOPSIS
        One execute entry: the trace the run emitted, the exit code it left and
        how long it took.
    .DESCRIPTION
        Run in this process through Invoke-BddSuite, which returns the exit
        code the command line would leave (Invoke-BddSuite.ps1 only passes it
        on), with the corpus's test extension, as a consumer's run would.
    #>
    param([hashtable]$Entry)

    $stem = [IO.Path]::GetFileNameWithoutExtension([string]$Entry.suite)
    $tracePath = Join-Path $scratch "$stem.trace.json"
    $reportPath = Join-Path $scratch ($stem + $(if ($Entry.format) { "-$($Entry.format)" } else { "" }) + ".results.xml")
    if (Test-Path -LiteralPath $tracePath) { Remove-Item -LiteralPath $tracePath -Force }
    $arguments = @{
        Path        = @(Get-CorpusPath ([string]$Entry.suite))
        SchemaRoot  = $schemaRoot
        Extension   = @($corpusExtension)
        ResultsFile = $reportPath
        TraceFile   = $tracePath
        Json        = $true
    }
    if ($Entry.format) { $arguments['ReportFormat'] = [string]$Entry.format }
    if ($Entry.tags) { $arguments['Tags'] = [string]$Entry.tags }
    $param = @(foreach ($name in @(if ($Entry.params) { $Entry.params.Keys } else { @() })) { "$name=$([string]$Entry.params[$name])" })
    if ($param.Count) { $arguments['Param'] = $param }

    $watch = [Diagnostics.Stopwatch]::StartNew()
    $outcome = Invoke-BddSuite @arguments
    $watch.Stop()
    $said = "error: $($outcome.Error); diagnostics: $(@($outcome.Diagnostics | ForEach-Object { "$($_.code)@$($_.line):$($_.column) $($_.message)" }) -join ' | ')"
    if (-not (Test-Path -LiteralPath $tracePath)) { throw "$($Entry.suite) wrote no trace. The run said: $said" }
    return @{
        trace    = @((Get-Content -LiteralPath $tracePath -Raw) | ConvertFrom-Json -AsHashtable)
        exitCode = $outcome.ExitCode
        seconds  = $watch.Elapsed.TotalSeconds
        output   = $said
        report   = $reportPath
    }
}

function Get-TraceList {
    <#
    .SYNOPSIS
        A trace as the ordered list an expectation holds: the six fields the
        contract names, and nothing that depends on the machine.
    #>
    param($Trace)
    $list = [Collections.Generic.List[object]]::new()
    foreach ($item in @($Trace)) {
        if ($null -eq $item) { continue }
        $entry = [ordered]@{ phase = [string]$item.phase }
        if ($item.case) { $entry['case'] = [string]$item.case }
        if ($item.step) { $entry['step'] = [string]$item.step }
        if ($item.action) { $entry['action'] = [string]$item.action }
        $entry['status'] = [string]$item.status
        if ($item.reason) { $entry['reason'] = [string]$item.reason }
        $list.Add($entry)
    }
    return , $list.ToArray()
}

function Get-ConformanceType {
    <#
    .SYNOPSIS
        A value's type named for what it is rather than for what this language
        calls it.
    .DESCRIPTION
        int, float, string, bool, null, list. A whole number is int whichever
        width it is stored in, because four bindings store it in four widths and
        none of that is behaviour anybody should be held to.
    #>
    param($Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { return 'bool' }
    if ($Value -is [string]) { return 'string' }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [int16] -or $Value -is [byte]) { return 'int' }
    if ($Value -is [double] -or $Value -is [single] -or $Value -is [decimal]) { return 'float' }
    if ($Value -is [System.Collections.IEnumerable]) { return 'list' }
    return $Value.GetType().Name
}

function Get-ExpressionOutcome {
    <#
    .SYNOPSIS
        One expression row evaluated: what it produced, or the code it was
        refused with.
    #>
    param([hashtable]$Case, [hashtable]$Scope)

    $stable = [bool]$Case.stable
    try {
        $value = if ($Case.ContainsKey('template')) {
            Expand-SuiteExpression -Value ([string]$Case.template) -Scope $Scope -AllowNonDeterministic (-not $stable)
        } else {
            Invoke-SuiteExpression -Text ([string]$Case.expr) -Scope $Scope -AllowNonDeterministic (-not $stable)
        }
        return @{ ok = $true; value = $value; type = (Get-ConformanceType -Value $value) }
    } catch {
        # Every message New-ExpressionError builds starts with its own code,
        # which is what makes reading it back a split rather than a guess.
        return @{ ok = $false; code = (($_.Exception.Message -split ':', 2)[0]); message = $_.Exception.Message }
    }
}

$null = New-Item -ItemType Directory -Path $scratch -Force
try {
    $entries = @($manifest.entries | Where-Object { $null -ne $_ })
    $counts = [ordered]@{ validate = 0; execute = 0; reports = 0; expressions = 0; asserts = 0 }
    Assert (Test-Path -LiteralPath (Join-Path $schemaRoot 'suite.schema.json')) "The manifest's schemaRoot ($($manifest.schemaRoot)) holds suite.schema.json."
    Assert (Test-Path -LiteralPath (Join-Path $schemaRoot 'actions.catalog.yaml')) "The manifest's schemaRoot ($($manifest.schemaRoot)) holds actions.catalog.yaml."
    Assert ($entries.Count -gt 0) 'The manifest lists entries.'

    # -------------------------------------------------------------------
    # The manifest and the directory agree. An entry the manifest does not
    # name is worse than a missing entry: it looks like coverage and no
    # binding runs it.
    # -------------------------------------------------------------------
    $named = @{}
    foreach ($entry in $entries) {
        $named[([string]$entry.suite)] = $true
        $named[([string]$entry.expectation)] = $true
        if ($entry.catalogOverlay) { $named[([string]$entry.catalogOverlay)] = $true }
    }
    foreach ($support in @($manifest.support)) { if ($support) { $named[[string]$support] = $true } }
    foreach ($family in @('validate', 'execute')) {
        $directory = Join-Path $corpusRoot $family
        if (-not (Test-Path -LiteralPath $directory)) { continue }
        foreach ($file in Get-ChildItem -LiteralPath $directory -Recurse -File) {
            $relative = ($file.FullName.Substring($corpusRoot.Length).TrimStart('\', '/')) -replace '\\', '/'
            if ($relative -like '*.expected.json' -and -not $dump) {
                Assert ($named.ContainsKey($relative)) "$relative is an expectation the manifest does not name."
                continue
            }
            if ($relative -like '*.expected.json') { continue }
            Assert ($named.ContainsKey($relative)) "$relative is in $family/ and the manifest names neither it nor its support."
        }
    }
    foreach ($entry in $entries) {
        Assert (Test-Path -LiteralPath (Get-CorpusPath ([string]$entry.suite))) "The manifest names $($entry.suite), which is not there."
        Assert ([bool][string]$entry.description) "$($entry.suite) is in the manifest with nothing saying what it is for."
    }

    # -------------------------------------------------------------------
    # Every expectation validates against expectation.schema.json, and every
    # validate entry produces exactly what its expectation holds.
    # -------------------------------------------------------------------
    $expectationSchema = Get-Content -LiteralPath (Join-Path $corpusRoot 'expectation.schema.json') -Raw
    $seenCodes = @{}
    foreach ($entry in $entries) {
        if ([string]$entry.kind -ne 'validate') { continue }
        $result = Invoke-ValidateEntry -Entry (@{} + $entry)
        $expectationPath = Get-CorpusPath ([string]$entry.expectation)
        if ($dump) {
            $document = [ordered]@{
                kind        = 'validate'
                suite       = [string]$entry.suite
                description = [string]$entry.description
                exitCode    = $result.exitCode
            }
            if ($entry.strict) { $document['strict'] = $true }
            if ($entry.bindingCheck) { $document['bindingCheck'] = $true }
            if ($entry.binding) { $document['binding'] = [string]$entry.binding }
            if ($entry.catalogOverlay) { $document['catalogOverlay'] = [string]$entry.catalogOverlay }
            if ($entry.params) { $document['params'] = $entry.params }
            $document['diagnostics'] = $result.diagnostics
            Set-Content -LiteralPath $expectationPath -Value (ConvertTo-ComparableJson -Value $document) -NoNewline
            Write-Host "  dumped $($entry.expectation)"
            continue
        }

        Assert (Test-Path -LiteralPath $expectationPath) "$($entry.expectation) is missing."
        $raw = Get-Content -LiteralPath $expectationPath -Raw
        $schemaFailures = $null
        Assert (Test-SuiteJson -Json $raw -Schema $expectationSchema -Failure ([ref]$schemaFailures)) `
            "$($entry.expectation) does not validate against expectation.schema.json: $(@($schemaFailures | ForEach-Object { "$($_.body) at '$($_.pointer)'" }) -join '; ')"
        $expected = $raw | ConvertFrom-Json -AsHashtable
        Assert ([string]$expected.kind -eq 'validate') "$($entry.expectation) is not a validate expectation."
        Assert ([string]$expected.suite -eq [string]$entry.suite) "$($entry.expectation) names a different suite than the manifest does."
        Assert ($result.exitCode -eq [int]$expected.exitCode) `
            "$($entry.suite) exits $($result.exitCode); the expectation says $($expected.exitCode)."
        $actualText = ConvertTo-ComparableJson -Value $result.diagnostics
        $expectedText = ConvertTo-ComparableJson -Value (Get-DiagnosticList -Findings @($expected.diagnostics) -SuiteRelative ([string]$entry.suite))
        Assert ($actualText -eq $expectedText) `
            "$($entry.suite) diagnostics differ.`nProduced:`n$actualText`nExpected:`n$expectedText"
        foreach ($diagnostic in @($expected.diagnostics)) { $seenCodes[[string]$diagnostic.code] = $true }
        $counts.validate++
    }

    # -------------------------------------------------------------------
    # Every execute entry emits exactly the trace its expectation holds, in
    # order, and leaves the exit code it says. A report names which cases
    # passed; only a trace says in which order the phases ran, which step a
    # guard skipped and which row of a table failed.
    # -------------------------------------------------------------------
    # pendingIn names the runtimes that do not meet an entry yet; this one
    # reports such an entry as pending, never as passed.
    $pending = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in $entries) {
        if ([string]$entry.kind -ne 'execute') { continue }
        if (@($entry.pendingIn) -contains 'powershell') { $pending.Add([string]$entry.suite); continue }
        $result = Invoke-ExecuteEntry -Entry (@{} + $entry)
        $expectationPath = Get-CorpusPath ([string]$entry.expectation)
        if ($dump) {
            $document = [ordered]@{
                kind        = 'execute'
                suite       = [string]$entry.suite
                description = [string]$entry.description
                exitCode    = $result.exitCode
            }
            if ($entry.tags) { $document['tags'] = [string]$entry.tags }
            if ($entry.params) { $document['params'] = $entry.params }
            if ($entry.maxSeconds) { $document['maxSeconds'] = [double]$entry.maxSeconds }
            $document['trace'] = Get-TraceList -Trace $result.trace
            Set-Content -LiteralPath $expectationPath -Value (ConvertTo-ComparableJson -Value $document) -NoNewline
            Write-Host "  dumped $($entry.expectation)"
            continue
        }

        Assert (Test-Path -LiteralPath $expectationPath) "$($entry.expectation) is missing."
        $raw = Get-Content -LiteralPath $expectationPath -Raw
        $schemaFailures = $null
        Assert (Test-SuiteJson -Json $raw -Schema $expectationSchema -Failure ([ref]$schemaFailures)) `
            "$($entry.expectation) does not validate against expectation.schema.json: $(@($schemaFailures | ForEach-Object { "$($_.body) at '$($_.pointer)'" }) -join '; ')"
        $expected = $raw | ConvertFrom-Json -AsHashtable
        Assert ([string]$expected.kind -eq 'execute') "$($entry.expectation) is not an execute expectation."
        Assert ($result.exitCode -eq [int]$expected.exitCode) `
            "$($entry.suite) exits $($result.exitCode); the expectation says $($expected.exitCode). The run said:`n$($result.output)"
        if ($expected.maxSeconds) {
            Assert ($result.seconds -lt [double]$expected.maxSeconds) `
                "$($entry.suite) took $([math]::Round($result.seconds, 1))s; it has to finish inside $($expected.maxSeconds)s or the limit was waited out rather than enforced."
        }
        $actualText = ConvertTo-ComparableJson -Value (Get-TraceList -Trace $result.trace)
        $expectedText = ConvertTo-ComparableJson -Value (Get-TraceList -Trace @($expected.trace))
        Assert ($actualText -eq $expectedText) "$($entry.suite) trace differs.`nProduced:`n$actualText`nExpected:`n$expectedText"
        $counts.execute++
    }
    Assert ($pending.Count -eq 0) "Pending for powershell: $($pending -join ', ')"

    # -------------------------------------------------------------------
    # E3 (docs/test-providers): every generate entry the manifest does not
    # mark pending for this runtime gives the plan it expects, compared as
    # data with its keys sorted, or the refusal's exit code and findings.
    # -------------------------------------------------------------------
    $sortKeys = {
        param($Value)
        if ($Value -is [System.Collections.IDictionary]) {
            $sorted = [ordered]@{}
            foreach ($key in @($Value.Keys | Sort-Object -CaseSensitive)) { $sorted[$key] = & $sortKeys $Value[$key] }
            return $sorted
        }
        if ($Value -is [System.Collections.IList]) { return , @(foreach ($item in $Value) { & $sortKeys $item }) }
        return $Value
    }
    $generateChecked = 0
    foreach ($entry in @($manifest.generate | Where-Object { $null -ne $_ })) {
        if (@($entry.pendingIn) -contains 'powershell') { continue }
        $generated = Invoke-BddSuiteGenerate -Config (Get-CorpusPath ([string]$entry.config)) -Plan
        Assert ($generated.Code -eq [int]$entry.exitCode) "$($entry.config) exits $($generated.Code), not $($entry.exitCode): $($generated.Errors)"
        if ($entry.expected) {
            $want = ConvertTo-Json -InputObject (& $sortKeys ((Get-Content -LiteralPath (Get-CorpusPath ([string]$entry.expected)) -Raw) | ConvertFrom-Json -AsHashtable)) -Depth 20 -Compress
            $got = ConvertTo-Json -InputObject (& $sortKeys ($generated.Out | ConvertFrom-Json -AsHashtable)) -Depth 20 -Compress
            Assert ($want -ceq $got) "$($entry.config): the plan differs:`n$($generated.Out)"
        } else {
            $found = @([regex]::Matches($generated.Errors, '(?m)^(\S+):(\d+):(\d+) +([EW]\d+)') | ForEach-Object { "$($_.Groups[1].Value):$($_.Groups[2].Value):$($_.Groups[3].Value) $($_.Groups[4].Value)" })
            $wanted = @($entry.diagnostics | ForEach-Object { "$($_.file):$($_.line):$($_.column) $($_.code)" })
            Assert (($found -join '|') -eq ($wanted -join '|')) "$($entry.config): findings $($found -join ', '), not $($wanted -join ', ')"
            Assert ($generated.Errors -match 'Nothing was generated') "$($entry.config) does not say nothing was generated."
        }
        $generateChecked++
    }
    Assert ($generateChecked -eq 2) "$generateChecked generate entries checked, not 2"


    # -------------------------------------------------------------------
    # The canonical report form. Three runs in both formats, reduced by the
    # rules in report/canonicalise.md and compared with what is stored.
    # -------------------------------------------------------------------
    Assert (Test-Path -LiteralPath (Get-CorpusPath ([string]$manifest.reports.definition))) 'The manifest names the page the canonical form is defined on.'
    foreach ($entry in @($manifest.reports.entries | Where-Object { $null -ne $_ })) {
        $row = @{} + $entry
        $result = Invoke-ExecuteEntry -Entry $row
        $canonical = ConvertTo-CanonicalReport -Report $result.report
        $expectedPath = Get-CorpusPath ([string]$row.expected)
        if ($dumpReports) {
            Set-Content -LiteralPath $expectedPath -Value $canonical -NoNewline
            Write-Host "  dumped $($row.expected)"
            continue
        }
        Assert (Test-Path -LiteralPath $expectedPath) "$($row.expected) is missing."
        $stored = (Get-Content -LiteralPath $expectedPath -Raw) -replace "`r`n", "`n"
        $comparison = Test-ReportsEqual -Left $canonical -Right $stored
        Assert ($comparison.equal) "$($row.suite) in $($row.format) differs from $($row.expected): $($comparison.difference)"
        $counts.reports++
    }
    if ($dump) {
        Write-Host 'Expectations dumped; nothing was asserted.'
        return
    }

    # -------------------------------------------------------------------
    # The expression table. Every row states a value and its type, or the
    # code it is refused with; the whole table is the specification, and the
    # grammar in the design describes it.
    # -------------------------------------------------------------------
    $tables = @($manifest.tables | Where-Object { $null -ne $_ })
    $expressionTable = @($tables | Where-Object { [string]$_.kind -eq 'expressions' })[0]
    Assert ($null -ne $expressionTable) 'The manifest names the expression table.'
    $scope = ConvertFrom-Yaml (Get-Content -LiteralPath (Get-CorpusPath ([string]$expressionTable.context)) -Raw)
    # The roots a path may start at: the core's and the corpus extension's keys,
    # as a run gives every step.
    $scope['__roots'] = @($composite.Roots)
    $expressionCases = @((ConvertFrom-Yaml (Get-Content -LiteralPath (Get-CorpusPath ([string]$expressionTable.cases)) -Raw)).cases | Where-Object { $null -ne $_ })
    Assert ($expressionCases.Count -gt 100) "The expression table holds $($expressionCases.Count) rows, which is fewer than the language has corners."
    $usedFunctions = @{}
    foreach ($case in $expressionCases) {
        $row = @{} + $case
        $text = if ($row.ContainsKey('template')) { [string]$row.template } else { [string]$row.expr }
        $label = if ($row.ContainsKey('template')) { "template [$text]" } else { "expression [$text]" }
        foreach ($match in [regex]::Matches($text, '([A-Za-z_][A-Za-z0-9_]*)\s*\(')) { $usedFunctions[$match.Groups[1].Value] = $true }
        $outcome = Get-ExpressionOutcome -Case $row -Scope $scope
        if ($row.ContainsKey('code')) {
            Assert (-not $outcome.ok) "$label produced $($outcome.value) and the table says it is refused with $($row.code)."
            Assert ($outcome.code -eq [string]$row.code) "$label is refused with $($outcome.code); the table says $($row.code). It said: $($outcome.message)"
            continue
        }
        Assert ($outcome.ok) "$label is refused with $($outcome.code); the table says it produces a value. It said: $($outcome.message)"
        Assert ($outcome.type -eq [string]$row.type) "$label has type $($outcome.type); the table says $($row.type)."
        if ($row.ContainsKey('value')) {
            $same = if ($null -eq $row.value) { $null -eq $outcome.value } else { $outcome.value -eq $row.value }
            Assert ([bool]$same) "$label is [$($outcome.value)]; the table says [$($row.value)]."
        }
        if ($row.ContainsKey('count')) { Assert (@($outcome.value).Count -eq [int]$row.count) "$label holds $(@($outcome.value).Count) entries; the table says $($row.count)." }
        if ($row.ContainsKey('length')) { Assert (([string]$outcome.value).Length -eq [int]$row.length) "$label is $(([string]$outcome.value).Length) characters; the table says $($row.length)." }
        $counts.expressions++
    }

    # Every function the language has appears in the table. A function nothing
    # calls here is one three other bindings may implement differently and
    # nobody would find out.
    $missingFunctions = @(Get-ExpressionFunctionName | Where-Object { -not $usedFunctions.ContainsKey($_) } | Sort-Object)
    Assert (-not $missingFunctions.Count) "The expression table calls no: $($missingFunctions -join ', ')"

    # -------------------------------------------------------------------
    # The assertion table. Every cell of the coercion rules, stated as pass,
    # fail, or a refusal the comparer will not make a judgement on.
    # -------------------------------------------------------------------
    $assertTable = @($tables | Where-Object { [string]$_.kind -eq 'asserts' })[0]
    Assert ($null -ne $assertTable) 'The manifest names the assertion table.'
    $assertCases = @((ConvertFrom-Yaml (Get-Content -LiteralPath (Get-CorpusPath ([string]$assertTable.cases)) -Raw)).cases | Where-Object { $null -ne $_ })
    Assert ($assertCases.Count -gt 80) "The assertion table holds $($assertCases.Count) rows, which is fewer than the operators have corners."
    $usedOperators = @{}
    foreach ($case in $assertCases) {
        $row = @{} + $case
        $operator = [string]$row.op
        $usedOperators[$operator] = $true
        $present = if ($row.ContainsKey('present')) { [bool]$row.present } else { $true }
        $label = "$operator of [$($row.actual)] against [$($row.expected)]"
        $outcome = $null
        $failure = $null
        try { $outcome = Test-SuiteComparison -Operator $operator -Actual $row.actual -Expected $row.expected -Present $present }
        catch { $failure = $_.Exception.Message }
        switch ([string]$row.result) {
            'error' {
                Assert ($null -ne $failure) "$label returned $outcome; the table says it cannot be compared at all."
                if ($row.ContainsKey('code')) {
                    Assert ((($failure -split ':', 2)[0]) -eq [string]$row.code) "$label is refused with [$failure]; the table says $($row.code)."
                }
            }
            'pass' {
                Assert ($null -eq $failure) "$label was refused with [$failure]; the table says it passes."
                Assert ([bool]$outcome) "$label is false; the table says it passes."
            }
            'fail' {
                Assert ($null -eq $failure) "$label was refused with [$failure]; the table says it fails."
                Assert (-not [bool]$outcome) "$label is true; the table says it fails."
            }
            default { Assert $false "$label states result [$($row.result)], which is not pass, fail or error." }
        }
        $counts.asserts++
    }

    # Every operator appears, apart from the one that is not a comparison:
    # `script` runs a fragment of the host language against the bag, and the
    # catalog marks it as PowerShell only.
    $missingOperators = @(Get-SuiteAssertionOperator | Where-Object { $_ -ne 'script' -and -not $usedOperators.ContainsKey($_) } | Sort-Object)
    Assert (-not $missingOperators.Count) "The assertion table has no row for: $($missingOperators -join ', ')"

    # The three things the canonical form is for: two runs of one suite differ
    # only in what they measured, a different result is still a difference, and
    # neither claim depends on the format.
    $timestamped = @'
<test-run id="2" start-time="2026-01-01 00:00:00Z" end-time="2026-01-01 00:00:09Z" duration="9.000" clr-version="8.0.0" total="1" passed="1">
  <test-suite id="0-1001" name="s" result="Passed" duration="9.000"><test-case id="0-2001" name="c" result="Passed" duration="9.000" /></test-suite>
</test-run>
'@
    $later = $timestamped.Replace('2026-01-01 00:00:00Z', '2026-06-30 11:22:33Z').Replace('9.000', '0.125').Replace('id="2"', 'id="7"').Replace('8.0.0', '9.1.2')
    $differentResult = $timestamped.Replace('name="c" result="Passed"', 'name="c" result="Failed"')
    Assert ((Test-ReportsEqual -Left $timestamped -Right $later).equal) 'Two runs that differ only in when they ran and how long they took canonicalise equal.'
    $changed = Test-ReportsEqual -Left $timestamped -Right $differentResult
    Assert (-not $changed.equal) 'A different case result is still a difference.'
    Assert ($changed.difference -match 'result=') "The difference names the line it is on: $($changed.difference)"
    $shorter = Test-ReportsEqual -Left $timestamped -Right '<test-run total="1" passed="1" />'
    Assert (-not $shorter.equal) 'A report missing everything under it is a difference.'
    # The comparison itself, on text rather than on reports, so that a document
    # running out before the other is exercised as well as one that differs.
    Assert ((Get-FirstReportDifference -Left "a`nb`n" -Right "a`nb`n") -eq '') 'Two documents that match line for line do not differ.'
    Assert ((Get-FirstReportDifference -Left "a`nb`n" -Right "a`nc`n") -match 'line 2') 'The difference names the line it is on.'
    Assert ((Get-FirstReportDifference -Left "a`nb`nc" -Right "a`nb") -match '\(nothing\)') 'A document that ends while the other goes on is a difference.'
    Assert ((Get-FirstReportDifference -Left "a`nb" -Right "a`nb`nc") -match '\(nothing\)') 'And the same the other way round.'
    # A capture the two bindings serialise in different key orders is the same
    # capture. What a step captured is behaviour; the order a hash map happened
    # to enumerate it in is not, and four bindings enumerate in four orders.
    Assert ((ConvertTo-SortedJsonLine -Line '{"b":1,"a":2}') -eq '{"a":2,"b":1}') 'A captured object comes out with its keys in order.'
    Assert ((ConvertTo-SortedJsonLine -Line 'not json at all') -eq 'not json at all') 'A line that is not JSON is left exactly as it was.'
    Assert ((ConvertTo-SortedJsonLine -Line '{broken') -eq '{broken') 'And so is one that only looks like it.'
    Assert ((ConvertTo-SortedJsonLine -Line '{not json}') -eq '{not json}') 'And one that has the right brackets and nothing else right.'
    Assert ((ConvertTo-SortedJsonLine -Line '[1,2]') -eq '[1,2]') 'A list is not an object, and is left alone.'
    Assert ((ConvertTo-SortedJsonLine -Line '  {"z":[{"y":1,"x":2}]}  ') -eq '{"z":[{"x":2,"y":1}]}') 'The sort reaches inside a list without reordering the list.'
    Assert ((ConvertTo-SortedJsonValue -Value 3) -eq 3) 'A scalar sorts to itself.'
    # A suite that creates something captures a new identifier every time it
    # runs, so two runs of one binding differ there. Everything else still has
    # to match, and that is what the comparison without captures is for.
    $withOutput = '<r><test-case name="c"><output>{"id":"minted"}</output></test-case></r>'
    $other = '<r><test-case name="c"><output>{"id":"different"}</output></test-case></r>'
    Assert (-not (Test-ReportsEqual -Left $withOutput -Right $other).equal) 'A different capture is a difference by default.'
    Assert ((Test-ReportsEqual -Left $withOutput -Right $other -IgnoreOutput).equal) 'A suite that mints an identifier is compared without its captures.'
    $differentCase = '<r><test-case name="other"><output>{"id":"minted"}</output></test-case></r>'
    Assert (-not (Test-ReportsEqual -Left $withOutput -Right $differentCase -IgnoreOutput).equal) 'And everything else still has to match.'
    $junitOutput = '<r><testcase name="c"><system-out>{"id":"minted"}</system-out></testcase></r>'
    $junitOther = '<r><testcase name="c"><system-out>{"id":"other"}</system-out></testcase></r>'
    Assert ((Test-ReportsEqual -Left $junitOutput -Right $junitOther -IgnoreOutput).equal) 'JUnit names the same block differently, and it is left out too.'
    Assert ((ConvertTo-CanonicalReport -Report ([xml]$timestamped)) -eq (ConvertTo-CanonicalReport -Report $timestamped)) 'A document and its text canonicalise the same.'
    $onDisk = Join-Path $scratch 'canonical-sample.xml'
    Set-Content -LiteralPath $onDisk -Value $timestamped
    Assert ((ConvertTo-CanonicalReport -Report $onDisk) -eq (ConvertTo-CanonicalReport -Report $timestamped)) 'A path canonicalises the same as the text at it.'
    $refused = ''
    try { $null = ConvertTo-CanonicalReport -Report 42 } catch { $refused = $_.Exception.Message }
    Assert ($refused -match 'XmlDocument') "A report that is neither a document, its text nor a path is refused: $refused"
    $withText = ConvertTo-CanonicalReport -Report '<r><a>one</a><b>line one
line two</b><c></c><d>text<e/></d></r>'
    Assert ($withText -match '<a>one</a>') 'A single line of text stays on its element.'
    Assert ($withText -match "(?m)^    line two$") 'Text over several lines is indented under its element.'
    Assert ($withText -match '<c/>') 'An element with nothing in it is written as an empty one.'
    Assert ($withText -match "(?m)^    text$") 'Text beside child elements is kept above them.'

    # -------------------------------------------------------------------
    # The corpus has to be able to fail. A comparison that passes whatever
    # the files hold proves nothing, so one expectation of each kind is
    # deliberately moved and the comparison is asked about it.
    # -------------------------------------------------------------------
    $sampleValidate = @($entries | Where-Object { [string]$_.suite -eq 'validate/typos.yml' })[0]
    $produced = Invoke-ValidateEntry -Entry (@{} + $sampleValidate)
    $moved = @($produced.diagnostics | ForEach-Object { $copy = [ordered]@{} + $_; $copy })
    $moved[1].line = [int]$moved[1].line + 1
    $movedText = ConvertTo-ComparableJson -Value (Get-DiagnosticList -Findings $moved -SuiteRelative 'validate/typos.yml')
    $trueText = ConvertTo-ComparableJson -Value $produced.diagnostics
    Assert ($movedText -ne $trueText) 'A diagnostic moved by one line is a difference.'
    Assert ($movedText -match '"code": "E104"') 'The diff holds the row that moved, so a reader can see which one it was.'
    $recoded = @($produced.diagnostics | ForEach-Object { $copy = [ordered]@{} + $_; $copy })
    $recoded[0].code = 'E999'
    Assert ((ConvertTo-ComparableJson -Value (Get-DiagnosticList -Findings $recoded -SuiteRelative 'validate/typos.yml')) -ne $trueText) `
        'A diagnostic with a different code is a difference.'
    $dropped = @($produced.diagnostics)[0..1]
    Assert ((ConvertTo-ComparableJson -Value (Get-DiagnosticList -Findings $dropped -SuiteRelative 'validate/typos.yml')) -ne $trueText) `
        'An expectation that names fewer findings than the validator produces is a difference, not a subset that passes.'

    $sampleExecute = @($entries | Where-Object { [string]$_.suite -eq 'execute/hooks.yml' })[0]
    $hooksExpected = (Get-Content -LiteralPath (Get-CorpusPath ([string]$sampleExecute.expectation)) -Raw) | ConvertFrom-Json -AsHashtable
    $hooksTrue = ConvertTo-ComparableJson -Value (Get-TraceList -Trace @($hooksExpected.trace))
    $reordered = @(@($hooksExpected.trace)[1], @($hooksExpected.trace)[0]) + @(@($hooksExpected.trace)[2..(@($hooksExpected.trace).Count - 1)])
    Assert ((ConvertTo-ComparableJson -Value (Get-TraceList -Trace $reordered)) -ne $hooksTrue) `
        'Two phases in the other order is a difference: the order is the whole point of a trace.'
    $restatused = @($hooksExpected.trace | ForEach-Object { [ordered]@{} + $_ })
    $restatused[0].status = 'failed'
    Assert ((ConvertTo-ComparableJson -Value (Get-TraceList -Trace $restatused)) -ne $hooksTrue) 'A different status is a difference.'

    # -------------------------------------------------------------------
    # The core catalog agrees with what this runtime registers: every core
    # action spec/core.catalog.yaml lists for powershell is registered, and
    # nothing else is when no extension adds one.
    # -------------------------------------------------------------------
    $coreCatalog = ConvertFrom-Yaml (Get-Content -LiteralPath (Join-Path $specRoot 'core.catalog.yaml') -Raw) -Ordered
    $declaredCore = @($coreCatalog.actions | Where-Object { @($_.bindings) -contains 'powershell' } | ForEach-Object { [string]$_.name } | Sort-Object)
    $null = New-SuiteComposite
    $registered = @(Get-SuiteActionNames)
    Assert (($declaredCore -join ',') -eq ($registered -join ',')) "The core catalog's powershell actions ($($declaredCore -join ', ')) are not the registered ones ($($registered -join ', '))."
    Assert ($registered.Count -eq 6) "Six core actions are registered: $($registered -join ', ')"

    # -------------------------------------------------------------------
    # Every code diagnostics.md documents has a fixture. A code without one is
    # a promise to the other runtimes that nothing holds anybody to.
    # -------------------------------------------------------------------
    $documented = @([regex]::Matches((Get-Content -LiteralPath (Join-Path $specRoot 'diagnostics.md') -Raw), '(?m)^\|\s*`([EW][0-9]{3})`') |
        ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    Assert ($documented.Count -gt 20) "diagnostics.md yielded only $($documented.Count) codes, so the table was not read."
    $uncovered = @($documented | Where-Object { -not $seenCodes.ContainsKey($_) })
    Assert (-not $uncovered.Count) "No corpus entry produces: $($uncovered -join ', ')"

    Write-Host ("PASS: $script:checks conformance assertions: {0} validate, {1} execute ({6} pending), {7} generate, {2} reports, {3} expression rows, {4} assertion rows, core catalog = {5} registered." -f
        $counts.validate, $counts.execute, $counts.reports, $counts.expressions, $counts.asserts, $registered.Count, $pending.Count, $generateChecked)
} finally {
    if (Test-Path -LiteralPath $scratch) {
        $resolved = [IO.Path]::GetFullPath($scratch)
        if (-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { throw 'Scratch directory escaped temp root.' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
