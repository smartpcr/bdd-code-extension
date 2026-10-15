# Stage S4 evidence: the PowerShell runtime and the divergence check

Plan: [docs/self-contained/implementation.md](../self-contained/implementation.md#stage-s4-powershell-runtime-p0).
Recorded 2026-10-15, on Windows 11 with PowerShell 7.6.7, Pester 5.7.1 and
powershell-yaml 0.4.12. Built by an agent following the TypeScript runtime
(S1) as the reference and the Go, Rust and C# ports as precedent. **Every
result below was rerun by hand after the agent reported.** Nothing has run in
CI yet (S4.10).

## Source and baseline

The generic modules come from os-context `scripts/e2e` at commit
`7633e176fb70140e94ddc7e9d96b07eb39c39b22` (`git archive`). os-context was not
modified.

**The baseline was already broken.** In the os-context worktree,
`pwsh -File scripts/e2e/Conformance.Tests.ps1 -RunHarness` fails at
`validate/typos.yml`: it produces only `E104`, missing `E101` at 4:5 and 8:5.
This is the PowerShell 7.6.7 `Test-Json` defect recorded in this repository's
stage B2: `Test-Json` returns `False` and reports **no errors**, so every
structural finding is lost. Because this repository now owns the runtime, the
fix belongs to this stage.

## The `Test-Json` fix

* **Proof before the fix:** a probe on `conformance/validate/typos.yml`:
  * `Test-Json` returns `False` with 0 errors;
  * calling the JsonSchema.Net library that ships in PowerShell 7.6.7 (7.0.0.0)
    directly, as `JsonSchema.FromText(schema).Evaluate(node, List output)`,
    returns `/tests/0/timeout` and `/tests/0/assert`, each "All values fail
    against the false schema". That is `additionalProperties: false`: the two
    missing `E101`s.
* **The fix:** `SuiteLint`'s `Invoke-SchemaValidation` now evaluates through
  the library and returns the same `@{ body; pointer }` per error that its
  callers always read. `Test-SuiteJson` replaces the other `Test-Json` uses.
  The pointer is the instance location's `ToString()`; string interpolation
  would join its segments with spaces.
* **After the fix:** the lint gives `E101@4:5`, `E104@6:17`, `E101@8:5` on
  `typos.yml`, pinned by a test in `tests/BddSuite.Tests.ps1`. On this
  machine's PowerShell 7.6.7 the PowerShell runtime now reports structural
  findings again, which os-context's binding still does not.

## What was built (S4.1-S4.8, D7)

`runtimes/powershell`:
* **`BddSuite/` module** (`BddSuite.psd1/.psm1`):
  * the generic modules: SuiteModel, SuiteLint, StepExecution, Expression,
    Assertions, ReportCompare;
  * the action registry and the core actions (`Core.ps1`, `Wait.ps1`);
  * `Runner.ps1`, the generic half of `Invoke-LabTestSuite.ps1`;
  * the JUnit writer, taken from os-context's test-support module.
* **Commands:**
  * `Register-SuiteAction` and `Get-SuiteActionNames`, with the aliases
    `Register-LabAction`, `Get-LabActionNames` and `Get-LabAction` kept;
  * `Invoke-SuiteLint`;
  * `Invoke-BddSuite`, which takes `-Path`, `-Tags`, `-TestName`, `-ResultsFile`,
    `-ReportFormat`, `-DryRun`, `-Lint`, `-Strict`, `-Json`, `-Param`,
    `-TraceFile`, `-TimingFile`, `-StopFile`, `-SchemaRoot`, `-ActionPath`,
    `-Extension`, `-Option`, `-Binding` and `-BindingCheck`.
* **Script entry:** `Invoke-BddSuite.ps1`.
* **An extension** is a module exporting `Get-SuiteExtension`, which returns
  `Name`, `ActionPath`, `Modules`, `ContextKeys`, `Options`, `Rules` (`Lint`,
  `CaseLimitSec`), `EnvPrefix` and `Start` (`Context`, `Redact`, `State`).
  * The step runspace imports BddSuite, then each extension's modules, then
    each action file; never os-context's lifecycle modules by fixed path.
  * An action sees its extension's state as `$Ctx.state`.
  * Composition refusals use the TypeScript wording.
* **Removed from the core:**
  * the context keys `cluster`/`target`/`labId`/`apiUrl`;
  * the 900 s lifecycle rule and budget;
  * E214;
  * `HCI_SUITE_*` (the default prefix is now `BDD_SUITE_`), and `requires` and its use-site skip;
  * the lab parameters, operation evidence, Stage 7, result publishing and the scenario-catalog lint.

  `HANDOVER.md` lists what os-context's wrapper must keep or supply (D10).
* **Catalogs:** follow `imports`, refusing duplicates and cycles.
* **`tests/`:**
  * `Conformance.Tests.ps1`, the corpus with the corpus extension;
  * `BddSuite.Tests.ps1`, the generic tests and the extension model;
  * `CorpusExtension/`.
* **`example/`:** the E3 extension and its tests.

## Results

| Check | Result |
| --- | --- |
| `Invoke-Pester runtimes/powershell` | **48 passed, 0 failed, 0 skipped** |
| Corpus, inside that run | `PASS: 1512 conformance assertions: 41 validate, 11 execute, 7 reports, 203 expression rows, 96 assertion rows, core catalog = 6 registered.` |
| Expression table | all **276** rows are asserted. The summary's 203 counts the rows that produce a value; the 73 rows that expect a refusal code are asserted and `continue` before the counter |
| Core catalog against registered | exactly the 6 core actions |
| E3 (`example/Example.Tests.ps1`) | with the extension, lint is only `E205 5:17`; without it, only `E301 9:15`; the `${region}`-free copy runs and fails with the unknown-action message; two extensions with one action are refused; the 10 s cap stops a slow case at run time |
| Example schema | `Build-Schema.ps1 -Catalog runtimes/powershell/example/schema/actions.catalog.yaml -Check`: current |

**One difference from the other runtimes in E3.** The PowerShell runner lints
before it runs and refuses a file with findings (exit 2). That gate is
long-standing and kept on purpose. So `echo.yml` itself, whose `timeoutSec: 30`
breaks the slow ceiling, is refused rather than run. The "run passes" half of
E3 therefore uses a copy with `timeoutSec: 10`, and the "run fails" half uses
the `${region}`-free copy. The other four runtimes run `echo.yml` as it is.

**The os-context scan** found these words only where expected: `os-context` in
comments recording provenance; `lifecycle` in a test proving the old rule is
gone; a self-check test that scans for these words; and the corpus
extension's context keys. `HANDOVER.md` names them on purpose.

## S4.9: the divergence check

`pwsh -File conformance/Assert-DivergenceIsCaught.ps1 -Binding go`, then
`-Binding typescript`, run by hand, needed no edits to the script:

| Binding | Result |
| --- | --- |
| go | the injected case-sensitive `equals` failed `equals of [Up] against [up]` and `[true] against [True]`; `PASS: a divergent Go binding fails the conformance job.` exit 0 |
| typescript | the same two rows failed; `PASS: a divergent TypeScript binding fails the conformance job.` exit 0 |

Afterwards, git showed no tracked change under `runtimes/typescript` or
`conformance`. `runtimes/go` is not committed yet, so its restore was confirmed
directly: `go test ./internal/conformance -run TestEveryRowOfTheAssertionTable`
passes again.

## S4.10: CI (built, open)

* **`runtime-powershell`** runs on `windows-latest`. It installs Pester 5.5+
  and powershell-yaml 0.4.12, the version the suite reader mirrors, then runs
  `Invoke-Pester runtimes/powershell`.
* **`divergence`** runs on `ubuntu-latest` with Go and Node. It runs the check
  for Go and TypeScript, then `git diff --exit-code -- runtimes`.
* **The `spec` job's staleness check** covers the PowerShell example.
* **The release job** waits for both new jobs.
* **Not run:** CI runs on GitHub after a push.

## Where E2 and E3 stand

**All five runtimes pass the whole relocated corpus, and the divergence check
passes for Go and TypeScript, locally.** E2 is complete locally. E3 passes in
all five, with the PowerShell difference above. Both stay open until CI runs
them.
