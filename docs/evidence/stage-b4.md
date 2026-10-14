# Stage B4 evidence

Recorded 2026-10-14. Plan: [implementation.md, stage B4](../implementation.md#stage-b4-the-binding-table-and-drift).
Scenario: [E-B7](../design.md#e-b7-the-binding-table-matches-the-catalog-and-the-binaries-and-drift-appears-when-introduced).

## Identity

| What | Value |
| --- | --- |
| This repository | working tree on top of `51c0215` (stage B3), not committed |
| `os-context` | `E:\work\os\os-context` at `e9da5ab5` with local changes outside the catalog, the bindings and `scripts/e2e/actions`; the worktree session ran on a clean worktree of `e9da5ab5`. The four commits since `1d0f0e40` change none of `test/e2e/schema`, `test/e2e/bindings` or `scripts/e2e/actions`. |
| Programs | as in [stage B2](stage-b2.md): Go `suiterun.exe` built by the extension, Rust `target\debug\suiterun.exe`, C# `artifacts\bin\Hci.E2E.Suite.Cli\Debug\net10.0\suiterun.exe`, PowerShell through `pwsh` 7.6.7 dot-sourcing `ActionRegistry.ps1` |
| VS Code | Insiders `4c6cba1504` (the cached build used since stage B2) with `redhat.vscode-yaml` |

## Unit gate

`npm run test:unit`, exit 0: 144 tests, 100 % of statements, branches, functions and lines over `src/core`, `src/config` and `src/tools`. New for B4, in `coverage.test.ts`:

* **B4.1-1**: a clean tree gives Declared from the catalog, Found equal to Declared and no drift, with the Source column as the common directory of the binding's globs.
* **B4.1-2**: removing one site moves exactly that name to `declaredNotFound`, and only for that binding.
* Extra names, duplicates (same recognizer only; one name from two recognizers is not a duplicate), a site of a binding the catalog does not list, and a catalog binding with no settings.
* `globDirectory` and `commonSource`.
* **B4.3** `compareProgramSet`: agreement, and each kind of difference (`programOnly`, `programMissing`, `notInSource`, `sourceOnly`); `programAgrees` for no check, a failed check and a differing check.
* `toMarkdownTable` with and without the Program column.

## Integration (real VS Code), final build

| Session | Result |
| --- | --- |
| `oscontext` | 24 passing, 1 pending (PowerShell E-B1, blocked as recorded in stage B2) |
| `worktree` | 25 passing |
| `empty` | 1 passing |
| `untrusted` | 4 passing |

The E-B7 scenarios, four-binding half:

* **Clean tree (B4.1, B4.2-1)**, `coverage.test.ts` on the real checkout. The harness reads `actions.catalog.yaml` itself and computes the Declared set per binding. The view's rows equal `rows()` (that is, `computeCoverage()`), in catalog order. Each row shows Declared equal to the harness's set and Found equal to Declared, with no drift. Each row's label reads `<Label>  N declared, N found, 0 drift` and its only child is "no drift". Result: PowerShell 100/100, C# 24/24, Go 24/24, Rust 24/24 (Declared/Found).
* **Copy binding table**: the command returns the Markdown table and puts the same text on the clipboard. The table includes the row `| PowerShell | \`scripts/e2e/actions/\` | 100 | 100 | 0 |`.
* **Program half (B4.3-1)**: *Verify with binding programs* runs each program's `actions --json`. For every binding, the program's set equals the harness's catalog set and equals Found; the first row's description reads "program agrees". Result: PowerShell 100, C# 24, Go 24, Rust 24, all agreeing.
* **A failing program (B4.3-2)**: with the C# tool set to a missing `suiterun.exe`, the C# row's program check fails as `not-found` and its children include "program  failed: not-found". The other three rows still verify. The setting is reset afterwards.
* **Drift (B4.2-2, and the timing half B1.7 deferred)**: `coverageDrift.test.ts`, in a disposable worktree. The test deletes the Rust dispatch arm `"lifecycle.get" =>` in `test/e2e/bindings/rust/src/lifecycle/actions.rs` and saves. The Rust row then shows Drift 1, its first child `lifecycle.get` "declared, not registered" opens `actions.catalog.yaml`, and no other kind of drift appears. Drift was shown 53 ms after save, within the 2 s limit. Re-inserting the line and saving clears the drift within 2 s. The worktree is removed by the harness.

Still open: the TypeScript half of E-B7, which needs a TypeScript row, the TypeScript program's `actions --json` and the TypeScript drift injection. The catalog at `e9da5ab5` has no `typescript` binding; it lands with B7.1, B7.5 and B7.7.

## Departures

* The two commands *Verify with binding programs* and *Copy binding table* are in `commands.ts` as the plan says, reached through a `coverage` member on `CommandHost`. The view itself is created once at activation (not per rebuild) and is refreshed on every rebuild and on each indexer's `onDidChangeIndex`.
* A program check is stored per binding and re-compared against the current Found set on every refresh. A later edit therefore shows "program differs" without running the program again. Rows have a `program` member only after *Verify* has run.
* The PowerShell program check dot-sources `ActionRegistry.ps1` and prints `Get-LabActionNames`. This is the same `actionsCommand` profile as *Show actions* (B2.1), so it is not affected by the PowerShell 7.6.7 `Test-Json` defect that blocks PowerShell lint.

## Defects found while building, and the unstated decision behind each

| Found | Cause | Fix | The decision that was missing |
| --- | --- | --- | --- |
| The drift test's restore step did nothing, so the worktree's file stayed edited until the worktree was removed | `undo` acts on the active editor, and the test had opened the document without showing it | the test re-inserts the removed text with a `WorkspaceEdit` and asserts the line is back in place | A test undoes its own edits explicitly, never through editor commands that depend on focus |
