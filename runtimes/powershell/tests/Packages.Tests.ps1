<#
.SYNOPSIS
    The BddSuite module as a package (docs/packages, K5): what the module
    folder holds, the copies it carries, the entries at their old paths, the
    name filter and the run observer.
.DESCRIPTION
    Pester 5. Publish-PSResource packs the whole module folder, so the folder
    itself must hold exactly what BddSuite.psd1's FileList names; the package's
    own contents are checked by scripts/Test-PackageContents.ps1 (E1).
#>

BeforeAll {
    $script:runtimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $script:repoRoot = [IO.Path]::GetFullPath((Join-Path $script:runtimeRoot '../..'))
    $script:module = Join-Path $script:runtimeRoot 'BddSuite'
    Import-Module powershell-yaml -ErrorAction Stop
    Import-Module (Join-Path $script:module 'BddSuite.psd1') -Force -DisableNameChecking
    $script:corpus = Join-Path $script:repoRoot 'conformance'
    $script:corpusExtension = Join-Path $PSScriptRoot 'CorpusExtension/BddSuite.Corpus.psm1'

    function Read-Text([string]$Path) { (Get-Content -LiteralPath $Path -Raw) -replace "`r`n", "`n" }

    # A corpus suite run through Invoke-BddSuite, its trace returned.
    function Invoke-Corpus([string]$Suite, [hashtable]$More = @{}) {
        $trace = Join-Path $TestDrive "$([guid]::NewGuid().ToString('N')).json"
        $arguments = @{
            Path        = @(Join-Path $script:corpus $Suite)
            SchemaRoot  = Join-Path $script:corpus 'schema'
            Extension   = @($script:corpusExtension)
            ResultsFile = ''
            TraceFile   = $trace
            Json        = $true
        }
        foreach ($key in $More.Keys) { $arguments[$key] = $More[$key] }
        $outcome = Invoke-BddSuite @arguments
        $entries = if (Test-Path -LiteralPath $trace) { @((Get-Content -LiteralPath $trace -Raw) | ConvertFrom-Json -AsHashtable) } else { @() }
        return @{ Outcome = $outcome; Trace = $entries }
    }
}

Describe 'K5.6 the module folder is the package' {
    It 'holds exactly the files BddSuite.psd1 lists in FileList, and nothing else' {
        $manifest = Import-PowerShellDataFile (Join-Path $script:module 'BddSuite.psd1')
        $held = @(Get-ChildItem -LiteralPath $script:module -Recurse -File |
                ForEach-Object { [IO.Path]::GetRelativePath($script:module, $_.FullName) -replace '\\', '/' } | Sort-Object -CaseSensitive)
        $held | Should -Be @($manifest.FileList | Sort-Object -CaseSensitive)
    }

    It 'carries the core catalog as spec/core.catalog.yaml has it, and the repository LICENSE' {
        Read-Text (Join-Path $script:module 'core.catalog.yaml') | Should -BeExactly (Read-Text (Join-Path $script:repoRoot 'spec/core.catalog.yaml'))
        Read-Text (Join-Path $script:module 'LICENSE') | Should -BeExactly (Read-Text (Join-Path $script:repoRoot 'LICENSE'))
    }

    It 'names the version package.json has, the YAML reader it needs, and the Gallery links' {
        $manifest = Import-PowerShellDataFile (Join-Path $script:module 'BddSuite.psd1')
        $version = (Get-Content -LiteralPath (Join-Path $script:repoRoot 'package.json') -Raw | ConvertFrom-Json).version
        $manifest.ModuleVersion | Should -Be $version
        $manifest.RequiredModules[0].ModuleName | Should -Be 'powershell-yaml'
        $manifest.PrivateData.PSData.LicenseUri | Should -Be 'https://github.com/smartpcr/bdd-code-extension/blob/main/LICENSE'
        $manifest.PrivateData.PSData.ProjectUri | Should -BeLike 'https://github.com/smartpcr/bdd-code-extension/*'
    }

    It 'keeps suiterun.ps1 and Invoke-BddSuite.ps1 working at their old paths' {
        $output = & pwsh -NoProfile -File (Join-Path $script:runtimeRoot 'suiterun.ps1') actions --json 2>&1
        $LASTEXITCODE | Should -Be 0
        @(($output -join "`n") | ConvertFrom-Json) | Should -Contain 'core.noop'
        & pwsh -NoProfile -File (Join-Path $script:runtimeRoot 'suiterun.ps1') 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 2
        $suite = Join-Path $script:corpus 'execute/names.yml'
        $output = & pwsh -NoProfile -File (Join-Path $script:runtimeRoot 'Invoke-BddSuite.ps1') -Path $suite -SchemaRoot (Join-Path $script:corpus 'schema') `
            -Extension $script:corpusExtension -Lint 2>&1
        $LASTEXITCODE | Should -Be 0 -Because ($output -join "`n")
    }
}

Describe 'K5.1 the name filter' {
    It 'matches * and ? over the whole name, case-sensitively, and reads brackets as themselves' {
        Test-SuiteNameMatch -Name 'place-an-order' -Pattern @('place-*') | Should -BeTrue
        Test-SuiteNameMatch -Name 'place-an-order' -Pattern @('place') | Should -BeFalse
        Test-SuiteNameMatch -Name 'place-an-order' -Pattern @('Place-*') | Should -BeFalse
        Test-SuiteNameMatch -Name 'row-1' -Pattern @('row-?') | Should -BeTrue
        Test-SuiteNameMatch -Name 'row [eu, 1]' -Pattern @('row [eu, ?]') | Should -BeTrue
        Test-SuiteNameMatch -Name 'row e' -Pattern @('row [eu]') | Should -BeFalse
        Test-SuiteNameMatch -Name 'b' -Pattern @('a', 'b') | Should -BeTrue
        Test-SuiteNameMatch -Name 'anything' -Pattern @() | Should -BeTrue
    }

    It 'selects the cases a glob matches and traces the others as skipped' {
        $run = Invoke-Corpus 'execute/names.yml' @{ Name = @('*-an-order', 'order-?') }
        @($run.Trace | Where-Object { $_.phase -eq 'case' -and $_.status -ne 'skipped' } | ForEach-Object { $_.case }) |
            Should -Be @('place-an-order', 'cancel-an-order', 'order-1')
    }
}

Describe 'K5.2 the run observer' {
    It 'sees each selected case start and finish and every trace entry, and changes nothing' {
        $plain = Invoke-Corpus 'execute/names-and-tags.yml'
        $heard = [Collections.Generic.List[string]]::new()
        $observer = @{
            CaseStarted  = { param($Suite, $CaseName) $heard.Add("start $CaseName") }.GetNewClosure()
            CaseFinished = { param($Suite, $Result) $heard.Add("end $($Result.name) $($Result.status)") }.GetNewClosure()
            Entry        = { param($Entry) $heard.Add("entry $($Entry.phase)") }.GetNewClosure()
        }
        $watched = Invoke-Corpus 'execute/names-and-tags.yml' @{ Observer = $observer }
        ($watched.Trace | ForEach-Object { "$($_.phase)|$($_.case)|$($_.step)|$($_.status)" }) |
            Should -Be @($plain.Trace | ForEach-Object { "$($_.phase)|$($_.case)|$($_.step)|$($_.status)" })
        @($heard | Where-Object { $_ -like 'entry *' }).Count | Should -Be $watched.Trace.Count
        @($heard | Where-Object { $_ -like 'start *' }).Count | Should -Be @($heard | Where-Object { $_ -like 'end *' }).Count
    }

    It 'hears nothing in a dry run' {
        $heard = [Collections.Generic.List[string]]::new()
        $observer = @{
            CaseStarted  = { param($Suite, $CaseName) $heard.Add($CaseName) }.GetNewClosure()
            CaseFinished = { param($Suite, $Result) $heard.Add($Result.name) }.GetNewClosure()
            Entry        = { param($Entry) $heard.Add($Entry.phase) }.GetNewClosure()
        }
        $null = Invoke-Corpus 'execute/names.yml' @{ Observer = $observer; DryRun = $true }
        $heard.Count | Should -Be 0
    }

    It 'prints progress to the writer it is given, and to standard output again after' {
        $printed = [Collections.Generic.List[string]]::new()
        $standard = Set-BddSuiteProgressWriter -Writer { param([string]$Line) $printed.Add($Line) }.GetNewClosure()
        try { $null = Invoke-Corpus 'execute/progress.yml' @{ Progress = $true } } finally { $null = Set-BddSuiteProgressWriter -Writer $standard }
        $printed[0] | Should -Match '^(StartGroup: |    suite-setup )'
        $printed[$printed.Count - 1] | Should -Match '^Summary: Total=\d+, Passed=\d+, Failed=\d+, Blocked=0, Not Run=0, Skipped=\d+$'
        $before = Set-BddSuiteProgressWriter
        try { $before | Should -Be $standard } finally { $null = Set-BddSuiteProgressWriter -Writer $before }
    }
}
