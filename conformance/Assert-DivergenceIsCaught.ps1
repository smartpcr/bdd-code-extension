<# .SYNOPSIS A binding that quietly disagrees is caught by the corpus. #>
<#
.DESCRIPTION
    Y7.1. The conformance jobs are only worth having if they would notice a
    binding drifting away from the others. This script makes one drift, in the
    working copy and nowhere else, and fails if the corpus lets it through.

    The change is the smallest real divergence there is: `equals` comparing
    case-sensitively. It is a decision rather than an accident of any one
    language - conformance/asserts/cases.yaml is where it is written
    down - and a binding could make it by mistake in all five. Go is the
    default because its toolchain is the quickest to install and its comparer
    is one file. TypeScript is the other one patched (B7.8 of the editor
    extension's plan), because its tables are run in-process by node:test
    rather than through a program, so Go's proof does not cover its wiring.

    The edit is reverted whatever happens, including on a failure, so this can
    be run on a working copy without leaving it changed. Nothing here touches a
    lab, a network or the repository's history. For TypeScript, `npm ci` runs
    first when node_modules is missing, which does fetch the package's pinned
    dependencies.

.PARAMETER Binding
    go (the default) or typescript.

.NOTES
    Run it by hand the same way CI does:
        pwsh -File conformance/Assert-DivergenceIsCaught.ps1
        pwsh -File conformance/Assert-DivergenceIsCaught.ps1 -Binding typescript
#>
[CmdletBinding()]
param(
    [ValidateSet('go', 'typescript')]
    [string]$Binding = 'go'
)

$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

# Per binding: the comparer file, the one line that decides it, what a binding
# that had drifted would say instead, and the command that runs only the
# assertion table. Ordinal is C#'s, Go's and JavaScript's default, so this is
# the mistake a careful author makes by leaving a default alone.
$targets = @{
    go = @{
        name      = 'Go'
        directory = Join-Path $root 'runtimes/go'
        comparer  = 'internal/assertion/assertion.go'
        agreeing  = 'return strings.EqualFold(subject(), wanted()), nil'
        diverging = 'return subject() == wanted(), nil'
        prepare   = $null
        run       = { & go test ./internal/conformance/ -run TestEveryRowOfTheAssertionTable 2>&1 }
    }
    typescript = @{
        name      = 'TypeScript'
        directory = Join-Path $root 'runtimes/typescript'
        comparer  = 'src/assertion.ts'
        agreeing  = "case 'equals': return subject.toLowerCase() === wanted.toLowerCase();"
        diverging = "case 'equals': return subject === wanted;"
        prepare   = { if (-not (Test-Path -LiteralPath 'node_modules')) { & npm ci 2>&1 | Out-Null } }
        # The tests are compiled from the working copy each time, so the patch
        # is what runs; the name pattern keeps it to the assertion table.
        run       = {
            $build = & npm run build:test 2>&1
            if ($LASTEXITCODE -ne 0) { return $build }
            & node --test --test-name-pattern 'every row of asserts/cases.yaml' dist-test/test/conformance/tables.test.js 2>&1
        }
    }
}
$target = $targets[$Binding]
$comparer = Join-Path $target.directory $target.comparer

if (-not (Test-Path -LiteralPath $comparer)) {
    throw "The $($target.name) comparer is not at $comparer. This script is pinned to that file."
}
$original = [IO.File]::ReadAllText($comparer)
if ($original -notlike "*$($target.agreeing)*") {
    throw "The $($target.name) comparer no longer holds the line this check patches. Update the line, or the check is not checking anything."
}

function Invoke-Corpus {
    <# The one conformance family the divergence changes, and its exit code. #>
    Push-Location $target.directory
    try {
        $output = & $target.run
        return @{ code = $LASTEXITCODE; output = ($output | Out-String) }
    } finally { Pop-Location }
}

if ($target.prepare) {
    Push-Location $target.directory
    try { & $target.prepare } finally { Pop-Location }
}

$caught = $false
try {
    # First, the corpus has to be green before anything is broken. A check that
    # only ever sees red proves nothing about whether it can see red.
    $before = Invoke-Corpus
    if ($before.code -ne 0) {
        throw "The $($target.name) assertion corpus is already failing, so this check cannot tell a deliberate divergence from an existing one:`n$($before.output)"
    }
    Write-Host "The $($target.name) assertion corpus is green before the divergence."

    [IO.File]::WriteAllText($comparer, $original.Replace($target.agreeing, $target.diverging))
    $after = Invoke-Corpus
    $caught = $after.code -ne 0
    if ($caught) {
        Write-Host 'The corpus caught a case-sensitive equals, which is what it is for.'
        $reported = @($after.output -split "`n" | Where-Object { $_ -match 'equals' } | Select-Object -First 3)
        foreach ($line in $reported) { Write-Host "  $($line.Trim())" }
    }
} finally {
    [IO.File]::WriteAllText($comparer, $original)
}

if ([IO.File]::ReadAllText($comparer) -cne $original) {
    throw "The $($target.name) comparer was not restored: $comparer"
}
if (-not $caught) {
    throw "A $($target.name) binding that compares equals case-sensitively passed the corpus. The corpus is not holding the bindings to anything."
}
Write-Host "PASS: a divergent $($target.name) binding fails the conformance job."
