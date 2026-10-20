<#
.SYNOPSIS
    suiterun generate for PowerShell (spec/test-plan.md): identifiers, the
    guard, the config's checks, globs, the Pester template against its golden
    files (tests/golden/pester; BDD_UPDATE_GOLDEN=1 writes them), the writer
    and -Check, and the command line's generate flags.
#>

BeforeAll {
    $script:runtimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $script:corpusRoot = [IO.Path]::GetFullPath((Join-Path $script:runtimeRoot '../../conformance'))
    $script:corpusConfig = Join-Path $script:corpusRoot 'generate/bddsuite.tests.yaml'
    Import-Module powershell-yaml -ErrorAction Stop
    Import-Module (Join-Path $script:runtimeRoot 'BddSuite/BddSuite.psd1') -Force -DisableNameChecking
}

Describe 'the test plan' {
    It 'gives each name its identifier, and a collision the first free number ignoring case' {
        $cases = @{
            'places an order' = 'PlacesAnOrder'; 'rejects a bad quantity [qty=-1]' = 'RejectsABadQuantityQty1'; '3 retries' = 'N3Retries'
            '!!!' = 'Case'; 'café au lait' = 'CafAuLait'; 'MSTest_v4' = 'MSTestV4'
        }
        foreach ($name in $cases.Keys) { Get-BddSuiteIdentifier -Name $name -Fallback 'Case' | Should -BeExactly $cases[$name] -Because $name }
        $plan = (Get-BddSuitePlan -Config (Read-BddSuiteTestsConfig -Path $script:corpusConfig)).Plan
        $orders = $plan.Suites | Where-Object { $_.name -eq 'orders' }
        @($orders.cases | ForEach-Object { $_.id }) | Should -Be @('PlacesAnOrder', 'RejectsABadQuantityQty1', 'RejectsABadQuantityQty1_2', 'RejectsABadQuantityQty0', 'Setup_2', 'N3Retries', 'Case', 'CafAuLait', 'PlacesAnOrder_2', 'PLACESANORDER_3')
        @($plan.Suites | ForEach-Object { $_.id }) | Should -Be @('Orders', 'Billing', 'Billing_2', 'LabWork', 'N3DPrinting')
    }

    It 'guards a suite through an imported meta step and a polled step, and covers a name or a prefix' {
        $plan = (Get-BddSuitePlan -Config (Read-BddSuiteTestsConfig -Path $script:corpusConfig)).Plan
        foreach ($suite in $plan.Suites) {
            $suite.guarded | Should -Be ($suite.name -eq 'lab-work') -Because $suite.name
            if ($suite.guarded) { $suite.guardedBy | Should -Be @('fixture.state', 'inventory.get') }
        }
        Test-BddSuiteOfflineAction -Pattern 'core.*' -Action 'core.set' | Should -BeTrue
        Test-BddSuiteOfflineAction -Pattern 'core.*' -Action 'corelike.set' | Should -BeFalse
        Test-BddSuiteOfflineAction -Pattern 'wait' -Action 'waiting' | Should -BeFalse
    }

    It 'refuses a config the schema refuses' {
        $cases = [ordered]@{
            'schemaRoot: s' = 'suites is required'; 'suites: [a.yml]' = 'schemaRoot is required'; "suites: []`nschemaRoot: s" = 'suites names no glob'
            "suites: [a.yml]`nschemaRoot: s`nprovidr: go" = 'providr is not a config key'; "suites: [a.yml]`nschemaRoot: s`nprovider: junit" = 'provider is one of'
            "suites: ['a\b.yml']`nschemaRoot: s" = 'backslash'; "suites: [a.yml]`nschemaRoot: s`nofflineActions: ['core.*.x']" = 'prefix.*'
            "suites: [a.yml]`nschemaRoot: s`noutput: { dir: x }" = 'output.dir is not an output key'; "suites: [a.yml]`nschemaRoot: s`noutput: x" = 'output is a mapping'
            "suites: [1]`nschemaRoot: s" = 'list of non-empty strings'; '- a' = 'YAML mapping'; 'suites: [a.yml' = 'not valid YAML'
        }
        $file = Join-Path $TestDrive 'config.yaml'
        foreach ($yaml in $cases.Keys) {
            Set-Content -LiteralPath $file -Value $yaml
            { Read-BddSuiteTestsConfig -Path $file } | Should -Throw "*$($cases[$yaml])*" -Because $yaml
        }
        { Read-BddSuiteTestsConfig -Path (Join-Path $TestDrive 'missing.yaml') } | Should -Throw '*cannot be read*'
    }

    It 'selects by ** * and ?, and an exclude wins' {
        foreach ($f in 'a/x.yml', 'a/b/y.yml', 'a/b/c/z.yml', 'a/q1.yml', 'a/skip/s.yml') {
            $path = Join-Path $TestDrive "globs/$f"
            $null = New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force
            Set-Content -LiteralPath $path -Value ''
        }
        $root = Join-Path $TestDrive 'globs'
        Select-BddSuiteFile -Folder $root -Include 'a/**/*.yml' -Exclude 'a/skip/**' | Should -Be @('a/b/c/z.yml', 'a/b/y.yml', 'a/q1.yml', 'a/x.yml')
        Select-BddSuiteFile -Folder $root -Include 'a/q?.yml', 'a/b**' | Should -Be @('a/b/c/z.yml', 'a/b/y.yml', 'a/q1.yml')
        @(Select-BddSuiteFile -Folder $root -Include 'nowhere/*.yml').Count | Should -Be 0
    }
}

Describe 'the Pester tests' {
    It 'equals the golden files for the generate corpus' {
        $plan = (Get-BddSuitePlan -Config (Read-BddSuiteTestsConfig -Path $script:corpusConfig)).Plan
        $files = @(ConvertTo-BddSuitePesterFile -Plans @($plan) -Folder (Join-Path $script:corpusRoot 'generate/generated'))
        $golden = Join-Path $PSScriptRoot 'golden/pester'
        if ($env:BDD_UPDATE_GOLDEN -eq '1') {
            Remove-Item -LiteralPath $golden -Recurse -Force -ErrorAction SilentlyContinue
            $null = New-Item -ItemType Directory -Path $golden -Force
            foreach ($f in $files) { [IO.File]::WriteAllText((Join-Path $golden "$($f.Name).golden"), $f.Text, [Text.UTF8Encoding]::new($false)) }
        }
        @(Get-ChildItem -LiteralPath $golden -File | ForEach-Object { $_.Name } | Sort-Object) | Should -Be @($files | ForEach-Object { "$($_.Name).golden" } | Sort-Object)
        foreach ($f in $files) {
            $want = [IO.File]::ReadAllText((Join-Path $golden "$($f.Name).golden")) -replace "`r`n", "`n"
            $f.Text | Should -BeExactly $want -Because $f.Name
        }
        # < and > are a template in a Pester name, so the generated name escapes them.
        $text = ($files | Where-Object { $_.Name -eq 'Orders.Bdd.Tests.ps1' }).Text
        $text | Should -Match ([regex]::Escape("It 'rejects a bad quantity [qty=1]' -Tag 'shop', 'smoke' {"))
        ConvertTo-BddSuitePesterText -Text "a <b> c's" -Name | Should -BeExactly "'a ``<b``> c''s'"
    }

    It 'rewrites only what changed, removes only its own files, and -Check names what is stale' {
        $plan = (Get-BddSuitePlan -Config (Read-BddSuiteTestsConfig -Path $script:corpusConfig)).Plan
        $folder = Join-Path $TestDrive 'out'
        $files = @(ConvertTo-BddSuitePesterFile -Plans @($plan) -Folder $folder)
        (Write-BddSuiteGeneratedFile -Folder $folder -File $files -Check).Stale.Count | Should -Be $files.Count
        (Write-BddSuiteGeneratedFile -Folder $folder -File $files).Written.Count | Should -Be $files.Count
        $again = Write-BddSuiteGeneratedFile -Folder $folder -File $files
        $again.Written.Count + $again.Removed.Count | Should -Be 0
        Set-Content -LiteralPath (Join-Path $folder 'Gone.Bdd.Tests.ps1') -Value '# Code generated by suiterun generate (pester) from gone.yml. DO NOT EDIT.'
        Set-Content -LiteralPath (Join-Path $folder 'Mine.Bdd.Tests.ps1') -Value '# mine'
        Add-Content -LiteralPath (Join-Path $folder $files[0].Name) -Value '# edited'
        @((Write-BddSuiteGeneratedFile -Folder $folder -File $files -Check).Stale) | Should -Be @($files[0].Name, 'Gone.Bdd.Tests.ps1')
        $fixed = Write-BddSuiteGeneratedFile -Folder $folder -File $files
        @($fixed.Written) | Should -Be @($files[0].Name)
        @($fixed.Removed) | Should -Be @('Gone.Bdd.Tests.ps1')
        Test-Path -LiteralPath (Join-Path $folder 'Mine.Bdd.Tests.ps1') | Should -BeTrue
    }

    It 'generate refuses what it cannot do, and says what it wrote' {
        $broken = Invoke-BddSuiteGenerate -Config (Join-Path $script:corpusRoot 'generate/invalid/bddsuite.tests.yaml')
        $broken.Code | Should -Be 2
        $broken.Errors | Should -Match 'suites/b-broken.yml:8:17\s+E104[\s\S]*Nothing was generated'
        (Invoke-BddSuiteGenerate -Config $script:corpusConfig, $script:corpusConfig -Plan).Errors | Should -Match "one config's plan"
        (Invoke-BddSuiteGenerate -Config $script:corpusConfig -Out (Join-Path $TestDrive 'g')).Errors | Should -Match 'mstest is not a PowerShell provider'
        (Invoke-BddSuiteGenerate -Config (Join-Path $TestDrive 'none.yaml')).Errors | Should -Match 'cannot be read'
        $out = Join-Path $TestDrive 'g'
        $wrote = Invoke-BddSuiteGenerate -Config $script:corpusConfig -Provider pester -Out $out
        $wrote.Code | Should -Be 0
        $wrote.Out | Should -Match 'wrote Orders\.Bdd\.Tests\.ps1[\s\S]*pester: 5 suite\(s\), 14 test\(s\)'
        (Invoke-BddSuiteGenerate -Config $script:corpusConfig -Provider pester -Out $out -Check).Out | Should -Match '5 generated file\(s\) are up to date'
        Remove-Item -LiteralPath (Join-Path $out 'Orders.Bdd.Tests.ps1')
        $stale = Invoke-BddSuiteGenerate -Config $script:corpusConfig -Provider pester -Out $out -Check
        $stale.Code | Should -Be 1
        ($stale.Out -split "`n")[0] | Should -Be 'stale: Orders.Bdd.Tests.ps1'
    }

    It 'the command line takes generate''s flags for generate alone' {
        $o = ConvertFrom-BddSuiteCliArgument -Arguments @('generate', '--config', 'a.yaml', '--config', 'b.yaml', '--plan', '--check', '--provider', 'pester', '--out', 'gen')
        @($o.Configs) | Should -Be @('a.yaml', 'b.yaml')
        $o.Plan, $o.Check, $o.Provider, $o.Out | Should -Be @($true, $true, 'pester', 'gen')
        { ConvertFrom-BddSuiteCliArgument -Arguments @('generate', '--plan') } | Should -Throw '*generate needs --config*'
        { ConvertFrom-BddSuiteCliArgument -Arguments @('generate', '--config', 'a.yaml', '--path', 'x') } | Should -Throw '*generate does not take --path*'
        { ConvertFrom-BddSuiteCliArgument -Arguments @('run', '--path', 'a.yml', '--config', 'c.yaml') } | Should -Throw '*run does not take --config*'
        $out = [IO.StringWriter]::new(); $err = [IO.StringWriter]::new()
        Invoke-BddSuiteCli -Arguments @('generate', '--config', $script:corpusConfig, '--plan') -Out $out -ErrorOut $err | Should -Be 0
        ($out.ToString() | ConvertFrom-Json).planVersion | Should -Be 1
        $err2 = [IO.StringWriter]::new()
        Invoke-BddSuiteCli -Arguments @('generate', '--config', (Join-Path $script:corpusRoot 'generate/invalid/bddsuite.tests.yaml'), '--plan') -Out ([IO.StringWriter]::new()) -ErrorOut $err2 | Should -Be 2
        $err2.ToString() | Should -Match '^suiterun: suites/b-broken.yml:8:17'
    }
}
