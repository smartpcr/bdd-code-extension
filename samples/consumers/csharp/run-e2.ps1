<#
.SYNOPSIS
    E2 (docs/packages): a C# consumer builds, generates and runs from the
    Smartpcr.BddSuite packages alone.

.DESCRIPTION
    1. Packs the C# runtime into the local NuGet feed (scripts/local-feeds.ps1),
       unless -NoPack.
    2. Checks that nothing in this consumer points into the repository: no
       path to runtimes/, no <Import> of a runtime file.
    3. Restores into a package cache of its own, emptied of any earlier
       Smartpcr.BddSuite package, so the files just packed are the ones used, under
       central package management (no NU1008).
    4. The binding program: lint, list --name, run --name --progress.
    5. Each test framework (MSTest 4, NUnit 4, xUnit v3): every case passes
       but the guarded one, which is not run; with BDD_SUITE_ALLOW_GUARDED=1
       all pass; the smoke tag selects its one case.

    -Upstream names the feed everything else restores from, nuget.org by
    default; a machine that reaches nuget.org only through a mirror passes the
    mirror. The local feed stays the only source of a Smartpcr.BddSuite package.

    -FromRegistry (E11): nothing is packed and there is no local feed; the
    packages restore from -Upstream (nuget.org), and the check is that the
    cached Bdd.Suite says it came from there.

    Exits 0 when every check passes, 1 naming each that failed.

.EXAMPLE
    pwsh -File samples/consumers/csharp/run-e2.ps1
#>
[CmdletBinding()]
param(
    [switch]$NoPack,
    [ValidateSet('MsTest', 'NUnit', 'XUnit')][string[]]$Framework = @('MsTest', 'NUnit', 'XUnit'),
    [string]$Upstream = 'https://api.nuget.org/v3/index.json',
    [switch]$FromRegistry
)
if ($FromRegistry) { $NoPack = $true }

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $here '../../..')).Path
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$failures = [Collections.Generic.List[string]]::new()
function Check([bool]$Ok, [string]$What) {
    if ($Ok) { Write-Output "  ok    $What" } else { Write-Output "  FAIL  $What"; $failures.Add($What) }
}

if (-not $NoPack) {
    & pwsh -NoProfile -File (Join-Path $repo 'scripts/local-feeds.ps1') -Language csharp
    if ($LASTEXITCODE) { throw 'packing the C# runtime failed' }
}

Write-Output "E2: the C# consumer from the packages $version"
$own = Get-ChildItem $here -Recurse -File -Include *.csproj, *.props, *.targets, nuget.config |
    Where-Object { $_.FullName -notmatch '[\\/](artifacts|TestResults)[\\/]' }
$leaks = $own | Select-String -Pattern 'runtimes[\\/]|<Import ' -List
Check (-not $leaks) "no project file points into the repository ($(@($leaks).Path -join ', '))"

# nuget.config with the upstream given: the committed one names nuget.org.
$config = Join-Path $here 'artifacts/nuget.config'
New-Item -ItemType Directory -Force -Path (Split-Path $config) | Out-Null
if ($FromRegistry) {
    # The registry alone, for every package.
    "<?xml version=`"1.0`" encoding=`"utf-8`"?>`n<configuration>`n  <packageSources>`n    <clear />`n    <add key=`"nuget.org`" value=`"$Upstream`" />`n  </packageSources>`n</configuration>`n" |
        Set-Content $config
} else {
    (Get-Content (Join-Path $here 'nuget.config') -Raw).Replace('https://api.nuget.org/v3/index.json', $Upstream).Replace('../../../artifacts/feeds/nuget', (Join-Path $repo 'artifacts/feeds/nuget')) |
        Set-Content $config
}
$restore = "-p:RestoreConfigFile=$config"

$env:NUGET_PACKAGES = Join-Path $here 'artifacts/nuget-packages'
Get-ChildItem $env:NUGET_PACKAGES -Directory -Filter 'smartpcr.bddsuite*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
Push-Location $here
try {
    $built = dotnet build Greeter.Suite.Cli -p:BddSuiteVersion=$version $restore --nologo -v q 2>&1
    Check ($LASTEXITCODE -eq 0) "the binding program restores and builds$(if ($LASTEXITCODE) { ":`n$($built -join "`n")" })"
    $cached = Test-Path (Join-Path $env:NUGET_PACKAGES "smartpcr.bddsuite/$version/lib/net10.0/Bdd.Suite.dll")
    if ($FromRegistry) {
        # NuGet records where each cached package came from.
        $metadata = Join-Path $env:NUGET_PACKAGES "smartpcr.bddsuite/$version/.nupkg.metadata"
        $source = if (Test-Path $metadata) { (Get-Content $metadata -Raw | ConvertFrom-Json).source } else { '' }
        Check ($cached -and $source -eq $Upstream) "Smartpcr.BddSuite $version came from $Upstream into this consumer's cache (its source: $source)"
    } else {
        Check $cached "Smartpcr.BddSuite $version came from the local feed into this consumer's cache"
    }

    $program = Join-Path $here 'artifacts/bin/Greeter.Suite.Cli/Debug/net10.0/suiterun.dll'
    $lint = dotnet $program lint --schema-root schema --path 'suites/*.yml' 2>&1
    Check ($LASTEXITCODE -eq 0) "suiterun lint: both suites lint clean against bdd-suite:core and the greeter's actions ($($lint -join ' '))"
    $list = @(dotnet $program list --schema-root schema --path 'suites/*.yml' --name '*hello' 2>&1)
    Check (($list -join '|') -eq 'greeting.yml  says-hello|loud.yml  shouts-hello') "suiterun list --name '*hello': $($list -join ' | ')"
    $run = @(dotnet $program run --schema-root schema --path 'suites/greeting.yml' --name 'says-*' --progress 2>&1)
    Check ($LASTEXITCODE -eq 0 -and $run -contains 'StartGroup: greeting::says-hello' -and
        $run -contains 'Summary: Total=1, Passed=1, Failed=0, Blocked=0, Not Run=0, Skipped=0') "suiterun run --name --progress: $($run -join ' | ')"

    $tag = @{ MsTest = 'TestCategory=smoke'; NUnit = 'TestCategory=smoke'; XUnit = 'Category=smoke' }
    foreach ($fw in $Framework) {
        $project = "Greeter.Suite.$fw"
        $results = Join-Path $here "artifacts/TestResults/$fw"
        Remove-Item $results -Recurse -Force -ErrorAction SilentlyContinue
        function Test-Run([string]$Name, [string]$Filter, [hashtable]$Env = @{}) {
            foreach ($key in $Env.Keys) { Set-Item "env:$key" $Env[$key] }
            try {
                $arguments = @('test', $project, "-p:BddSuiteVersion=$version", $restore, '--nologo', '--logger', "trx;LogFileName=$Name.trx", '--results-directory', $results)
                if ($Filter) { $arguments += @('--filter', $Filter) }
                $said = dotnet @arguments 2>&1
            } finally {
                foreach ($key in $Env.Keys) { Remove-Item "env:$key" }
            }
            $trx = Join-Path $results "$Name.trx"
            if (-not (Test-Path $trx)) { return @{ Code = $LASTEXITCODE; Rows = @(); Said = $said } }
            [xml]$document = Get-Content $trx -Raw
            $rows = @($document.TestRun.Results.UnitTestResult | ForEach-Object { "$($_.testName)=$($_.outcome)" } | Sort-Object)
            return @{ Code = $LASTEXITCODE; Rows = $rows; Said = $said }
        }

        $plain = Test-Run 'plain'
        Check ($plain.Rows.Count -eq 3 -and ($plain.Rows -join ',') -eq 'says-hello=Passed,shouts-hello=NotExecuted,the-core-still-works=Passed') `
            "$fw generates the tests and runs them; the guarded one is not run: $($plain.Rows -join ', ')$(if (-not $plain.Rows) { "`n$($plain.Said -join "`n")" })"
        $allowed = Test-Run 'allowed' '' @{ BDD_SUITE_ALLOW_GUARDED = '1' }
        Check (($allowed.Rows -join ',') -eq 'says-hello=Passed,shouts-hello=Passed,the-core-still-works=Passed') "$fw with BDD_SUITE_ALLOW_GUARDED=1: $($allowed.Rows -join ', ')"
        $smoke = Test-Run 'smoke' $tag[$fw]
        Check (($smoke.Rows -join ',') -eq 'says-hello=Passed') "$fw --filter $($tag[$fw]): $($smoke.Rows -join ', ')"
    }
} finally {
    Pop-Location
}

if ($failures.Count) {
    Write-Output "E2 failed: $($failures.Count) check(s)."
    exit 1
}
Write-Output 'E2 passed.'
