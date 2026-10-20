<#
.SYNOPSIS
    BddSuite: the PowerShell runtime of the BDD suite format.

.DESCRIPTION
    The suite model, the lint, step execution, the expression language, the
    assertion operators, report comparison, the action registry and the core
    actions (core.*, wait) live in the modules beside this one; this file
    loads them, adds the extension API (DEC-S03) and the generic runner,
    Invoke-BddSuite.

    An extension is a PowerShell module that exports one function,
    Get-SuiteExtension, returning a hashtable with any of:

        Name         shown in errors about this extension (default: the module name)
        ActionPath   folders (or files) of action .ps1 files, each calling
                     Register-SuiteAction; relative to the module's folder
        Modules      further modules the step runspace imports before the
                     action files load (helpers the actions call)
        ContextKeys  names readable in ${...} and known to the dataflow lint
        Options      @(@{ Name = 'region'; Description = '...' }): the values
                     Invoke-BddSuite -Option @{ region = 'eu' } may give
        Rules        @{ Lint = { param($In) <diagnostics> };
                        CaseLimitSec = { param($Suite, $DeclaredSec) <seconds> } }
        EnvPrefix    the prefix of PARAM_<NAME> and RECORD_PATH (default BDD_SUITE_)
        Start        { param([hashtable]$Options) @{ Context = @{...}; Redact = {...}; State = ... } }
        Cases        @{ SkipCase = { param($In) ... }; AfterCase = { param($In) ... }; ... }:
                     hooks the runner calls around each case and step (this
                     runtime only; README.md, "Case hooks")

    Several extensions compose; a name two of them define, or one that clashes
    with the core, is refused before anything runs. README.md says the same
    with an example.
#>

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

Import-Module powershell-yaml -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot 'Expression.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Assertions.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'SuiteModel.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'SuiteLint.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'StepExecution.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'ReportCompare.psm1') -DisableNameChecking

# The names the registry had when it was copied out of os-context, kept so an
# action file written against them loads unchanged.
Set-Alias -Name Register-LabAction -Value Register-SuiteAction
Set-Alias -Name Get-LabActionNames -Value Get-SuiteActionNames
Set-Alias -Name Get-LabAction -Value Get-SuiteAction

# The prefix of <prefix>PARAM_<NAME> and <prefix>RECORD_PATH when no extension
# sets one.
$script:DefaultEnvPrefix = 'BDD_SUITE_'

# The roots every expression may start at before any extension adds a key.
$script:CoreRoots = @('capture', 'param', 'var', 'row', 'timeoutSec', 'defaults')

# Names a step's context holds for the runner's own use. An extension's context
# key may not take one: it would overwrite what the runner keeps there.
$script:ReservedContextNames = @('caseName', 'suiteName', 'recordPath', 'state', 'deadline', 'caseStartedUtc',
    'caseLimitSec', 'caseWorkStatus', '__roots', '__states', '__nested')

# Invoke-BddSuite's own parameters. An extension option may not take one,
# whatever its case, because a reader could not tell them apart.
$script:CoreOptionNames = @('Path', 'Tags', 'Name', 'Progress', 'Observer', 'TestName', 'ResultsFile', 'ReportFormat', 'DryRun', 'Lint', 'Strict', 'Json',
    'Param', 'TraceFile', 'TimingFile', 'StopFile', 'SchemaRoot', 'ActionPath', 'Extension', 'Option', 'Binding', 'BindingCheck')

# The hooks an extension's Cases part may hold, in the order the runner reaches
# them for one case. PowerShell only: the other runtimes have no such part.
$script:CaseHookNames = @('SkipCase', 'CaseContext', 'CheckStep', 'SkipStep', 'WorkStarted', 'AfterStep', 'WorkFinished',
    'CaseFinally', 'AfterCase', 'AfterSuiteHook', 'AfterTeardown')

# The core's own actions.
$script:CoreActionFiles = @((Join-Path $PSScriptRoot 'actions/Core.ps1'), (Join-Path $PSScriptRoot 'actions/Wait.ps1'))

function Initialize-SuiteActionRegistry {
    <#
    .SYNOPSIS
        Empty the registry and register the core actions (core.*, wait) again.
    #>
    [CmdletBinding()]
    param()
    Reset-SuiteActionRegistry
    $previous = Set-SuiteActionOwner -Owner 'the core'
    try { foreach ($file in $script:CoreActionFiles) { . $file } }
    finally { $null = Set-SuiteActionOwner -Owner $previous }
}

# Every session that loads the runtime has the core registered.
Initialize-SuiteActionRegistry

function Get-SuiteActionFile {
    <#
    .SYNOPSIS
        The action files one source names: a .ps1 file, or every .ps1 in a
        folder, sorted by name.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path, [string]$Base)
    $full = if ([IO.Path]::IsPathRooted($Path)) { $Path } elseif ($Base) { Join-Path $Base $Path } else { Join-Path (Get-Location).Path $Path }
    $full = [IO.Path]::GetFullPath($full)
    if (Test-Path -LiteralPath $full -PathType Leaf) { return @($full) }
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw "Action path $Path does not exist ($full)." }
    return @(Get-ChildItem -LiteralPath $full -Filter '*.ps1' -File | Sort-Object Name | ForEach-Object { $_.FullName })
}

function Import-SuiteActionSource {
    <#
    .SYNOPSIS
        Load one source's action files into this session's registry, under its
        owner's name.
    .DESCRIPTION
        Each file is dot-sourced here, in this function's own scope, so what a
        file declares at its top level cannot overwrite the caller's variables.
        The step runspace loads the same files at its top level instead
        (StepExecution.psm1), where a helper a file defines has to outlive the
        load because its handler calls it later.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Owner, [string[]]$File = @())
    $__bddPrevious = Set-SuiteActionOwner -Owner $Owner
    try { foreach ($__bddFile in @($File)) { if ($__bddFile) { . $__bddFile } } }
    finally { $null = Set-SuiteActionOwner -Owner $__bddPrevious }
}

function Import-SuiteExtension {
    <#
    .SYNOPSIS
        Load one extension module and return its description, normalised.
    .DESCRIPTION
        The module is imported and its exported Get-SuiteExtension called.
        Relative paths in ActionPath and Modules are read against the module's
        own folder. Nothing is registered here: New-SuiteComposite does that,
        so every refusal is made in one place.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    $full = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path (Get-Location).Path $Path }))
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Extension $Path does not exist ($full)." }
    $module = Import-Module $full -PassThru -Force -DisableNameChecking -ErrorAction Stop | Select-Object -First 1
    $describe = $module.ExportedFunctions['Get-SuiteExtension']
    if (-not $describe) { throw "Extension $Path exports no Get-SuiteExtension, so it describes nothing." }
    $described = & $describe
    if ($described -isnot [System.Collections.IDictionary]) { throw "Extension $Path`: Get-SuiteExtension returned no hashtable." }

    $allowed = @('Name', 'ActionPath', 'Modules', 'ContextKeys', 'Options', 'Rules', 'EnvPrefix', 'Start', 'Cases')
    foreach ($key in @($described.Keys)) {
        if ($allowed -notcontains $key) { throw "Extension $Path declares $key; an extension declares $($allowed -join ', ')." }
    }
    $name = if ($described.Name) { [string]$described.Name } else { $module.Name }
    $base = $module.ModuleBase
    $files = [Collections.Generic.List[string]]::new()
    foreach ($source in @($described.ActionPath)) { if ($source) { foreach ($file in Get-SuiteActionFile -Path ([string]$source) -Base $base) { $files.Add($file) } } }
    $modules = [Collections.Generic.List[string]]::new()
    foreach ($extra in @($described.Modules)) {
        if (-not $extra) { continue }
        $modulePath = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted([string]$extra)) { [string]$extra } else { Join-Path $base ([string]$extra) }))
        if (-not (Test-Path -LiteralPath $modulePath)) { throw "Extension $name names the module $extra, which does not exist ($modulePath)." }
        $modules.Add($modulePath)
    }
    $rules = if ($described.Rules -is [System.Collections.IDictionary]) { $described.Rules } else { @{} }
    foreach ($key in @($rules.Keys)) {
        if (@('Lint', 'CaseLimitSec') -notcontains $key) { throw "Extension $name declares the rule $key; a rule is Lint or CaseLimitSec." }
        if ($rules[$key] -isnot [scriptblock]) { throw "Extension $name declares the rule $key as something other than a scriptblock." }
    }
    if ($null -ne $described.Start -and $described.Start -isnot [scriptblock]) { throw "Extension $name declares Start as something other than a scriptblock." }
    $cases = @{}
    if ($null -ne $described.Cases) {
        if ($described.Cases -isnot [System.Collections.IDictionary]) { throw "Extension $name declares Cases as something other than a hashtable of hooks." }
        foreach ($key in @($described.Cases.Keys)) {
            if ($script:CaseHookNames -cnotcontains $key) { throw "Extension $name declares the case hook $key; a case hook is $($script:CaseHookNames -join ', ')." }
            if ($described.Cases[$key] -isnot [scriptblock]) { throw "Extension $name declares the case hook $key as something other than a scriptblock." }
            $cases[$key] = $described.Cases[$key]
        }
    }
    $options = foreach ($option in @($described.Options)) {
        if ($null -eq $option) { continue }
        if ($option -is [string]) { @{ Name = $option; Description = '' } }
        elseif ($option -is [System.Collections.IDictionary]) { @{ Name = [string]$option.Name; Description = [string]$option.Description } }
        else { throw "Extension $name declares an option that is neither a name nor @{ Name; Description }." }
    }
    return @{
        Name        = $name
        Path        = $full
        ModuleName  = $module.Name
        ActionFiles = $files.ToArray()
        Modules     = @(@($full) + $modules.ToArray())
        ContextKeys = @(@($described.ContextKeys) | Where-Object { $_ } | ForEach-Object { [string]$_ })
        Options     = @($options)
        Lint        = $rules['Lint']
        CaseLimit   = $rules['CaseLimitSec']
        EnvPrefix   = $(if ($described.Contains('EnvPrefix') -and $null -ne $described.EnvPrefix) { [string]$described.EnvPrefix } else { $null })
        Start       = $described.Start
        Cases       = $cases
    }
}

function New-SuiteComposite {
    <#
    .SYNOPSIS
        Every extension of one run, merged and checked, with its actions
        registered in this session.
    .DESCRIPTION
        Refuses, with the words every runtime uses:
            Action X is defined by both A and B.
            Context key K is defined by both A and B.
            Option O is defined by both A and B.
            A sets the environment prefix P and B sets Q.
        The core owns its actions, the roots capture, param, var, row,
        timeoutSec and defaults, and Invoke-BddSuite's own parameter names.
        -ActionPath sources are action files with no other part; each is owned
        by its folder.
    #>
    [CmdletBinding()]
    param([object[]]$Extension = @(), [string[]]$ActionPath = @())

    Initialize-SuiteActionRegistry
    $keys = [ordered]@{}
    foreach ($key in $script:CoreRoots + $script:ReservedContextNames) { $keys[$key] = 'the core' }
    $optionOwners = @{}
    foreach ($name in $script:CoreOptionNames) { $optionOwners[$name.ToLowerInvariant()] = @{ owner = 'the core'; name = $name } }
    $prefix = $null
    $extensions = [Collections.Generic.List[hashtable]]::new()
    $sources = [Collections.Generic.List[hashtable]]::new()
    $contextKeys = [Collections.Generic.List[string]]::new()
    $options = [Collections.Generic.List[hashtable]]::new()
    $lintRules = [Collections.Generic.List[hashtable]]::new()
    $caseHooks = @{}
    foreach ($hookName in $script:CaseHookNames) { $caseHooks[$hookName] = [Collections.Generic.List[hashtable]]::new() }

    foreach ($e in @($Extension)) {
        if ($null -eq $e) { continue }
        foreach ($k in @($e.ContextKeys)) {
            if ($keys.Contains($k)) { throw "Context key $k is defined by both $($keys[$k]) and $($e.Name)." }
            $keys[$k] = $e.Name
            $contextKeys.Add($k)
        }
        foreach ($o in @($e.Options)) {
            if ($o.Name -cnotmatch '^[a-z][A-Za-z0-9]*$') { throw "$($e.Name) declares the option $($o.Name); an option is a camelCase word, such as region or zoneName." }
            $held = $optionOwners[$o.Name.ToLowerInvariant()]
            if ($held) { throw "Option $($o.Name) is defined by both $($held.owner) and $($e.Name)." }
            $optionOwners[$o.Name.ToLowerInvariant()] = @{ owner = $e.Name; name = $o.Name }
            $options.Add(@{ Name = $o.Name; Description = $o.Description; Owner = $e.Name })
        }
        if ($null -ne $e.EnvPrefix) {
            if ($prefix -and $prefix.value -cne $e.EnvPrefix) {
                throw "$($prefix.owner) sets the environment prefix $($prefix.value) and $($e.Name) sets $($e.EnvPrefix)."
            }
            $prefix = @{ value = $e.EnvPrefix; owner = $e.Name }
        }
        if ($e.Lint) { $lintRules.Add(@{ Owner = $e.Name; Rule = $e.Lint }) }
        # In -Extension order, so every hook point calls the extensions in the
        # order the run named them.
        foreach ($hookName in $script:CaseHookNames) {
            if ($e.Cases -and $e.Cases[$hookName]) { $caseHooks[$hookName].Add(@{ Owner = $e.Name; Keys = @($e.ContextKeys); Hook = $e.Cases[$hookName] }) }
        }
        Import-SuiteActionSource -Owner $e.Name -File $e.ActionFiles
        $sources.Add(@{ owner = $e.Name; files = @($e.ActionFiles) })
        $extensions.Add($e)
    }
    foreach ($source in @($ActionPath)) {
        if (-not $source) { continue }
        $files = @(Get-SuiteActionFile -Path $source)
        $owner = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($source)) { $source } else { Join-Path (Get-Location).Path $source }))
        Import-SuiteActionSource -Owner $owner -File $files
        $sources.Add(@{ owner = $owner; files = $files })
    }
    foreach ($hookName in $script:CaseHookNames) { $caseHooks[$hookName] = $caseHooks[$hookName].ToArray() }
    return @{
        Extensions  = $extensions.ToArray()
        ContextKeys = $contextKeys.ToArray()
        Roots       = @($script:CoreRoots) + $contextKeys.ToArray()
        Options     = $options.ToArray()
        EnvPrefix   = $(if ($prefix) { $prefix.value } else { $script:DefaultEnvPrefix })
        LintRules   = $lintRules.ToArray()
        # Hook name to its hooks, each @{ Owner; Keys; Hook }, in -Extension order.
        CaseHooks   = $caseHooks
        # What the step runspace loads (New-StepRunspace -Load).
        Load        = @{
            modules = @($extensions | ForEach-Object { $_.Modules } | Where-Object { $_ })
            sources = $sources.ToArray()
        }
    }
}

function Get-SuiteRunLoad {
    <#
    .SYNOPSIS
        What a step runspace has to load for one composite (New-StepRunspace -Load).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Composite)
    return $Composite.Load
}

function Get-SuiteCaseLimitSec {
    <#
    .SYNOPSIS
        The limit a case runs under: the smallest of what it declares and what
        every extension's CaseLimitSec allows for its suite.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Composite, $Suite, [Parameter(Mandatory)][int]$DeclaredSec)
    $limit = $DeclaredSec
    foreach ($e in @($Composite.Extensions)) {
        if (-not $e.CaseLimit) { continue }
        $allowed = & $e.CaseLimit $Suite $DeclaredSec
        if ($null -ne $allowed -and [int]$allowed -lt $limit) { $limit = [int]$allowed }
    }
    return $limit
}

function Start-SuiteExtension {
    <#
    .SYNOPSIS
        Start every extension once for a run, each with its own options' values.
    .DESCRIPTION
        Refuses an option no extension declares. Returns the context value of
        each key an extension gave one (only its own keys), each extension's
        State by name, and the redactors in order.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Composite, [hashtable]$Option = @{})

    $declared = @{}
    foreach ($o in @($Composite.Options)) { $declared[$o.Name.ToLowerInvariant()] = $o }
    foreach ($name in @($Option.Keys)) {
        if (-not $declared.ContainsKey(([string]$name).ToLowerInvariant())) {
            throw "Invoke-BddSuite does not take the option ${name}: no extension of this run declares it."
        }
    }
    $context = @{}
    $states = @{}
    $redactors = [Collections.Generic.List[scriptblock]]::new()
    foreach ($e in @($Composite.Extensions)) {
        $own = @{}
        foreach ($o in @($e.Options)) {
            foreach ($name in @($Option.Keys)) { if (([string]$name).ToLowerInvariant() -eq $o.Name.ToLowerInvariant()) { $own[$o.Name] = $Option[$name] } }
        }
        $run = if ($e.Start) { & $e.Start $own } else { $null }
        if ($run -isnot [System.Collections.IDictionary]) { $run = @{} }
        $states[$e.Name] = $run.State
        if ($run.Context -is [System.Collections.IDictionary]) {
            foreach ($key in @($run.Context.Keys)) { if (@($e.ContextKeys) -ccontains $key) { $context[$key] = $run.Context[$key] } }
        }
        if ($run.Redact -is [scriptblock]) { $redactors.Add($run.Redact) }
    }
    return @{ Context = $context; States = $states; Redactors = $redactors.ToArray() }
}

function Protect-SuiteText {
    <#
    .SYNOPSIS
        A text with every started extension's redaction applied, in order.
    #>
    [CmdletBinding()]
    param([AllowNull()][AllowEmptyString()][string]$Text, [hashtable]$Started)
    if ($null -eq $Text) { return $Text }
    if (-not $Started) { return $Text }
    foreach ($redact in @($Started.Redactors)) { $Text = [string](& $redact $Text) }
    return $Text
}

# ---- Reports --------------------------------------------------------------

function New-NUnit3Xml {
    <#
    .SYNOPSIS
        The run as an NUnit 3 document.
    #>
    [CmdletBinding()]
    param([System.Collections.IList]$Suites)

    $doc = New-Object System.Xml.XmlDocument
    $declaration = $doc.CreateXmlDeclaration('1.0', 'UTF-8', $null)
    $doc.AppendChild($declaration) | Out-Null

    $totalTests = 0; $totalPassed = 0; $totalFailed = 0; $totalSkipped = 0; $totalDuration = 0.0
    $minStart = [DateTime]::MaxValue; $maxEnd = [DateTime]::MinValue

    foreach ($s in $Suites) {
        foreach ($t in $s.tests) {
            $totalTests++
            switch ($t.status) {
                'passed' { $totalPassed++ }
                'failed' { $totalFailed++ }
                'error' { $totalFailed++ }
                'skipped' { $totalSkipped++ }
            }
            $totalDuration += [double]$t.durationSec
            if ($t.startTime -and $t.startTime -lt $minStart) { $minStart = $t.startTime }
            if ($t.endTime -and $t.endTime -gt $maxEnd) { $maxEnd = $t.endTime }
        }
    }
    if ($minStart -eq [DateTime]::MaxValue) { $minStart = Get-Date }
    if ($maxEnd -eq [DateTime]::MinValue) { $maxEnd = Get-Date }

    $overallResult = if ($totalFailed -gt 0) { 'Failed' } else { 'Passed' }

    $run = $doc.CreateElement('test-run')
    $run.SetAttribute('id', '2')
    $run.SetAttribute('testcasecount', [string]$totalTests)
    $run.SetAttribute('result', $overallResult)
    $run.SetAttribute('total', [string]$totalTests)
    $run.SetAttribute('passed', [string]$totalPassed)
    $run.SetAttribute('failed', [string]$totalFailed)
    $run.SetAttribute('inconclusive', '0')
    $run.SetAttribute('skipped', [string]$totalSkipped)
    $run.SetAttribute('asserts', '0')
    $run.SetAttribute('engine-version', '1.0')
    $run.SetAttribute('clr-version', [string][Environment]::Version)
    $run.SetAttribute('start-time', $minStart.ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ssZ'))
    $run.SetAttribute('end-time', $maxEnd.ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ssZ'))
    $run.SetAttribute('duration', $totalDuration.ToString('F3', [Globalization.CultureInfo]::InvariantCulture))
    $doc.AppendChild($run) | Out-Null

    $suiteId = 1000
    $caseId = 2000
    foreach ($s in $Suites) {
        $suiteTotal = $s.tests.Count
        $suitePassed = @($s.tests | Where-Object { $_.status -eq 'passed' }).Count
        $suiteFailed = @($s.tests | Where-Object { $_.status -in 'failed', 'error' }).Count
        $suiteSkipped = @($s.tests | Where-Object { $_.status -eq 'skipped' }).Count
        $suiteDuration = [double](($s.tests | Measure-Object durationSec -Sum).Sum)
        $suiteResult = if ($suiteFailed -gt 0) { 'Failed' } else { 'Passed' }
        $suiteStart = ($s.tests | Where-Object { $_.startTime } | Measure-Object startTime -Minimum).Minimum
        $suiteEnd = ($s.tests | Where-Object { $_.endTime } | Measure-Object endTime -Maximum).Maximum
        if (-not $suiteStart) { $suiteStart = Get-Date }
        if (-not $suiteEnd) { $suiteEnd = Get-Date }

        $suiteId++
        $suiteEl = $doc.CreateElement('test-suite')
        $suiteEl.SetAttribute('type', 'TestFixture')
        $suiteEl.SetAttribute('id', "0-$suiteId")
        $suiteEl.SetAttribute('name', $s.name)
        $suiteEl.SetAttribute('fullname', $s.name)
        $suiteEl.SetAttribute('classname', $s.name)
        $suiteEl.SetAttribute('runstate', 'Runnable')
        $suiteEl.SetAttribute('testcasecount', [string]$suiteTotal)
        $suiteEl.SetAttribute('result', $suiteResult)
        $suiteEl.SetAttribute('start-time', $suiteStart.ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ssZ'))
        $suiteEl.SetAttribute('end-time', $suiteEnd.ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ssZ'))
        $suiteEl.SetAttribute('duration', $suiteDuration.ToString('F3', [Globalization.CultureInfo]::InvariantCulture))
        $suiteEl.SetAttribute('total', [string]$suiteTotal)
        $suiteEl.SetAttribute('passed', [string]$suitePassed)
        $suiteEl.SetAttribute('failed', [string]$suiteFailed)
        $suiteEl.SetAttribute('inconclusive', '0')
        $suiteEl.SetAttribute('skipped', [string]$suiteSkipped)
        $suiteEl.SetAttribute('asserts', '0')

        foreach ($t in $s.tests) {
            $caseId++
            $caseEl = $doc.CreateElement('test-case')
            $tStart = if ($t.startTime) { $t.startTime } else { Get-Date }
            $tEnd = if ($t.endTime) { $t.endTime } else { Get-Date }
            $resultAttr = switch ($t.status) {
                'passed' { 'Passed' }
                'failed' { 'Failed' }
                'error' { 'Failed' }
                'skipped' { 'Skipped' }
                default { 'Inconclusive' }
            }
            $caseEl.SetAttribute('id', "0-$caseId")
            $caseEl.SetAttribute('name', $t.name)
            $caseEl.SetAttribute('fullname', "$($s.name).$($t.name)")
            $caseEl.SetAttribute('classname', $s.name)
            $caseEl.SetAttribute('methodname', $t.name)
            $caseEl.SetAttribute('runstate', 'Runnable')
            $caseEl.SetAttribute('result', $resultAttr)
            $caseEl.SetAttribute('start-time', $tStart.ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ssZ'))
            $caseEl.SetAttribute('end-time', $tEnd.ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ssZ'))
            $caseEl.SetAttribute('duration', ([double]$t.durationSec).ToString('F3', [Globalization.CultureInfo]::InvariantCulture))
            $caseEl.SetAttribute('asserts', '0')
            if ($t.status -eq 'error') { $caseEl.SetAttribute('label', 'Error') }

            if ($t.status -in 'failed', 'error') {
                $failEl = $doc.CreateElement('failure')
                $msgEl = $doc.CreateElement('message')
                $msgEl.AppendChild($doc.CreateCDataSection(($t.message -as [string]))) | Out-Null
                $failEl.AppendChild($msgEl) | Out-Null
                $stackEl = $doc.CreateElement('stack-trace')
                $stackEl.AppendChild($doc.CreateCDataSection(($t.details -as [string]))) | Out-Null
                $failEl.AppendChild($stackEl) | Out-Null
                $caseEl.AppendChild($failEl) | Out-Null
            } elseif ($t.status -eq 'skipped') {
                $reasonEl = $doc.CreateElement('reason')
                $msgEl = $doc.CreateElement('message')
                $msgEl.AppendChild($doc.CreateCDataSection(($t.message -as [string]))) | Out-Null
                $reasonEl.AppendChild($msgEl) | Out-Null
                $caseEl.AppendChild($reasonEl) | Out-Null
            }

            if ($t.stdout) {
                $outEl = $doc.CreateElement('output')
                $outEl.AppendChild($doc.CreateCDataSection(($t.stdout -as [string]))) | Out-Null
                $caseEl.AppendChild($outEl) | Out-Null
            }

            $suiteEl.AppendChild($caseEl) | Out-Null
        }
        $run.AppendChild($suiteEl) | Out-Null
    }

    return $doc
}

function New-JUnitXml {
    <#
    .SYNOPSIS
        The run as a JUnit document.
    .DESCRIPTION
        Moved from os-context's test support module, where the runner
        used to find it; nothing in it was specific to that product.
    #>
    [CmdletBinding()]
    param([System.Collections.IEnumerable]$Suites)
    $doc = [xml]'<?xml version="1.0" encoding="utf-8"?><testsuites />'
    foreach ($suite in $Suites) {
        $suiteNode = $doc.CreateElement('testsuite')
        $suiteNode.SetAttribute('name', $suite.name)
        $suiteNode.SetAttribute('tests', [string]$suite.tests.Count)
        $suiteNode.SetAttribute('failures', [string]@($suite.tests | Where-Object status -in @('failed', 'error')).Count)
        $suiteNode.SetAttribute('skipped', [string]@($suite.tests | Where-Object status -eq 'skipped').Count)
        foreach ($result in $suite.tests) {
            $case = $doc.CreateElement('testcase')
            $case.SetAttribute('name', $result.name)
            $case.SetAttribute('classname', $suite.name)
            $case.SetAttribute('time', ([double]$result.durationSec).ToString('F3', [Globalization.CultureInfo]::InvariantCulture))
            if ($result.status -in @('failed', 'error', 'skipped')) {
                $node = $doc.CreateElement($(if ($result.status -eq 'skipped') { 'skipped' } else { 'failure' }))
                $node.SetAttribute('message', $result.message)
                $node.InnerText = $result.details
                $null = $case.AppendChild($node)
            }
            $output = $doc.CreateElement('system-out')
            $output.InnerText = $result.stdout
            $null = $case.AppendChild($output)
            $null = $suiteNode.AppendChild($case)
        }
        $null = $doc.DocumentElement.AppendChild($suiteNode)
    }
    return $doc
}

# ---- The runner -----------------------------------------------------------

. (Join-Path $PSScriptRoot 'Progress.ps1')
. (Join-Path $PSScriptRoot 'Runner.ps1')
. (Join-Path $PSScriptRoot 'Session.ps1')
. (Join-Path $PSScriptRoot 'Generate.ps1')

# ---- The command line (suiterun) ------------------------------------------

. (Join-Path $PSScriptRoot 'Cli.ps1')

Export-ModuleMember -Function * -Alias Register-LabAction, Get-LabActionNames, Get-LabAction
