# Stage B2 evidence

Recorded 2026-10-14. Plan: [implementation.md, stage B2](../implementation.md#stage-b2-lint-diagnostics-from-a-binding-program).

## Identity

| What | Value |
| --- | --- |
| This repository | working tree on top of `d1f1acd`, not committed |
| `os-context` | `E:\work\os\os-context` at `1d0f0e40` with local changes (none under `scripts/e2e/SuiteLint.psm1`, `test/e2e/schema` or the bindings); the worktree session ran on a clean worktree of `1d0f0e40` |
| Binding programs | Rust `target/debug/suiterun.exe` rebuilt by `cargo build` (cargo 1.96.0); Go built by `go build` (go 1.26.4) into the test instance's storage; C# built by `dotnet build` (.NET 10.0.402); PowerShell 7.6.7 with `powershell-yaml` 0.4.12 |
| VS Code | Insiders `4c6cba1504` |
| Machine | 13th Gen Intel Core i9-13900K, 32 logical CPUs, 128 GB, Windows 11 Enterprise 10.0.28000 |

## Unit gate

`npm run test:unit`, exit 0: 111 tests, 100 % of statements (1426), branches (607), functions (115) and lines over `src/core`, `src/config` and `src/tools`.

## B2.1 E2E: each program through `runTool` and `parseLintOutput`

`node --test out-test/test/integration/node/corpusTools.test.js` (part of `npm run test:integration`). 45 validate entries; excluded: `overridden.yml` (`params`), `uses-deprecated.yml` and `new-parameter.yml` (`catalogOverlay`).

| Program | Result |
| --- | --- |
| Go | all 45 entries: identical diagnostics (code, severity, line, column, order) and exit code |
| Rust | all 45 |
| C# | all 45 |
| PowerShell | **blocked, not passed**: 7 of 45 differ, every difference a missing schema finding (below) |

## B2.5 lint latency on `test/e2e/suites/lifecycle-stage1.yml`

1 warm-up and 20 timed lints per program through `runTool`, target `powershell`, from the full run:

| Program | p50 ms | p95 ms | max ms |
| --- | --- | --- | --- |
| Go | 103 | 116 | 122 |
| Rust | 118 | 135 | 169 |
| C# | 279 | 362 | 413 |
| PowerShell | 1401 | 1778 | 1823 |

The default lint tool stays `go` (lowest p95). `LINT_TIMEOUT_MS` (20000) is over 3x the slowest p95 (3 x 1778 = 5334), so it is unchanged.

## Integration runs (real VS Code)

| Session | Run | Result |
| --- | --- | --- |
| `oscontext` | final run | 20 passing, 1 pending (PowerShell, blocked) |
| `worktree` | after the fixes | 14 passing |
| `empty` | full run | 1 passing |
| `untrusted` | full run | 4 passing |

What they show:

* **E-B1 in the editor, on open**: Rust, Go and C# each match the corpus on all 45 entries, with source `suiterun:<tool>`. The save half (typos.yml, same three findings after a save, not doubled) passes.
* **B2.2-2**: two saves inside `LINT_DEBOUNCE_MS` started one lint. **B2.2-3**: a lint started during a running one cancelled it, and only the second published.
* **E-B2 / B2.3**: `smoke.yml` under target `rust` shows exactly the 4 `E201` the Go program prints for the same file and target. Inlay hints read `PS` on PowerShell-only steps and `PS C# Go Rs` on `core.noop`, with "Not implemented by Rust" in the tooltip. Switching the target to `powershell` re-lints without a save and clears every `E201`.
* **E-B11 / B2.4**: missing program "Lint: rust not built"; junk output "Lint output was not diagnostics"; 17 MB of output "Lint output too large"; a hung program "Lint timed out after 20 s", with its grandchild gone 1 s later. Each time the earlier `E301` stays shown, every message prefixed `[stale] `, and the output channel has argv, cwd and stderr. Restoring the program clears the marks. *Build lint tool* rebuilt the Go program at its configured path, and the next lint published.
* **E-B15 program half / B2.6**: in a genuinely untrusted window, the status bar reads "Suite: untrusted, lint and run disabled". Opening and linting a suite started no process (`lintsStarted` 0), *Show actions* and *Build lint tool* refused, and hover and Go to Definition still answered. Calling the trust-granted handler linted the open suite with the same controller instance (no rebuild, no reload).

## Blocked: the PowerShell quarter of E-B1 (B2.1 and B2.5)

On this machine's PowerShell 7.6.7, `Test-Json -Json <suite> -Schema <suite.schema.json>` returns `False` and writes **no error at all**, even with `-ErrorAction Stop`. A small schema with `additionalProperties: false` still reports errors normally. `scripts/e2e/SuiteLint.psm1`'s `Invoke-SchemaValidation` collects errors through `-ErrorVariable`, so it finds none, and the PowerShell binding loses every schema finding (`E101`, `E102`, `E103`, `E105`). The 7 entries that differ:

```
typos.yml              missing E101 4:5, E101 8:5
silent-assert.yml      missing E101 9:9
structure.yml          missing E103 2:7, E102 4:5, E102 5:9, E105 6:9
shapes.yml             missing E103 7:4, one of two E103 12:9
step-assert.yml        missing E101 12:13, E105 12:13
everywhere.yml         missing E101 4:3, 6:20, 9:5, 14:24, 22:9
step-why-multiline.yml missing E103 6:14
```

This is a defect in `os-context`'s PowerShell binding on PowerShell 7.6.7, not in the extension: the extension shows exactly what the binding prints. The design recorded the schema check working on 7.6.6. The scenario stays open for PowerShell until `os-context` fixes it, or the check runs on a PowerShell whose `Test-Json` reports errors.

## Defects found while building, and the unstated decision behind each

| Found | Cause | Fix | The decision that was missing |
| --- | --- | --- | --- |
| `broken.yml` and `not-a-mapping.yml` were never linted, so their `E100` never appeared | the controller linted only files the index calls suites; a file that does not parse, or whose root is a list, cannot show it is one | `WorkspaceIndex.isLintCandidate()`: suites and libraries, plus any file under the suite globs that does not parse or whose root is not a mapping | Lint must see a file that cannot be a suite, because "cannot be a suite" is itself the finding (narrows DEC-B13 for lint only) |
| A settings change emptied the Problems panel, and a failure after it had nothing to mark stale | every `bddSuite` change rebuilds the controllers, and a new controller had no results | lint results are owned per folder outside the rebuild, and the lint diagnostics collection is not cleared on rebuild | Results outlive a rebuild (B2.4-1 holds across settings changes) |
| The untrusted session ran trusted | `@vscode/test-electron` `runTests()` always adds `--disable-workspace-trust` | `runTest.ts` launches that session directly with the same arguments minus that flag | The harness owns the launch flags that a scenario depends on |
| No way to grant trust from a test | VS Code offers extensions no API or command to grant trust | `BDD_TEST_TRUST_SEAM=1`, set only by the harness, exposes `grantTrustForTest()`, which calls the same `onTrustGranted` function the `onDidGrantWorkspaceTrust` listener calls | **Named gap**: that VS Code fires `onDidGrantWorkspaceTrust` on a real grant is not exercised by automation; the wiring is one line in `src/extension.ts` and needs one manual check (click *Trust* in a restricted window and see the open suite lint) |
| The worktree session's Rust lint failed | `target/` is build output, not in a worktree | those tests point the Rust tool at the main checkout's program by absolute path; it runs with the worktree as its root | A worktree scenario names programs by absolute path |
| `executeDefinitionProvider` order (B1) and now `--path` | (see stage B1) | | |
