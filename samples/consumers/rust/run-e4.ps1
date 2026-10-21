<#
.SYNOPSIS
    E4 (docs/packages): a Rust consumer builds and tests from the packaged
    crate alone.

.DESCRIPTION
    1. Packs the crate into the local feed (scripts/local-feeds.ps1 -Language
       rust), which also unpacks it there, unless -NoPack.
    2. Checks this consumer's Cargo.toml asks for suiterun by version, with no
       path anywhere.
    3. Copies the consumer to artifacts/e4/work and builds it there with
       [patch.crates-io] naming the unpacked crate, so the files cargo package
       produced are the ones compiled (the crate is not on crates.io yet; a
       directory registry would have to vendor every dependency too). cargo
       metadata proves which suiterun it used.
    4. Its suiterun: lint, list --name, run --name --progress.
    5. cargo test: every case passes but the guarded one, which is ignored; all
       pass with BDD_SUITE_ALLOW_GUARDED=1; --exact selects one case.

    -FromRegistry (E11): no local feed and no patch; suiterun comes from
    crates.io, and cargo metadata proves it.

    Exits 0 when every check passes, 1 naming each that failed.

.EXAMPLE
    pwsh -File samples/consumers/rust/run-e4.ps1
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
    & pwsh -NoProfile -File (Join-Path $repo 'scripts/local-feeds.ps1') -Language rust
    if ($LASTEXITCODE) { throw 'packing the crate failed' }
}
$unpacked = Join-Path $repo "artifacts/feeds/cargo/suiterun-$version"

Write-Output "E4: the Rust consumer from the crate suiterun $version"
$manifest = Get-Content (Join-Path $here 'Cargo.toml') -Raw
Check (([regex]::Matches($manifest, "(?m)^suiterun = \{ version = `"$([regex]::Escape($version))`"")).Count -eq 2) "Cargo.toml asks for suiterun $version, as a dependency and a build-dependency"
Check ($manifest -notmatch '\bpath\s*=\s*"\.\.') 'Cargo.toml names no path into the repository'

$scratch = Join-Path $here 'artifacts/e4'
$work = Join-Path $scratch 'work'
Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $work '.cargo') | Out-Null
Get-ChildItem $here -Force | Where-Object { $_.Name -notin 'artifacts', 'target', 'Cargo.lock' } | Copy-Item -Destination $work -Recurse
if (-not $FromRegistry) {
    @"
# Written by run-e4.ps1: the crate cargo package produced, in place of crates.io's.
[patch.crates-io]
suiterun = { path = '$($unpacked -replace '\\', '/')' }
"@ | Set-Content (Join-Path $work '.cargo/config.toml')
}

$saved = $env:CARGO_TARGET_DIR
$env:CARGO_TARGET_DIR = Join-Path $scratch 'target'
Push-Location $work
try {
    $built = cargo build --quiet 2>&1
    Check ($LASTEXITCODE -eq 0) "cargo build$(if ($LASTEXITCODE) { ":`n$($built -join "`n")" })"
    $metadata = cargo metadata --format-version 1 --quiet | ConvertFrom-Json
    $used = $metadata.packages | Where-Object { $_.name -eq 'suiterun' }
    $from = [IO.Path]::GetFullPath((Split-Path $used.manifest_path))
    if ($FromRegistry) {
        # crates.io's sparse index, or its git index on an older cargo.
        Check ($used.version -eq $version -and $used.source -match '^(sparse\+https://index\.crates\.io/|registry\+https://github\.com/rust-lang/crates\.io-index)') "suiterun $($used.version) came from crates.io ($($used.source))"
    } else {
        Check ($used.version -eq $version -and $from -eq [IO.Path]::GetFullPath($unpacked)) "suiterun $($used.version) is the packaged crate ($from)"
    }

    $program = Join-Path $env:CARGO_TARGET_DIR 'debug/suiterun'
    $lint = & $program lint --schema-root schema --path 'suites/*.yml' 2>&1
    Check ($LASTEXITCODE -eq 0) "suiterun lint: both suites lint clean against bdd-suite:core and the greeter's actions ($($lint -join ' '))"
    $list = @(& $program list --schema-root schema --path 'suites/*.yml' --name '*hello' 2>&1)
    Check (($list -join '|') -eq 'greeting.yml  says-hello|loud.yml  shouts-hello') "suiterun list --name '*hello': $($list -join ' | ')"
    $run = @(& $program run --schema-root schema --path 'suites/greeting.yml' --name 'says-*' --progress 2>&1)
    Check ($LASTEXITCODE -eq 0 -and $run -contains 'StartGroup: greeting::says-hello' -and
        $run -contains 'Summary: Total=1, Passed=1, Failed=0, Blocked=0, Not Run=0, Skipped=0') "suiterun run --name --progress: $($run -join ' | ')"

    function Test-Run([string[]]$Extra, [hashtable]$Env = @{}) {
        foreach ($key in $Env.Keys) { Set-Item "env:$key" $Env[$key] }
        try { $said = cargo test --quiet --test suites -- @Extra 2>&1 } finally { foreach ($key in $Env.Keys) { Remove-Item "env:$key" } }
        return @($said | Select-String '^test (\S+::\S+) +\.\.\. (ok|FAILED|ignored)' |
            Where-Object { $_.Matches[0].Groups[1].Value -notlike '*::teardown' } |
            ForEach-Object { "$($_.Matches[0].Groups[1].Value)=$($_.Matches[0].Groups[2].Value)" } | Sort-Object)
    }
    $plain = Test-Run @('--format', 'pretty')
    Check (($plain -join ',') -eq 'Greeting::says-hello=ok,Greeting::the-core-still-works=ok,Loud::shouts-hello=ignored') "cargo test: the guarded case is ignored: $($plain -join ', ')"
    $allowed = Test-Run @('--format', 'pretty') @{ BDD_SUITE_ALLOW_GUARDED = '1' }
    Check (($allowed -join ',') -eq 'Greeting::says-hello=ok,Greeting::the-core-still-works=ok,Loud::shouts-hello=ok') "cargo test with BDD_SUITE_ALLOW_GUARDED=1: $($allowed -join ', ')"
    $one = Test-Run @('--format', 'pretty', '--exact', 'Greeting::says-hello')
    Check (($one -join ',') -eq 'Greeting::says-hello=ok') "cargo test -- --exact Greeting::says-hello: $($one -join ', ')"
} finally {
    Pop-Location
    $env:CARGO_TARGET_DIR = $saved
}

if ($failures.Count) {
    Write-Output "E4 failed: $($failures.Count) check(s)."
    exit 1
}
Write-Output 'E4 passed.'
