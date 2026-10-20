<#
.SYNOPSIS
    E3 (docs/packages): a Go consumer builds and tests from the module version
    alone.

.DESCRIPTION
    1. Writes the runtime as a module version into the local file GOPROXY
       (scripts/local-feeds.ps1 -Language go), unless -NoPack.
    2. Checks this consumer's go.mod requires the release version and holds no
       replace directive.
    3. Copies the consumer to artifacts/e3/work and works there, with a module
       cache of its own and GOPROXY naming the local feed first, so the module
       just written is the one used: proxy.golang.org may hold another build
       of the same version. go.sum is written there by go mod tidy, and the
       module's checksum database lookup is skipped for this one module only.
    4. go generate writes exactly the *_bdd_test.go committed here.
    5. Its suiterun: lint, list --name, run --name --progress.
    6. go test: every case passes but the guarded one, which skips; all pass
       with BDD_SUITE_ALLOW_GUARDED=1; -run selects one case.

    -Bootstrap copies the generated files back here instead of comparing them,
    for the first run or after a deliberate change to the generator.

    Exits 0 when every check passes, 1 naming each that failed.

.EXAMPLE
    pwsh -File samples/consumers/go/run-e3.ps1
#>
[CmdletBinding()]
param(
    [switch]$NoPack,
    [switch]$Bootstrap
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $here '../../..')).Path
$version = 'v' + (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$module = 'github.com/smartpcr/bdd-code-extension/runtimes/go'
$failures = [Collections.Generic.List[string]]::new()
function Check([bool]$Ok, [string]$What) {
    if ($Ok) { Write-Output "  ok    $What" } else { Write-Output "  FAIL  $What"; $failures.Add($What) }
}
# A file URL: file:///E:/x on Windows, file:///home/x elsewhere.
function Url([string]$Path) {
    $slashed = $Path -replace '\\', '/'
    if ($slashed.StartsWith('/')) { "file://$slashed" } else { "file:///$slashed" }
}

if (-not $NoPack) {
    & pwsh -NoProfile -File (Join-Path $repo 'scripts/local-feeds.ps1') -Language go
    if ($LASTEXITCODE) { throw 'writing the Go module version failed' }
}
$feed = Join-Path $repo 'artifacts/feeds/goproxy'
$feedZip = Join-Path $feed "$module/@v/$version.zip"

Write-Output "E3: the Go consumer from the module $module@$version"
$goMod = Get-Content (Join-Path $here 'go.mod') -Raw
Check ($goMod -match "(?m)^require $([regex]::Escape($module)) $([regex]::Escape($version))\s*$") "go.mod requires $module $version"
Check ($goMod -notmatch '(?m)^\s*replace\b') 'go.mod has no replace directive'

$scratch = Join-Path $here 'artifacts/e3'
$work = Join-Path $scratch 'work'
Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work | Out-Null
Get-ChildItem $here -Force | Where-Object { $_.Name -notin 'artifacts', 'go.sum' } | Copy-Item -Destination $work -Recurse

$sharedCache = (go env GOMODCACHE).Trim()
$saved = @{}
$environment = @{
    GOMODCACHE = Join-Path $scratch 'gomodcache'
    # The local feed first; dependencies from the shared cache, else the network.
    GOPROXY    = "$(Url $feed),$(Url (Join-Path $sharedCache 'cache/download')),https://proxy.golang.org"
    GONOSUMDB  = $module
    GOFLAGS    = '-mod=mod'
    GOWORK     = 'off'
    GOTOOLCHAIN = 'local'
}
foreach ($key in $environment.Keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key); Set-Item "env:$key" $environment[$key] }
Push-Location $work
try {
    $tidy = go mod tidy 2>&1
    Check ($LASTEXITCODE -eq 0) "go mod tidy resolves the module from the local feed$(if ($LASTEXITCODE) { ":`n$($tidy -join "`n")" })"
    $cachedZip = Join-Path $environment.GOMODCACHE "cache/download/$module/@v/$version.zip"
    Check ((Test-Path $cachedZip) -and (Get-FileHash $cachedZip).Hash -eq (Get-FileHash $feedZip).Hash) "the module in this consumer's cache is the zip in the local feed"

    $generated = go generate ./... 2>&1
    Check ($LASTEXITCODE -eq 0) "go generate ./...$(if ($LASTEXITCODE) { ":`n$($generated -join "`n")" })"
    $made = @(Get-ChildItem (Join-Path $work 'tests') -Filter '*_bdd_test.go' | Sort-Object Name)
    if ($Bootstrap) {
        Get-ChildItem (Join-Path $here 'tests') -Filter '*_bdd_test.go' | Remove-Item
        $made | Copy-Item -Destination (Join-Path $here 'tests')
        Write-Output "  bootstrap: copied $($made.Count) generated files into tests/"
    }
    $committed = @(Get-ChildItem (Join-Path $here 'tests') -Filter '*_bdd_test.go' | Sort-Object Name)
    $same = $made.Count -gt 0 -and $made.Count -eq $committed.Count -and -not @(0..($made.Count - 1) | Where-Object {
        $made[$_].Name -cne $committed[$_].Name -or (Get-FileHash $made[$_].FullName).Hash -ne (Get-FileHash $committed[$_].FullName).Hash })
    Check $same "go generate writes exactly the committed tests ($(@($made.Name) -join ', '))"

    $program = Join-Path $scratch 'suiterun.exe'
    go build -o $program ./cmd/suiterun
    Check ($LASTEXITCODE -eq 0) 'its suiterun builds'
    $lint = & $program lint --schema-root schema --path 'suites/*.yml' 2>&1
    Check ($LASTEXITCODE -eq 0) "suiterun lint: both suites lint clean against bdd-suite:core and the greeter's actions ($($lint -join ' '))"
    $list = @(& $program list --schema-root schema --path 'suites/*.yml' --name '*hello' 2>&1)
    Check (($list -join '|') -eq 'greeting.yml  says-hello|loud.yml  shouts-hello') "suiterun list --name '*hello': $($list -join ' | ')"
    $run = @(& $program run --schema-root schema --path 'suites/greeting.yml' --name 'says-*' --progress 2>&1)
    Check ($LASTEXITCODE -eq 0 -and $run -contains 'StartGroup: greeting::says-hello' -and
        $run -contains 'Summary: Total=1, Passed=1, Failed=0, Blocked=0, Not Run=0, Skipped=0') "suiterun run --name --progress: $($run -join ' | ')"

    function Test-Run([string[]]$Extra, [hashtable]$Env = @{}) {
        foreach ($key in $Env.Keys) { Set-Item "env:$key" $Env[$key] }
        try { $said = go test ./tests -v -count=1 @Extra 2>&1 } finally { foreach ($key in $Env.Keys) { Remove-Item "env:$key" } }
        return @($said | Select-String '^\s*--- (PASS|SKIP|FAIL): (\S+/\S+)' | ForEach-Object { "$($_.Matches[0].Groups[2].Value)=$($_.Matches[0].Groups[1].Value)" } | Sort-Object)
    }
    $plain = Test-Run @()
    Check (($plain -join ',') -eq 'TestSuite_Greeting/says-hello=PASS,TestSuite_Greeting/the-core-still-works=PASS,TestSuite_Loud/shouts-hello=SKIP') "go test: the guarded case skips: $($plain -join ', ')"
    $allowed = Test-Run @() @{ BDD_SUITE_ALLOW_GUARDED = '1' }
    Check (($allowed -join ',') -eq 'TestSuite_Greeting/says-hello=PASS,TestSuite_Greeting/the-core-still-works=PASS,TestSuite_Loud/shouts-hello=PASS') "go test with BDD_SUITE_ALLOW_GUARDED=1: $($allowed -join ', ')"
    $one = Test-Run @('-run', 'TestSuite_Greeting/says-hello')
    Check (($one -join ',') -eq 'TestSuite_Greeting/says-hello=PASS') "go test -run TestSuite_Greeting/says-hello: $($one -join ', ')"
} finally {
    Pop-Location
    foreach ($key in $saved.Keys) { if ($null -eq $saved[$key]) { Remove-Item "env:$key" -ErrorAction SilentlyContinue } else { Set-Item "env:$key" $saved[$key] } }
}

if ($failures.Count) {
    Write-Output "E3 failed: $($failures.Count) check(s)."
    exit 1
}
Write-Output 'E3 passed.'
