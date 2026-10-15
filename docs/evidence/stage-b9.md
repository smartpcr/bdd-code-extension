# Stage B9 evidence

Recorded 2026-10-15. Plan: [implementation.md, stage B9](../implementation.md#stage-b9-package-and-accept).
Scenarios re-run on the package: E-B1 to E-B9, E-B11, E-B14, E-B15. [E-B10](../design.md#e-b10-the-portable-stage-0-cases-run-from-the-editor-against-a-real-lab): preflight only; the lab half is **blocked, not run** (no lab).

## Identity

| What | Value |
| --- | --- |
| Package | `bdd-suite-0.1.0.vsix`, 119,498 bytes, **SHA-256 `9c302f86af97dea1fb46e80980b3998f70932c298f8cd83d66f6ad45f27a573a`** (also in `bdd-suite-0.1.0.vsix.sha256`). Every run below used this one file; it was not rebuilt between them (a rebuild changes the hash, because the archive carries timestamps). |
| Built from | this repository at `e759c96` ("stage B8") **plus uncommitted B9 changes** (the acceptance record says `extensionTreeClean: false`) |
| `os-context` | the B7 worktree `E:\work\os\os-context-ts` at `7633e176` **plus the uncommitted B7 binding** (20 changed or new paths); the worktree session ran in a disposable copy of it with `BDD_WORKTREE_INCLUDE_CHANGES=1` |
| VS Code | Insiders 1.143.0 (`4c6cba1504`) |
| Node | 24.16.0 (harness) |
| Machine | 13th Gen Intel Core i9-13900K, 32 logical CPUs, Windows 11 |

## B9.1 Package and install

`npm run package` (`scripts/package.mjs`) compiles, runs `vsce package --no-dependencies`, writes the SHA-256, and then lists the archive's own central directory (no `tar` on `PATH` is trusted to read zip; Git's GNU `tar` cannot). **B9.1-1 passed**: the 11 files under `extension/` are

```
readme.md  package.json
dist/extension.js  dist/lintWorker.js
templates/{csharp,go,rust}.{core,lifecycle}.tmpl  templates/powershell.ps1.tmpl
```

and nothing under `src/`, `test/`, `out-test/`, `docs/`, `scripts/` or `artifacts/`, no source map, no dot-file. `vsce` stores the README as `readme.md`; the check is case-insensitive.

Found while packaging, fixed:
* `vsce` refused the README's relative links to `docs/` (there is no repository URL, and `docs/` is not shipped); the README names those files as plain text.
* `.claude/scheduled_tasks.lock` and `.gitignore` were packaged; `.vscodeignore` now excludes `.claude/**`, `.gitignore`, `artifacts/**`, `*.vsix` and `*.vsix.sha256`, and the check refuses any dot-file.

`README.md` now covers install (`code --install-extension bdd-suite-0.1.0.vsix`, checking the SHA-256), the `redhat.vscode-yaml` dependency, workspace trust, every setting, how to build each lint tool, and DEC-B03's limit (a program tool lints on open and save; the TypeScript tool lints unsaved text).

## B9.2 Offline acceptance on the package

`OS_CONTEXT_ROOT=E:\work\os\os-context-ts BDD_WORKTREE_INCLUDE_CHANGES=1 npm run test:integration -- --vsix bdd-suite-0.1.0.vsix`, exit 0, 2026-10-15 07:40 to 07:49 UTC.

How the package, not the source tree, is what ran: `runTest.ts --vsix` installs `redhat.vscode-yaml` and the `.vsix` into a fresh `.vscode-test/extensions-vsix`, checks `--list-extensions` names `local.bdd-suite@0.1.0`, and launches every session with that extensions folder and an empty stub as the development path. A new test asserts it: **`running local.bdd-suite@0.1.0 from E:\work\github\bdd-code-extension\.vscode-test\extensions-vsix\local.bdd-suite-0.1.0`**, version as packaged, no `src/` beside it. One test found the fake lint tool through the extension's install folder; it now finds it in this repository.

Record: [`artifacts/acceptance-2026-10-15.json`](../../artifacts/acceptance-2026-10-15.json) (package hash, both commits, VS Code version, every test's outcome, a verdict per scenario).

| Scenario | Verdict on the package | Tests |
| --- | --- | --- |
| B1.1 (activation, inert folder, the package check) | passed | 3 |
| E-B1 | **open**: 5 passed, PowerShell **skipped as blocked** (PowerShell 7.6.7 `Test-Json`, an `os-context` defect, stage B2) | 6 |
| E-B2 | passed | 5 |
| E-B3 | passed | 6 |
| E-B4 | passed | 4 |
| E-B5 | passed | 9 |
| E-B6 | passed | 8 |
| E-B7 | passed | 6 |
| E-B8 | passed | 6 |
| E-B9 | passed | 13 |
| E-B11 | passed | 14 |
| E-B14 | passed | 5 |
| E-B15 | passed | 5 |

The node-level tests in the same command (B2.1's program checks, B8.1-1's worker parity) ran first and passed (10; PowerShell's program check skipped as blocked); they exercise source modules, not the package, and are not counted above.

**B9.2-1 is not met**: E-B1 has a skipped test, so this step stays open. It closes when the PowerShell lint path gives the corpus's diagnostics, which needs the `Test-Json` defect fixed in `os-context` (or a PowerShell release without it), and the E-B1 PowerShell test re-run on this package.

## B9.3 Lab acceptance on the package

Built: `test/integration/suite/lab.test.ts` (session `lab`, run only by `npm run test:lab -- --vsix <path>`), `runTest.ts --lab`, the `test:lab` script.

* **Target discovery.** `BDD_LAB_API_URL`, `BDD_LAB_ID` and `BDD_LAB_CONNECTION_FILE` at run time; written to the test instance's user settings (never to either repository) and reset afterwards.
* **Transport.** The controller reaches the API directly, as `suiterun run --api-url` does.
* **Preflight**, which needs no lab.
* **Footprint gate:** `BDD_LAB_ACCEPT_FOOTPRINT=1`.
* **Run:** Test Explorer with the `portable` cases. The confirmation is answered only after its binding, lab id, API URL and case list are asserted, with no timeout of the harness's own.
* **Terminal run** of the printed command with its own `--results`.
* **Comparison:** each item against the terminal's NUnit result, and the two reports through `os-context`'s own `Test-ReportsEqual -IgnoreOutput` (`scripts/e2e/ReportCompare.psm1`).
* **Record:** `artifacts/lab-acceptance-<date>.json` with the hash, both commits, lab id, API URL, times, both reports and the ids in their captured output.

Run on the package: `OS_CONTEXT_ROOT=E:\work\os\os-context-ts npm run test:lab -- --vsix bdd-suite-0.1.0.vsix`.

* **Preflight: passed.** `go list --tags portable` names exactly the cases the index finds tagged `portable`, and every action they use, through hooks and imported meta steps, lists `go`. The 7 cases: `S0-48-ready-host-bootstrap-is-verified`, `S0-15-S0-21-S0-22-S0-29-applied-lineage-and-capability`, `S0-22-unknown-lab-returns-404`, `S0-31-S0-32-bounded-paginated-events`, `S0-06-S0-18-S0-19-S0-28-receipt-survives-and-reports-pending`, `S0-10-S0-25-S0-27-rollback-preview-and-dependency-refusal`, `S0-14-S0-20-S0-24-lifecycle-gates-name-their-reason`. The 9 actions: `lifecycle.cleanup`, `events`, `get`, `observations`, `receipt`, `rollback`, `select`, `stream`, `submit`.
* **Footprint: stated** (one bootstrap run record per execution from `S0-48`, two in all; nothing cleaned up by the extension).
* **Lab half: BLOCKED, not run.** No lab was given (`BDD_LAB_API_URL`, `BDD_LAB_ID`, `BDD_LAB_CONNECTION_FILE` unset), and the footprint was not accepted. Nothing touched a lab. **E-B10, B9.3-1 and B6.4's scenario box stay open.**

**Found:** E-B10 (design) says the selection is the eight cases E-Y7 ran on 2026-09-12; `lifecycle-stage0.yml` today tags **seven** `portable`. The harness compares against the live selection, not the number; the design's "eight" is historical.

To close B9.3, on a machine that reaches a lab whose host is bootstrapped:

```powershell
$env:OS_CONTEXT_ROOT = 'E:\work\os\os-context-ts'   # a checkout with the go program built
$env:BDD_LAB_API_URL = '<https://.../api/v1>'
$env:BDD_LAB_ID = '<32 hex lineage id>'
$env:BDD_LAB_CONNECTION_FILE = '<path to the connection file>'
$env:BDD_LAB_ACCEPT_FOOTPRINT = '1'                 # two bootstrap run records will be left
npm run test:lab -- --vsix bdd-suite-0.1.0.vsix
```

## What this does not prove

* The package was built from uncommitted source and tested against an uncommitted binding; a commit of either needs a new package and a new hash.
* Windows only, one machine, VS Code Insiders only.
* The lab path (E-B10) is untested against a lab; the harness's run, compare and record code has run only as far as its BLOCKED gate.
