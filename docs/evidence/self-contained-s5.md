# Stages S5a and S5 evidence: the extension follows the runtimes; the sample workspace

Plan: [docs/self-contained/implementation.md](../self-contained/implementation.md#stage-s5a-the-extension-follows-the-runtimes-p0)
and [stage S5](../self-contained/implementation.md#stage-s5-sample-workspace-extension-tests-and-ci-self-contained-p0).
Recorded 2026-10-15 on Windows 11 with Node.js 24.16, Go 1.26.4, Rust 1.96.0,
.NET SDK 10.0.402, PowerShell 7.6.7, Pester 5.7.1 and powershell-yaml 0.4.12.
Built by five agents in sequence and in parallel; **every result in the tables
below was rerun by hand after they reported.** Nothing has run in CI yet.

## Why S5a exists (DEC-S11)

S5 as first planned assumed a sample workspace could stand in for os-context.
An inventory of the integration suite showed the extension itself still
described os-context:
* its default sources and tool paths (`Hci.E2E.Suite.Cli`, `Invoke-LabTestSuite.ps1 -ApiUrl ...`);
* its registration patterns and *Implement* stubs (os-context's dispatch maps).

The runtimes register actions differently now. The user chose the neutral
layout. DEC-S11, D14 and stage S5a were added to the design and plan before
any code changed.

## S5a: the extension follows the runtimes (D14)

* **Defaults** (`src/config/defaults.ts`, `package.json` regenerated):
  * the DEC-S11 layout;
  * recognizers for `Register-SuiteAction`/`Register-LabAction`, Go
    `{Name: "x", Handler: ...}`, Rust `Action::new("x"`, C# `new ActionRegistration("x"`
    and TypeScript `action('x'`;
  * os-context's lifecycle recognizer and every `Hci.*` path removed;
  * a new `selectsOneCase` (PowerShell) replacing the binding `kind`.
* **The PowerShell binding is a program like the others:**
  `pwsh -File scripts/e2e/suiterun.ps1 <verb>`, passing `--test-name` for a
  one-case run. The offline `-ApiUrl` placeholder is gone.
* **The PowerShell runtime's command line (S5a.3):** `Invoke-BddSuiteCli` and
  `runtimes/powershell/suiterun.ps1`, with the other runtimes' verbs, flags,
  outputs and exit codes, plus `--test-name`. `tests/Cli.Tests.ps1` has 35 tests.
* **Fixed in passing:** PowerShell did not trace the steps a `wait` polls,
  which the other four runtimes do. The corpus did not cover it; the sample's
  `waiting.yml` found it.
* **Stubs** (`src/core/stubs.ts`, `templates/`):
  * one template per language, the `lifecycle` variants removed;
  * a TypeScript stub added, so *Implement* is now offered in TypeScript too.
* **Demo:** the fixture moved to the same layout, its stand-in runner speaks
  the program command line, and its expectations follow.
* **README:** the per-language layout table.

## S5: the sample workspace and the integration suite (D8, D9)

`samples/workspace`:
* **Catalog:** imports `spec/core.catalog.yaml` and a suite-schema extension
  (`shop.suite.json`, the field `owner`).
* **Actions:** ten neutral ones, implemented in different combinations of the
  five languages.
  * `report.export` is declared and registered nowhere, so the binding table
    has exactly one known drift item.
  * Every language's extension adds the context key `store` and the option `--store`.
* **Suites:** `smoke`, `checkout` (with the library `_lib/shop.yml`), `waiting`,
  `shipping`, `large` (1012 lines, 120 steps, for latency), and
  `flawed/{typos,dataflow,tables}`.
* **Bindings:** one project per language, built on `runtimes/` by relative reference.
* **`tools/compare-bindings.mjs`:** builds all five and compares their output.
* **`.vscode/settings.json`:** declares `bddSuite.contextKeys: ["store"]`.

The integration suite:
* **Sessions:** `sample` (the workspace, read only), `empty`, `worktree` (a git
  worktree of this repository) and `untrusted`.
* **Removed:** the os-context checkout (`OS_CONTEXT_ROOT`) and the lab session.
  E-B10 moves to S7.
* **Build step:** `runTest` builds the sample's bindings first.
* **Expected findings** come from an oracle: all five programs' `lint --json`
  over the sample's suites, which must agree. Where a test asserted a corpus
  expectation, it now compares against what the runtimes themselves report;
  each runtime proves the corpus in its own CI job.
* **The 2 integration agents' fixes to the extension:**
  * the binding table no longer counts imported core actions as drift.
* **Fixed by me after their reports:**
  * completion no longer offers os-context's `cluster`/`target`/`labId`/`apiUrl`;
    it offers the core's `timeoutSec` and `defaults` plus a new setting,
    `bddSuite.contextKeys`, which the sample sets to `store`;
  * an imported core action is no longer offered for *Implement*: the
    "Not implemented in ..." lens and the code action skip it. Pinned by a new
    integration test.

## Results (rerun by hand)

| Check | Result |
| --- | --- |
| `npm run test:unit` | **215 passed, 0 failed, 0 skipped**; statements and branches **100%**. The 4 tests that skipped without an os-context checkout now read the sample and never skip |
| `npm run test:demo` on the rebuilt package | **21 passing** |
| `Invoke-Pester runtimes/powershell` | **83 passed, 0 failed** (48 before, plus the 35 command-line tests) |
| `node samples/workspace/tools/compare-bindings.mjs --build` | **"All five bindings agree."** `actions --json` per binding equals the catalog (with `report.export` as the stated exception); `lint --json` is byte-identical on all 8 suites, plain and with `--binding-check` for each of five targets; `list` is identical; runs give identical traces |
| Sample schema `Build-Schema.ps1 -Check` | current |
| Build output in the sample | git-ignored (`target/`, `artifacts/`, `dist/`, `node_modules/`, the Go binary) |

**E4, the integration suite** (`BDD_WORKTREE_INCLUDE_CHANGES=1 npm run test:integration`,
no `OS_CONTEXT_ROOT`), run by hand after all fixes:

| Session | Passing | Pending | Failing |
| --- | --- | --- | --- |
| node tests | 14 | 0 | 0 |
| sample | 27 | 1 (B9.2, runs only with `--vsix`) | **1** |
| empty | 1 | 0 | 0 |
| worktree | 61 | 0 | 0 |
| untrusted | 5 | 0 | 0 |

**The one failure is environmental, and it stays open.** "Copy binding table
puts the Markdown table on the clipboard" got the right table back from the
command: `| PowerShell | scripts/e2e/actions/ | 7 | 7 | 0 |`, then C# with
`8 | 7 | 1`, and so on. But the clipboard read back `""`. On this machine,
`Set-Clipboard 'x'; Get-Clipboard` in plain PowerShell also returns nothing,
and the agent saw WinForms `Clipboard.SetText` throw. The same test passed in an
earlier isolated run. E4 and S5.6 stay open until it passes, on the CI Windows
runner or here once the clipboard works.

The PowerShell lint is no longer skipped in the integration suite. It passes,
because the runtime's `Test-Json` fix in S4 restores its structural findings.

## E1, local equivalent (S5.8)

`samples/`, the S5a changes and these tests are not committed yet, so a clone
would not contain them. The equivalent:
1. Copy exactly what git would commit (`git ls-files --cached --others
   --exclude-standard`, 619 files, no `node_modules` or `target`) into
   `/tmp/bdd-e1-hV8Q`.
2. Unset `OS_CONTEXT_ROOT`.
3. Run everything there.

| Step | Result |
| --- | --- |
| Spec tests (`Schema.Tests.ps1`) | **29 passed, 0 failed** (the first attempt failed on my own invocation, which mixed Pester parameter sets; rerun correctly in the same copy) |
| Every generated schema `-Check` | all eight current: the core, the corpus, five examples, the sample |
| TypeScript runtime `npm ci && npm test` | **112 passed**; coverage gate met |
| Go runtime `go vet && go test` | **21 packages ok**, no FAIL |
| Rust runtime `cargo test` | **158 passed, 0 failed** |
| C# runtime `dotnet build` / `dotnet test` | 0 warnings, 0 errors; **166 passed** |
| PowerShell runtime Pester | **83 passed**; corpus `PASS: 1512 conformance assertions` |
| Sample `compare-bindings.mjs --build` | **All five bindings agree.** |
| Extension `npm ci && npm run test:unit` | 0 failed, 0 skipped, **100%** |
| Extension `npm run package` | archive check passed |
| Extension `npm run test:demo` | **21 passing** |
| Logs scanned for os-context or the source checkout's path | **none** |

The integration suite was not rerun in the copy: its worktree session already
builds from a fresh git worktree of the repository, and it ran just before.
The clone-based E1 is S5.9, in CI.

## E8 (S5.11), local

* **The generator and the extension schema:** the sample's catalog imports
  the core and adds a field through a suite-schema extension; its generated
  schema is current. The spec tests cover duplicates, cycles and refused
  redefinitions.
* **The runtimes:** all five list core plus workspace actions
  (`compare-bindings`) and report identical findings.
* **The editor:**
  * The activation test asserts the core actions are in the index and
    `spec/core.catalog.yaml` is listed as an import.
  * Go to Definition on `wait` opens `spec/core.catalog.yaml`.
  * Duplicates and cycles across imports are reported (unit tests of `resolveCatalog`).

## Open

| Step | Why it is open |
| --- | --- |
| S5.6 / E4 | the one clipboard test, above |
| S5.7, S5.9 | CI runs after a push: the `integration` job and the clone-based E1 |
| From earlier stages | S1.17, S2.12, S3.7, S4.10 (each runtime's CI job) |
