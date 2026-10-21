<#
.SYNOPSIS
    E5 (docs/packages): a TypeScript consumer installs the runtime's tarball
    and runs from it alone.

.DESCRIPTION
    1. Packs @bdd-suite/runtime into the local feed (scripts/local-feeds.ps1
       -Language typescript), unless -NoPack.
    2. Checks this consumer's package.json asks for the release version and
       names no path into the repository.
    3. Copies the consumer to artifacts/e5/work and installs the tarball there
       (the package is not on a registry yet), so node_modules holds the
       packed files, not a link to runtimes/.
    4. suiterun generate writes the tests from bddsuite.tests.yaml.
    5. Its suiterun: lint, list --name, run --name --progress.
    6. node --test with the runtime's JUnit reporter: every case passes but the
       guarded one, which skips; all pass with BDD_SUITE_ALLOW_GUARDED=1; a
       name pattern selects one case.

    -FromRegistry (E11): no tarball; @bdd-suite/runtime at the release version
    from npmjs.com, which the lock file then names.

    Exits 0 when every check passes, 1 naming each that failed.

.EXAMPLE
    pwsh -File samples/consumers/typescript/run-e5.ps1
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
    & pwsh -NoProfile -File (Join-Path $repo 'scripts/local-feeds.ps1') -Language typescript
    if ($LASTEXITCODE) { throw 'packing the TypeScript runtime failed' }
}
$tarball = Join-Path $repo "artifacts/feeds/npm/bdd-suite-runtime-$version.tgz"

Write-Output "E5: the TypeScript consumer from @bdd-suite/runtime $version"
$manifest = Get-Content (Join-Path $here 'package.json') -Raw | ConvertFrom-Json
Check ($manifest.devDependencies.'@bdd-suite/runtime' -eq $version) "package.json asks for @bdd-suite/runtime $version"
Check ((Get-Content (Join-Path $here 'package.json') -Raw) -notmatch 'file:|runtimes/') 'package.json names no path into the repository'

$scratch = Join-Path $here 'artifacts/e5'
$work = Join-Path $scratch 'work'
Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work | Out-Null
Get-ChildItem $here -Force | Where-Object { $_.Name -notin 'artifacts', 'node_modules', 'tests', 'package-lock.json' } | Copy-Item -Destination $work -Recurse

Push-Location $work
try {
    if ($FromRegistry) {
        # npmjs.com by name: a machine's own npm configuration may name a mirror.
        $installed = npm install --no-audit --no-fund --save-dev "@bdd-suite/runtime@$version" --registry https://registry.npmjs.org/ 2>&1
        Check ($LASTEXITCODE -eq 0) "npm install of @bdd-suite/runtime@$version from npmjs.com$(if ($LASTEXITCODE) { ":`n$($installed -join "`n")" })"
        # A hashtable: the lock's root package is the key "".
        $resolved = (Get-Content 'package-lock.json' -Raw | ConvertFrom-Json -AsHashtable).packages['node_modules/@bdd-suite/runtime'].resolved
        Check ("$resolved" -like 'https://registry.npmjs.org/@bdd-suite/runtime/-/runtime-*.tgz') "the lock resolves it from npmjs.com ($resolved)"
    } else {
        $installed = npm install --no-audit --no-fund --save-dev $tarball 2>&1
        Check ($LASTEXITCODE -eq 0) "npm install of the tarball$(if ($LASTEXITCODE) { ":`n$($installed -join "`n")" })"
    }
    $runtime = Get-Item 'node_modules/@bdd-suite/runtime'
    $packed = Get-Content 'node_modules/@bdd-suite/runtime/package.json' -Raw | ConvertFrom-Json
    Check ($packed.version -eq $version -and -not $runtime.LinkType -and -not (Test-Path 'node_modules/@bdd-suite/runtime/src')) "node_modules holds the packed @bdd-suite/runtime $($packed.version), not a link to the repository"

    $generated = npx --no-install suiterun generate --config bddsuite.tests.yaml --out tests 2>&1
    Check ($LASTEXITCODE -eq 0 -and (Test-Path 'tests/Greeting.bdd.test.ts') -and (Test-Path 'tests/Loud.bdd.test.ts')) "suiterun generate writes the tests ($($generated -join ' '))"

    $program = 'bin/suiterun.mjs'
    $lint = node $program lint --schema-root schema --path 'suites/*.yml' 2>&1
    Check ($LASTEXITCODE -eq 0) "suiterun lint: both suites lint clean against bdd-suite:core and the greeter's actions ($($lint -join ' '))"
    $list = @(node $program list --schema-root schema --path 'suites/*.yml' --name '*hello' 2>&1)
    Check (($list -join '|') -eq 'greeting.yml  says-hello|loud.yml  shouts-hello') "suiterun list --name '*hello': $($list -join ' | ')"
    $run = @(node $program run --schema-root schema --path 'suites/greeting.yml' --name 'says-*' --progress 2>&1)
    Check ($LASTEXITCODE -eq 0 -and $run -contains 'StartGroup: greeting::says-hello' -and
        $run -contains 'Summary: Total=1, Passed=1, Failed=0, Blocked=0, Not Run=0, Skipped=0') "suiterun run --name --progress: $($run -join ' | ')"

    function Test-Run([string]$Name, [string[]]$Extra, [hashtable]$Env = @{}) {
        $junit = Join-Path $scratch "$Name.xml"
        foreach ($key in $Env.Keys) { Set-Item "env:$key" $Env[$key] }
        try {
            node --test --test-reporter=@bdd-suite/runtime/testing/node-reporter "--test-reporter-destination=$junit" @Extra 'tests/*.bdd.test.ts' 2>&1 | Out-Null
        } finally {
            foreach ($key in $Env.Keys) { Remove-Item "env:$key" }
        }
        if (-not (Test-Path $junit)) { return @() }
        [xml]$document = Get-Content $junit -Raw
        return @($document.testsuites.testcase | Where-Object { $_.classname } | ForEach-Object {
                $outcome = if ($_.failure) { 'failed' } elseif ($null -ne $_.skipped) { 'skipped' } else { 'passed' }
                "$($_.classname) > $($_.name)=$outcome" } | Sort-Object)
    }
    $plain = Test-Run 'plain' @()
    Check (($plain -join ',') -eq 'greeting > says-hello=passed,greeting > the-core-still-works=passed,loud > shouts-hello=skipped') "node --test: the guarded case skips: $($plain -join ', ')"
    $allowed = Test-Run 'allowed' @() @{ BDD_SUITE_ALLOW_GUARDED = '1' }
    Check (($allowed -join ',') -eq 'greeting > says-hello=passed,greeting > the-core-still-works=passed,loud > shouts-hello=passed') "node --test with BDD_SUITE_ALLOW_GUARDED=1: $($allowed -join ', ')"
    $one = Test-Run 'one' @('--test-name-pattern=says-hello')
    Check (($one | Where-Object { $_ -like '*=passed' }) -join ',' -eq 'greeting > says-hello=passed') "node --test --test-name-pattern=says-hello: $($one -join ', ')"
} finally {
    Pop-Location
}

if ($failures.Count) {
    Write-Output "E5 failed: $($failures.Count) check(s)."
    exit 1
}
Write-Output 'E5 passed.'
