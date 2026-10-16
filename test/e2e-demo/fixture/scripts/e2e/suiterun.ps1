# The demo's stand-in for the workspace's PowerShell suiterun. It speaks the
# command line every binding's program speaks (the verbs lint, actions, list
# and run, with their flags, plus --test-name for one case), so the extension
# calls it exactly as it would the real one. It hands the verb to the
# fixture's node tools: lint to tools/fake-lint.mjs, the others to
# tools/fake-run.mjs, which checks each step's action against
# scripts/e2e/actions and touches no lab. Lab flags are accepted and ignored.
# There is no param() block: every argument, flags included, arrives in $args.

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$verb = if ($args.Count) { [string]$args[0] } else { '' }
$tool = if ($verb -eq 'lint') { 'tools/fake-lint.mjs' } else { 'tools/fake-run.mjs' }

Push-Location $root
try {
    & node (Join-Path $root $tool) @args
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
