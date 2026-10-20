# Stage T7 evidence: PowerShell

Plan: [docs/test-providers/implementation.md](../test-providers/implementation.md#stage-t7-powershell-p1).
Recorded 2026-10-19 on Windows 11 with PowerShell 7.6.7, Pester 5.7.1 (the
version the T0 spike tested) and powershell-yaml 0.4.12; Node.js 24.16.0 for
the scripts. Nothing here has run in CI.

## What was built

| Where | What |
| --- | --- |
| `runtimes/powershell/BddSuite/Session.ps1` | **New**, dot-sourced by the module. It adds:<br>• `New-BddSuiteRunContext`, a test process's run context: extensions composed and started once, the schema, and `BDD_SUITE_OPTION_<NAME>`, `TAGS`, `DRY_RUN`, `ALLOW_GUARDED`, `TRACE_FILE` and `RECORD_PATH` read under the extensions' prefix. The context also owns the step runspace.<br>• The session: `Open-BddSuiteSession` (it lints first unless `-NoLint`), `Invoke-BddSuiteSetup`, `Invoke-BddSuiteBeforeEach`, `Invoke-BddSuiteCase`, `Invoke-BddSuiteAfterEach` and `Invoke-BddSuiteTeardown`.<br>• `Copy-SuiteBagValue`, a deep copy that keeps each collection's type.<br>• The Pester glue: `Get-BddSuiteTestContext` (one context per schema root and extension list for the whole `Invoke-Pester` run), `Reset-BddSuiteTestContext`, `Invoke-BddSuiteTest` (one case as one `It`), `Complete-BddSuiteSession` (teardown, trace, and a throw when the teardown failed) and `Write-BddSuiteTrace`. |
| `runtimes/powershell/BddSuite/Runner.ps1` | `Invoke-BddSuiteRun`'s per-file loop is now the session's operations in order. Everything it did is in `Session.ps1` and unchanged: the narration, the extensions' case hooks (SkipCase, CaseContext, CheckStep, WorkStarted, AfterStep, WorkFinished, CaseFinally, AfterCase, AfterSuiteHook, AfterTeardown), the timings and the stop file. `$script:RunState` is still the whole-file run's context; each session operation makes its own context the current one before calling the step and hook helpers. |
| `runtimes/powershell/BddSuite/Generate.ps1` | **New.** `Invoke-BddSuiteGenerate` (and the command line's `generate` verb): the config with the schema's checks, the globs, identifiers, the offline-action guard over expanded steps, plan JSON, and one `<Id>.Bdd.Tests.ps1` per suite for Pester 5. Each file has a `Describe` named after the suite; its `BeforeAll` imports BddSuite unless it is loaded, opens the session (`-Guarded` when the plan says so) and runs the setup, and its `AfterAll` runs `Complete-BddSuiteSession`. There is one `It` per case and row, tagged with the case's tags, with `<` and `>` escaped in its name. The writer rewrites only what changed and removes only its own files; `-Check` exits 1 naming each stale file. |
| `runtimes/powershell/BddSuite/Cli.ps1` | The `generate` verb with `--config` (repeatable), `--plan`, `--check`, `--provider`, `--out`; those flags belong to it alone. A plan is written as UTF-8 even when the console's code page is another. |
| `runtimes/powershell/BddSuite/SuiteLint.psm1` | **A lint divergence found.** E202 (a case declared twice) compared names ignoring case, a PowerShell hashtable's default, so it refused the generate corpus's `places an order` beside `PLACES AN ORDER`, which every other runtime accepts. Names now compare ordinally. |
| `runtimes/powershell/BddSuite/BddSuite.psd1`, `BddSuite.psm1` | The new functions exported; `Session.ps1` and `Generate.ps1` dot-sourced. |
| `runtimes/powershell/tests/` | **New:** `Session.Tests.ps1` (one test per rule, the environment, lint refusal, the Pester glue, one context per run; and **E1**, every execute entry through the session in file order and reversed, results equal to `Invoke-BddSuite`'s) and `Generate.Tests.ps1` (identifiers, the guard, config refusals, globs, the golden files in `tests/golden/pester`, the writer and `-Check`, the command line's flags). `Conformance.Tests.ps1` runs the manifest's `generate` list (**E3**). The corpus extension implements `fixture.append` (`CorpusExtension/actions/Fixture.ps1`, in place when the list can grow). `BddSuite.Tests.ps1`: see the dry-run change below. |
| `samples/workspace/tests/powershell/` | **New.** `shop/` and `corpus/` each hold a config and the generated `*.Bdd.Tests.ps1` beside it (committed). The shop config uses the extension `../../../scripts/e2e/Workspace.Extension.psm1`; the corpus config uses a copy of the corpus extension (`corpus-extension/`). Also `generate.ps1 [-Check]`; `Invoke-Tests.ps1`, the driver (it imports the runtime, runs Pester with NUnit3 output, `-FullNameFilter`, `-TagFilter`, `-SkipRun`, and resets the context afterwards); and `scenarios.mjs` (E8, E9, E10, E12). |
| `samples/workspace/tests/harness/corpus.mjs` | A `pester` adapter: one generated file through `Invoke-Tests.ps1`, its NUnit3 test cases (the `It`'s own name), and a teardown failure read from the fixture's `result="Failed" site="TearDown"`. |
| `conformance/run-manifest.yaml` | powershell removed from `pendingIn` of `capture-isolation` and of both `generate` entries. Nothing in the manifest is pending for any runtime now. |

## Differences from D13, D14 and DEC-T05 as written

* **The session's form.** It is a hashtable driven by exported functions, not a PowerShell class: the step and hook helpers it calls read the module's `$script:RunState`, which a class method reaches less plainly than a module function does.
* **The command.** `Invoke-BddSuiteGenerate` and `suiterun.ps1 generate`, not `Invoke-BddSuite -Generate`. `Invoke-BddSuite`'s `-Path` is mandatory and its parameters are the run's.
* **Hooks.** beforeEach, the case and afterEach run inside each `It`, through `Invoke-BddSuiteTest`, rather than in Pester's `BeforeEach`/`AfterEach`; the other languages do the same. Skips (tag filter, guarded, dry run) are `Set-ItResult -Skipped -Because <reason>` in the `It`, since Pester can skip at run time.
* **Loading the module.** The generated files call `Import-Module BddSuite` only when it is not loaded. `Import-Module` by name searches `PSModulePath` only, so a runtime loaded by path (the sample's driver) is used as it is. This is how a run context outlives one container (DEC-T05's run-context row); the driver calls `Reset-BddSuiteTestContext` after the run.
* **A dry run traces nothing.** The whole-file run used to trace `case skipped` under `-DryRun`, against rule 10 and unlike every other runtime. It now traces nothing; `BddSuite.Tests.ps1`'s expectation changed with it, and no corpus expectation changed.
* **Rule 5 in the corpus.** `capture-isolation` cannot tell a deep copy from a shallow one in PowerShell. With the old one-level copy put back it still passed. The likely cause, not traced to the line: the list the action receives after `${capture.shared.items}` is expanded is not the bag's own list, as in Rust, so an append in place cannot reach the bag either way. The deep copy is proved by its unit test ("rule 5"), which changes a nested list and dictionary of the copy and reads the original unchanged.

## Step by step

| Step | Evidence |
| --- | --- |
| T7.1 Session functions; the context owns the step runspace | `Session.Tests.ps1`, rules 1 to 10. `New-BddSuiteRunContext` holds `stepRunspace`, which `Reset-BddSuiteTestContext` closes. |
| T7.2 Recorded failures; deep copy | Rules 3 and 4 (a failed setup, beforeEach or afterEach is recorded and reported by the case, never thrown); rule 5 (`Copy-SuiteBagValue`). |
| T7.3 `Invoke-BddSuiteRun` rebuilt; E1, E2; `fixture.append` | E1 in `Session.Tests.ps1`. E2: below. `capture-isolation` passes; powershell removed from its `pendingIn`. |
| T7.4 Plan and `generate --plan`; E3 | `Conformance.Tests.ps1` runs both `generate` entries; powershell removed from their `pendingIn`. The E202 fix above was needed for it. |
| T7.5 Pester template, tags, guarded skip, NUnit3, `-Check` | `Generate.Tests.ps1` (golden files, `<` `>` escaping, the writer, `-Check`); the driver writes NUnit3. |
| T7.6 Sample; E8 | `samples/workspace/tests/powershell`; the corpus harness; `scenarios.mjs E8`. |
| T7.7 E9, E10, E12 | `scenarios.mjs E9 E10 E12`. |

## Scenarios

| Scenario | What ran | Result |
| --- | --- | --- |
| E1 | `Session.Tests.ps1`: every execute entry through the session, file order and reversed, results equal to the whole-file run's | pass |
| E2 | `Invoke-Pester runtimes/powershell/tests` (unit, CLI, the corpus harness); `npm run test:integration` | see Runs |
| E3 | `Conformance.Tests.ps1 -RunHarness`: both `generate` entries, the plan compared as data, the broken config's finding `suites/b-broken.yml:8:17 E104` | pass |
| E8 | **The corpus harness** (`--provider pester`): 14 corpus entries and 9 sample suites, one generated file per run through `Invoke-Tests.ps1`, each outcome and the trace compared with the corpus's, and a teardown failure seen as the fixture's TearDown. **`scenarios.mjs E8`:** the `shop` run's NUnit3 report has one test case per planned case and row. `-FullNameFilter hooks.first` runs one `It`, with one suite setup and one suite teardown, and nothing of `second`. `-TagFilter smoke` runs exactly the cases the plan tags smoke. `teardown-fails`: the case Passed, the `teardown-fails` fixture is `Failed` with `site="TearDown"`, and the run exits 1. | pass |
| E9 | `Invoke-Tests.ps1 -SkipRun` (Pester discovery, `Run.SkipRun`) lists `<suite>.<case>` for every planned case and row of both configs | pass |
| E10 | **Without the opt-in:** the three `order-placement` cases are Skipped with the reason `guarded suite: set BDD_SUITE_ALLOW_GUARDED=1 to run it`, its setup and teardown markers are never written, and `shipping` passes. **With it:** all three pass, with setup and teardown once. `BDD_SUITE_OPTION_STORE=outlet-7` was set, and neither the value nor any `BDD_SUITE_OPTION` name is in the generated files. | pass |
| E12 | A case added to `order-placement.yml`: `generate.ps1 -Check` exits 1 with `stale: OrderPlacement.Bdd.Tests.ps1`; after `generate.ps1`, `-Check` is 0 and the case runs. Renamed: the new name replaces the old. An unknown action: generation exits 2 with `order-placement.yml:<line>:<col>  E104`. Afterwards the suite and the generated files are byte for byte as they were. | pass |

## Runs

| Run | Result |
| --- | --- |
| `pwsh -File tests/Conformance.Tests.ps1 -RunHarness` | PASS: 1547 conformance assertions: 41 validate, 14 execute (0 pending), 2 generate, 7 reports, 203 expression rows, 96 assertion rows |
| `Invoke-Pester runtimes/powershell/tests` | Passed 107, Failed 0, Skipped 0 (the corpus harness inside it: 1547 assertions) |
| `node samples/workspace/tests/harness/corpus.mjs --provider pester` | 14 corpus entries and 9 sample suites checked; 0 differ |
| `node samples/workspace/tests/powershell/scenarios.mjs` | 4 of 4 pass |
| `npm run test:integration` (the sample's PowerShell binding runs this runtime) | exit 0: node:test 14 of 14; extension host 28, 1, 61 and 5 passing, 0 failing |

## Open

* E10's "options missing" clause, as in T2 to T6 (the extension API has no required options).
* E11 is not one of T7's scenarios: Pester runs one test at a time.
* CI has not run any of this.
