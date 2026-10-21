<#
.SYNOPSIS
    E6 (docs/packages): a PowerShell consumer installs the BddSuite module from
    a PSResource repository and runs from it alone.

.DESCRIPTION
    1. Publishes BddSuite, with the powershell-yaml it requires, into the local
       file repository (scripts/local-feeds.ps1 -Language powershell), unless
       -NoPack.
    2. Checks this consumer's suiterun.ps1 requires the release version and no
       file of the consumer names a path into the repository.
    3. Save-PSResource installs BddSuite from that repository into
       artifacts/e6/modules, a module path of this run's own (Install-PSResource
       would install into the user's), with its dependency; the consumer is
       copied to artifacts/e6/work.
    4. With PSModulePath leading to that folder, the module imported by name is
       the release version from there, not runtimes/.
    5. Its suiterun.ps1: lint, list --name, run --name --progress.
    6. suiterun.ps1 generate writes the Pester tests from bddsuite.tests.yaml;
       Invoke-Pester: every case passes but the guarded one, which skips; all
       pass with BDD_SUITE_ALLOW_GUARDED=1; a full-name filter selects one case.

    -FromRegistry (E11): no local repository; Save-PSResource takes BddSuite
    and powershell-yaml from the PowerShell Gallery.

    Exits 0 when every check passes, 1 naming each that failed.

.EXAMPLE
    pwsh -File samples/consumers/powershell/run-e6.ps1
#>
[CmdletBinding()]
param([switch]$NoPack, [switch]$FromRegistry)
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
    & pwsh -NoProfile -File (Join-Path $repo 'scripts/local-feeds.ps1') -Language powershell
    if ($LASTEXITCODE) { throw 'publishing the BddSuite module to the local repository failed' }
}
$feed = Join-Path $repo 'artifacts/feeds/psresource'

Write-Output "E6: the PowerShell consumer from the BddSuite module $version"
$own = @(Get-ChildItem $here -Recurse -File | Where-Object { $_.FullName -notlike (Join-Path $here 'artifacts*') -and $_.FullName -notlike (Join-Path $here 'tests*') })
Check ((Get-Content (Join-Path $here 'suiterun.ps1') -Raw) -match "ModuleName = 'BddSuite'; RequiredVersion = '$([regex]::Escape($version))'") "suiterun.ps1 requires BddSuite $version"
$naming = @($own | Where-Object { $_.Name -ne 'run-e6.ps1' -and (Get-Content $_.FullName -Raw) -match 'runtimes[\\/]powershell' })
Check (-not $naming.Count) "no file of the consumer names a path into the repository$(if ($naming) { ": $($naming.Name -join ', ')" })"

$scratch = Join-Path $here 'artifacts/e6'
$work = Join-Path $scratch 'work'
$modules = Join-Path $scratch 'modules'
Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work, $modules | Out-Null
Get-ChildItem $here -Force | Where-Object { $_.Name -notin 'artifacts', 'tests' } | Copy-Item -Destination $work -Recurse

if ($FromRegistry) {
    # The PowerShell Gallery, BddSuite and the powershell-yaml it requires.
    Save-PSResource -Name BddSuite -Version $version -Repository PSGallery -Path $modules -TrustRepository -Quiet
} else {
    $name = 'bdd-suite-e6-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    Register-PSResourceRepository -Name $name -Uri $feed -Trusted
    try {
        Save-PSResource -Name BddSuite -Version $version -Repository $name -Path $modules -TrustRepository -Quiet
    } finally {
        Unregister-PSResourceRepository -Name $name
    }
}
Check ((Test-Path (Join-Path $modules "BddSuite/$version/BddSuite.psd1")) -and (Test-Path (Join-Path $modules 'powershell-yaml'))) "Save-PSResource installs BddSuite $version and powershell-yaml from the repository"

# Every pwsh below finds modules in this run's folder first.
$path = $env:PSModulePath
$env:PSModulePath = $modules + [IO.Path]::PathSeparator + (Join-Path $PSHOME 'Modules')
Push-Location $work
try {
    $found = pwsh -NoProfile -Command 'Import-Module BddSuite -DisableNameChecking; $m = Get-Module BddSuite; "$($m.Version)|$($m.ModuleBase)"' 2>&1
    $foundVersion, $foundBase = "$found" -split '\|', 2
    Check ($foundVersion -eq $version -and $foundBase -and ([IO.Path]::GetFullPath($foundBase)).StartsWith([IO.Path]::GetFullPath($modules))) "Import-Module BddSuite by name is $foundVersion from $foundBase"

    $lint = pwsh -NoProfile -File suiterun.ps1 lint --schema-root schema --path 'suites/*.yml' 2>&1
    Check ($LASTEXITCODE -eq 0) "suiterun lint: both suites lint clean against bdd-suite:core and the greeter's actions ($($lint -join ' '))"
    $list = @(pwsh -NoProfile -File suiterun.ps1 list --schema-root schema --path 'suites/*.yml' --name '*hello' 2>&1 | Where-Object { "$_".Trim() })
    Check (($list -join '|') -match 'greeting\.yml\s+says-hello\|.*loud\.yml\s+shouts-hello' -and ($list -join '|') -notmatch 'the-core-still-works') "suiterun list --name '*hello': $($list -join ' | ')"
    $run = @(pwsh -NoProfile -File suiterun.ps1 run --schema-root schema --path 'suites/greeting.yml' --name 'says-*' --progress --results '' 2>&1)
    Check ($LASTEXITCODE -eq 0 -and $run -contains 'StartGroup: greeting::says-hello' -and
        $run -contains 'Summary: Total=1, Passed=1, Failed=0, Blocked=0, Not Run=0, Skipped=0') "suiterun run --name --progress: $($run -join ' | ')"

    $generated = pwsh -NoProfile -File suiterun.ps1 generate --config bddsuite.tests.yaml --out tests 2>&1
    Check ($LASTEXITCODE -eq 0 -and (Test-Path 'tests/Greeting.Bdd.Tests.ps1') -and (Test-Path 'tests/Loud.Bdd.Tests.ps1')) "suiterun generate writes the Pester tests ($($generated -join ' '))"

    function Test-Run([string]$Filter = '', [hashtable]$Env = @{}) {
        foreach ($key in $Env.Keys) { Set-Item "env:$key" $Env[$key] }
        try {
            $script = 'Import-Module Pester -MinimumVersion 5.0; $c = New-PesterConfiguration; $c.Run.Path = "tests"; $c.Run.PassThru = $true; $c.Output.Verbosity = "None"; ' +
                $(if ($Filter) { "`$c.Filter.FullName = '$Filter'; " } else { '' }) +
                '$r = Invoke-Pester -Configuration $c; foreach ($t in $r.Tests) { if ($t.ShouldRun) { "$($t.Path -join " > ")=$($t.Result)" } }'
            # Pester is the machine's: the run's own module path leads, and Pester comes after it.
            $env:PSModulePath = $modules + [IO.Path]::PathSeparator + $path
            return @(pwsh -NoProfile -Command $script 2>&1 | ForEach-Object { "$_" } | Sort-Object)
        } finally {
            $env:PSModulePath = $modules + [IO.Path]::PathSeparator + (Join-Path $PSHOME 'Modules')
            foreach ($key in $Env.Keys) { Remove-Item "env:$key" }
        }
    }
    $plain = Test-Run
    Check (($plain -join ',') -eq 'greeting > says-hello=Passed,greeting > the-core-still-works=Passed,loud > shouts-hello=Skipped') "Invoke-Pester: the guarded case skips: $($plain -join ', ')"
    $allowed = Test-Run -Env @{ BDD_SUITE_ALLOW_GUARDED = '1' }
    Check (($allowed -join ',') -eq 'greeting > says-hello=Passed,greeting > the-core-still-works=Passed,loud > shouts-hello=Passed') "Invoke-Pester with BDD_SUITE_ALLOW_GUARDED=1: $($allowed -join ', ')"
    $one = Test-Run -Filter '*says-hello'
    Check (($one -join ',') -eq 'greeting > says-hello=Passed') "Invoke-Pester -FullNameFilter '*says-hello': $($one -join ', ')"
} finally {
    Pop-Location
    $env:PSModulePath = $path
}

if ($failures.Count) {
    Write-Output "E6 failed: $($failures.Count) check(s)."
    exit 1
}
Write-Output 'E6 passed.'
