<#
.SYNOPSIS
    Invoke-BddSuiteCli: the PowerShell runtime's suiterun command line.
    Dot-sourced by BddSuite.psm1.

.DESCRIPTION
    The same four verbs, flags, outputs and exit codes as every program's
    suiterun (runtimes/typescript/src/cli.ts and run.ts), over Invoke-BddSuite:

        suiterun lint    --path <glob> [--json] [--strict] [--binding-check] [--binding <name>]
        suiterun run     --path <glob> [--tags a,b] [--results f.xml] [--format nunit3|junit]
                         [--dry-run] [--param name=value] [--trace-file f.json] [--test-name <case>]
        suiterun list    --path <glob> [--tags a,b] [--test-name <case>]
        suiterun actions [--json]

    plus --schema-root <dir> on any verb, and every option an extension
    declares as --<name> <value>. --test-name is this runtime's addition: run
    (or list) exactly one case of one suite file; an outline case selects every
    one of its rows.

    Exit codes: 0 every selected case passed (or the lint found nothing that
    fails it), 1 a case failed, 2 refused (a usage error, a lint that fails, a
    run that could not start). A usage error prints "suiterun: <why>" and the
    usage text on standard error.

    A workspace's suiterun.ps1 is: import BddSuite, then
        exit (Invoke-BddSuiteCli -Arguments $args -Extension <its extension modules>)
#>

$script:CliUsage = @'
suiterun lint    --path <glob> [--json] [--strict] [--binding-check] [--binding <name>]
suiterun run     --path <glob> [--tags a,b] [--results f.xml] [--format nunit3|junit]
                 [--dry-run] [--param name=value] [--trace-file f.json] [--test-name <case>]
suiterun list    --path <glob> [--tags a,b]
suiterun actions [--json]
'@ -replace "`r", ''

$script:CliVerbs = @('lint', 'run', 'list', 'actions')
$script:CliSwitches = @('--json', '--strict', '--dry-run', '--binding-check')
$script:CliValued = @('--path', '--tags', '--results', '--trace-file', '--schema-root', '--binding', '--format', '--param', '--test-name')

function ConvertTo-BddSuiteOptionFlag {
    <#
    .SYNOPSIS
        The command-line flag of an extension option: its camelCase name in
        lower-case words, so zoneName is --zone-name, as every program spells it.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Name)
    return "--" + ([regex]::Replace($Name, "(?<=[a-z0-9])([A-Z])", { "-" + $args[0].Value.ToLowerInvariant() }))
}

function Get-BddSuiteCliUsage {
    <#
    .SYNOPSIS
        The usage text, with every option the extensions declare.
    #>
    [CmdletBinding()]
    param([object[]]$Option = @())
    if (-not @($Option).Count) { return $script:CliUsage }
    $lines = @(foreach ($o in @($Option)) { "                 $(ConvertTo-BddSuiteOptionFlag $o.Name) <value>  $($o.Description)" })
    return $script:CliUsage + "`nOptions the extensions add, for run:`n" + ($lines -join "`n")
}

function ConvertFrom-BddSuiteCliArgument {
    <#
    .SYNOPSIS
        One command line read into its options, or a throw of
        [ArgumentException] whose message is what the tool prints.
    .DESCRIPTION
        Read by hand, as the programs read theirs: the exit code is part of the
        contract, and an unknown argument is 2 with the usage text. A flag that
        takes a value never takes the next flag as its value.
    #>
    [CmdletBinding()]
    param([string[]]$Arguments = @(), [object[]]$Option = @())

    $usage = Get-BddSuiteCliUsage -Option $Option
    $extensionFlags = @{}
    foreach ($o in @($Option)) { $extensionFlags[(ConvertTo-BddSuiteOptionFlag $o.Name)] = [string]$o.Name }
    $parsed = [ordered]@{
        Verb = 'actions'; Path = ''; Tags = [Collections.Generic.List[string]]::new(); Results = ''; TraceFile = ''
        Format = 'nunit3'; Params = [Collections.Generic.List[string]]::new(); Binding = 'powershell'; Json = $false
        Strict = $false; DryRun = $false; BindingCheck = $false; SchemaRoot = ''; TestName = ''; Options = @{}
    }
    $all = @($Arguments | Where-Object { $null -ne $_ })
    if (-not $all.Count) { throw [ArgumentException]::new("a verb is needed.`n$usage") }
    $first = [string]$all[0]
    if ($script:CliVerbs -cnotcontains $first) { throw [ArgumentException]::new("there is no verb called $first.`n$usage") }
    $parsed.Verb = $first

    for ($i = 1; $i -lt $all.Count; $i++) {
        $name = [string]$all[$i]
        if ($script:CliSwitches -ccontains $name) {
            switch -CaseSensitive ($name) {
                '--json' { $parsed.Json = $true }
                '--strict' { $parsed.Strict = $true }
                '--dry-run' { $parsed.DryRun = $true }
                default { $parsed.BindingCheck = $true }
            }
            continue
        }
        if ($script:CliValued -cnotcontains $name -and -not $extensionFlags.ContainsKey($name)) {
            throw [ArgumentException]::new("$($parsed.Verb) does not take $name.`n$usage")
        }
        $value = if ($i + 1 -lt $all.Count) { [string]$all[$i + 1] } else { $null }
        if ($null -eq $value -or $value.StartsWith('--')) { throw [ArgumentException]::new("$name needs a value after it.`n$usage") }
        $i++
        if ($extensionFlags.ContainsKey($name)) {
            $parsed.Options[$extensionFlags[$name]] = $value
            continue
        }
        switch -CaseSensitive ($name) {
            '--path' { $parsed.Path = $value }
            '--tags' { foreach ($tag in $value -split ',') { if ($tag.Trim()) { $parsed.Tags.Add($tag.Trim()) } } }
            '--results' { $parsed.Results = $value }
            '--trace-file' { $parsed.TraceFile = $value }
            '--schema-root' { $parsed.SchemaRoot = $value }
            '--binding' { $parsed.Binding = $value }
            '--test-name' { $parsed.TestName = $value }
            '--format' {
                if ($value -cne 'nunit3' -and $value -cne 'junit') { throw [ArgumentException]::new("--format is nunit3 or junit, not $value.`n$usage") }
                $parsed.Format = $value
            }
            default {
                $at = $value.IndexOf('=')
                if ($at -le 0) { throw [ArgumentException]::new("--param takes name=value, and $value is not one.`n$usage") }
                $parsed.Params.Add($value)
            }
        }
    }
    # Every verb but actions reads suite files, so it has to be told which.
    if ($parsed.Verb -ne 'actions' -and -not $parsed.Path) { throw [ArgumentException]::new("$($parsed.Verb) needs --path.`n$usage") }
    return $parsed
}

function Resolve-BddSuiteCliPath {
    <#
    .SYNOPSIS
        Every file a --path names, as the programs read it: a directory and a
        last segment in which only * (any run) and ? (one character) are
        special; a name with neither must be an existing file. Sorted
        ordinally, so two machines run them in one order.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Pattern)
    $given = $Pattern -replace '\\', '/'
    $full = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($given)) { $given } else { Join-Path (Get-Location).Path $given }))
    $leaf = Split-Path $full -Leaf
    if ($leaf -notmatch '[*?]') {
        if (Test-Path -LiteralPath $full -PathType Leaf) { return @($full) }
        throw "$Pattern names no file"
    }
    $directory = Split-Path $full -Parent
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw "$directory cannot be read: it is not a folder." }
    $regex = '^' + ([regex]::Escape($leaf) -replace '\\\*', '.*' -replace '\\\?', '.') + '$'
    $found = [Collections.Generic.List[string]]::new()
    foreach ($item in [IO.Directory]::GetFiles($directory)) {
        if ([regex]::IsMatch([IO.Path]::GetFileName($item), $regex)) { $found.Add($item) }
    }
    if (-not $found.Count) { throw "$Pattern names no file" }
    $sorted = $found.ToArray()
    [Array]::Sort($sorted, [StringComparer]::Ordinal)
    return $sorted
}

function Get-BddSuiteCliCase {
    <#
    .SYNOPSIS
        The cases of one suite file a run would select, outlines expanded,
        filtered by tag and by --test-name as Invoke-BddSuite filters them.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$File, [string[]]$Tags = @(), [string]$TestName = '')
    $text = Get-Content -LiteralPath $File -Raw
    try { $suite = ConvertFrom-Yaml $text -Ordered } catch { throw "$File is not valid YAML: $($_.Exception.Message)" }
    if ($suite -isnot [System.Collections.IDictionary]) { throw "$File does not hold a YAML mapping." }
    $cases = @(Expand-SuiteOutline -Cases $suite.tests | Where-Object { $_ -is [System.Collections.IDictionary] })
    if ($TestName) {
        $selected = @($cases | Where-Object { [string]$_.name -ceq $TestName })
        if (-not $selected.Count) { $selected = @($cases | Where-Object { ([string]$_.name).StartsWith("$TestName [", [StringComparison]::Ordinal) }) }
        $cases = $selected
    }
    $suiteTags = @($suite.tags | Where-Object { $_ })
    return @($cases | Where-Object {
            $own = @(@($_.tags) + $suiteTags | Where-Object { $_ } | ForEach-Object { [string]$_ })
            -not @($Tags).Count -or @($own | Where-Object { $Tags -ccontains $_ }).Count
        } | ForEach-Object { [string]$_.name })
}

function ConvertTo-BddSuiteCliJson {
    <#
    .SYNOPSIS
        The lint's findings as the one document diagnostic.schema.json
        defines: an array, each finding's keys in the order it lists them.
    #>
    [CmdletBinding()]
    param([object[]]$Diagnostic = @())
    $findings = @(foreach ($finding in @($Diagnostic)) {
            if ($null -eq $finding) { continue }
            $ordered = [ordered]@{}
            foreach ($key in @('code', 'severity', 'file', 'line', 'column', 'message', 'suggestion')) {
                if ($finding.Contains($key) -and $null -ne $finding[$key] -and ($key -ne 'suggestion' -or $finding[$key])) { $ordered[$key] = $finding[$key] }
            }
            $ordered
        })
    if (-not $findings.Count) { return '[]' }
    return (ConvertTo-Json -InputObject $findings -Depth 6) -replace "`r", ''
}

function Invoke-BddSuiteCli {
    <#
    .SYNOPSIS
        Run one suiterun command line with the given extensions and return its
        exit code. Never exits the process.
    .PARAMETER Arguments
        The command line after the program name: a verb and its flags.
    .PARAMETER Extension
        Extension module paths, as Invoke-BddSuite -Extension takes them.
    .PARAMETER ActionPath
        Action folders or files, as Invoke-BddSuite -ActionPath takes them.
    .PARAMETER Out
        Where the verb's output goes, in one write (default: standard output).
    .PARAMETER ErrorOut
        Where "suiterun: <why>" goes (default: standard error).
    .EXAMPLE
        exit (Invoke-BddSuiteCli -Arguments $args -Extension "$PSScriptRoot/My.Extension.psm1")
    #>
    [CmdletBinding()]
    param(
        [AllowEmptyCollection()][string[]]$Arguments = @(),
        [string[]]$Extension = @(),
        [string[]]$ActionPath = @(),
        [IO.TextWriter]$Out = [Console]::Out,
        [IO.TextWriter]$ErrorOut = [Console]::Error
    )

    # The extensions first: their options are flags, and a clash between two
    # of them refuses the command line before it is read.
    try {
        $described = @(foreach ($one in @($Extension)) { if ($one) { Import-SuiteExtension -Path $one } })
        $composite = New-SuiteComposite -Extension $described -ActionPath $ActionPath
        # An option is its flag, so one the command line already has is a clash.
        foreach ($o in @($composite.Options)) {
            if (($script:CliValued + $script:CliSwitches) -contains (ConvertTo-BddSuiteOptionFlag $o.Name)) { throw "Option $($o.Name) is defined by both the core and $($o.Owner)." }
        }
        $options =ConvertFrom-BddSuiteCliArgument -Arguments $Arguments -Option $composite.Options
    } catch {
        $ErrorOut.Write("suiterun: $($_.Exception.Message)`n")
        $ErrorOut.Flush()
        return 2
    }

    $text = ''
    $code = 0
    try {
        switch ($options.Verb) {
            'actions' {
                $names = [string[]]@(Get-SuiteActionNames)
                [Array]::Sort($names, [StringComparer]::Ordinal)
                $text = if ($options.Json) {
                    if ($names.Count) { (ConvertTo-Json -InputObject $names) -replace "`r", '' } else { '[]' }
                } else { $names -join "`n" }
            }
            'list' {
                $lines = [Collections.Generic.List[string]]::new()
                foreach ($file in Resolve-BddSuiteCliPath -Pattern $options.Path) {
                    foreach ($name in Get-BddSuiteCliCase -File $file -Tags $options.Tags.ToArray() -TestName $options.TestName) {
                        $lines.Add("$([IO.Path]::GetFileName($file))  $name")
                    }
                }
                $text = $lines -join "`n"
            }
            default {
                $files = @(Resolve-BddSuiteCliPath -Pattern $options.Path)
                if ($options.SchemaRoot -eq '' -and -not (Get-SuiteWorkspaceRoot -Start (Get-Location).Path)) {
                    throw 'the workspace root cannot be found from this directory (no test/e2e/schema above it); pass --schema-root.'
                }
                $invocation = @{
                    Path         = $files
                    Json         = $true
                    Param        = $options.Params.ToArray()
                    Extension    = @()
                    ActionPath   = $ActionPath
                    Option       = $options.Options
                    Binding      = $options.Binding
                    BindingCheck = $options.BindingCheck
                    Strict       = $options.Strict
                }
                if ($options.SchemaRoot) { $invocation.SchemaRoot = $options.SchemaRoot }
                # The extensions were loaded above; Invoke-BddSuite loads them
                # again for its own composite, from the same paths.
                $invocation.Extension = @($Extension | Where-Object { $_ })
                if ($options.Verb -eq 'lint') {
                    $invocation.Lint = $true
                    $invocation.ResultsFile = ''
                    $outcome = Invoke-BddSuite @invocation
                    if ($outcome.Error) { throw $outcome.Error }
                    $found = @($outcome.Diagnostics | Where-Object { $null -ne $_ })
                    $code = [int]$outcome.ExitCode
                    $text = if ($options.Json) { ConvertTo-BddSuiteCliJson -Diagnostic $found } else {
                        (@($found | ForEach-Object { (Format-SuiteDiagnostic $_) -replace "`r", '' }) +
                            "Lint $(if ($code) { 'failed' } else { 'clean' }): $($files.Count) suite file(s), $($found.Count) finding(s).") -join "`n"
                    }
                } else {
                    $invocation.Tags = ($options.Tags -join ',')
                    $invocation.TestName = $options.TestName
                    $invocation.ResultsFile = $options.Results
                    $invocation.ReportFormat = $(if ($options.Format -eq 'junit') { 'JUnit' } else { 'NUnit3' })
                    $invocation.DryRun = $options.DryRun
                    $invocation.TraceFile = $options.TraceFile
                    $outcome = Invoke-BddSuite @invocation
                    if ($outcome.Error) { throw $outcome.Error }
                    $code = [int]$outcome.ExitCode
                    $lines = [Collections.Generic.List[string]]::new()
                    if ($code -eq 2) {
                        # This runner lints before it runs: a suite the lint
                        # refuses never reaches the system it would act on.
                        $found = @($outcome.Diagnostics | Where-Object { $null -ne $_ })
                        foreach ($finding in $found) { $lines.Add(((Format-SuiteDiagnostic $finding) -replace "`r", '')) }
                        $errors = @($found | Where-Object { $_.severity -eq 'error' }).Count
                        $lines.Add("Lint found $errors error(s) and $($found.Count - $errors) warning(s). Nothing was executed.")
                    } else {
                        foreach ($suite in @($outcome.Suites)) {
                            $lines.Add("=== Suite: $([IO.Path]::GetFileName([string]$suite.file)) ===")
                            foreach ($case in @($suite.tests)) { $lines.Add("  [$(([string]$case.status).PadRight(5))] $($case.name)") }
                        }
                        if ($options.TraceFile) { $lines.Add("Trace written to $($options.TraceFile)") }
                        if ($options.Results) { $lines.Add("Results written to $($options.Results)") }
                        $lines.Add($(if ($code -eq 1) { 'One or more tests failed.' } elseif ($options.DryRun) { 'Suite validation passed; live tests were not run.' } else { 'All selected tests passed.' }))
                    }
                    $text = $lines -join "`n"
                }
            }
        }
    } catch {
        $message = ([string]$_.Exception.Message) -replace 'pass -SchemaRoot\.', 'pass --schema-root.'
        $ErrorOut.Write("suiterun: $message`n")
        $ErrorOut.Flush()
        return 2
    }
    if ($text) {
        $Out.Write("$text`n")
        $Out.Flush()
    }
    return $code
}
