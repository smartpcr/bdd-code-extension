# Stage T2 evidence: the C# generator and MSTest

Plan: [docs/test-providers/implementation.md](../test-providers/implementation.md#stage-t2-c-generator-and-mstest-p0).
Recorded 2026-10-19 on Windows 11, .NET SDK 10.0.402, MSTest.TestFramework and
MSTest.TestAdapter 4.3.2, Microsoft.NET.Test.Sdk 18.4.0, Node.js 24.16.0.
Nothing here has run in CI.

## What was built

| Where | What |
| --- | --- |
| `runtimes/csharp/Bdd.Suite/Testing/` | **New.** `TestsConfig` (reads `bddsuite.tests.yaml`, refusing what the schema refuses), `Globs` (`**`, `*`, `?`, `..` before the first wildcard), `Identifiers` (spec/test-plan.md rules), `TestPlan` (lint, cases and rows, tags, guard through meta steps, libraries and polled steps; JSON), `Providers` (detection from package references), `CSharpCode`, `MsTestTemplate`, `Generator` (writes only changed files, deletes only its own stale ones, `--check`). |
| `runtimes/csharp/Bdd.Suite/Run/Runner.Generate.cs`, `Cli/CommandLine.cs` | **New verb** `suiterun generate --config <file> [--config ...] [--provider] [--out] [--packages] [--plan \| --check]`. A refusal prints each finding as `path(line,column): error E104: message`, MSBuild's canonical form. |
| `runtimes/csharp/Bdd.Suite.Cli/Program.cs` | UTF-8 console output (spec/test-plan.md: `--plan` is UTF-8). |
| `runtimes/csharp/Bdd.Suite/Actions/CoreActions.cs` | `core.record` appends under a lock: parallel sessions recording at once failed on Windows with a sharing violation otherwise (spec/session.md, rule 7). |
| `runtimes/csharp/Bdd.Suite.Testing/` | **New project.** `BddSuiteRun` (the process's run context: `Start` from run settings then the environment, `Open`, `Stop` writing the trace), `SuiteTests` (a suite's session as a generated class drives it), `build/Bdd.Suite.Testing.targets` (DEC-T10), `README.md`. No test-framework dependency: MSTest's verdicts are in the generated glue. |
| `runtimes/csharp/Bdd.Suite.Tests/GenerateTests.cs`, `Golden/mstest/*.golden` | **New.** 31 tests and the MSTest golden files. |
| `samples/workspace/tests/csharp/` | **New.** `mstest/Shop.Suite.MsTest.csproj` with two configs (`bddsuite.tests.yaml`: the sample suites plus local ones; `corpus.tests.yaml`: the execute corpus), `CorpusExtension.cs`, `suites/order-placement.yml` (guarded), `suites/overlap-{a,b,c}.yml` (E11), `parallel.runsettings`, `scenarios.mjs`, `e13-lab.ps1`; `Directory.Build.props` and `.gitignore` keep build output in `artifacts/`. |
| `samples/workspace/tests/harness/corpus.mjs` | **New.** The shared harness (T2.10) with an MSTest adapter. |
| `conformance/run-manifest.yaml` | `csharp` removed from both `generate` entries' `pendingIn`. |
| `spec/tests.config.schema.json`, `spec/test-plan.md`, `spec/Schema.Tests.ps1` | `contextKeys` added to the config: the generator lints before any extension is loaded, and a suite reading `${store}` would otherwise be refused (E301). The build-error format of a refusal. |

## Decisions made while building

* **The MSTest verdicts live in generated code** (`BddSuite.Run.g.cs`:
  `BddSuiteMsTest.Report`, `AfterEach`, `Teardown`), so `Bdd.Suite.Testing`
  depends on no test framework and NUnit and xUnit (T3) reuse it as it is.
* **A generated class declares only the members the plan reserves**: the field
  is `Session` (a `SuiteTests`), the hooks `Setup`, `Teardown`, `BeforeEach`,
  `AfterEach`, the property `TestContext`. A case can therefore be called
  anything, `case of` included. `[TestInitialize]` finds its case from
  `TestContext.TestName` (the method) through `SuiteTests.CaseOf`.
* **Paths in generated code are absolute** (forward slashes): the files live in
  `obj/`, are written by every build and are never committed. The golden files
  replace the repository's path with `<repo>`.
* **The generator runs on every build** and rewrites only changed files rather
  than using MSBuild `Inputs`/`Outputs`: the suites are named by YAML globs that
  MSBuild cannot read, and a suite added under a glob must appear at the next
  build. An unchanged suite costs one short process and no recompile
  (`TheWriterRewritesOnlyWhatChangedAndRemovesOnlyItsOwnFiles`).
* **Several configs in one project** share one run hook (MSTest allows one
  `[AssemblyInitialize]`); each config's classes are in its own namespace.

## Step by step

| Step | Evidence |
| --- | --- |
| T2.1 `Plan.Build` | `suiterun generate --plan` on `conformance/generate/bddsuite.tests.yaml` equals `plan.expected.json` (compared as JSON, key order ignored) on the first run; unit tests for identifiers (6 names, collisions with reserved and earlier names ignoring case), offline patterns (5), the guard through a library's meta step and a polled step. |
| T2.2 `--plan`, E3, the manifest | `E3EveryGenerateEntryOfTheManifest`: both `generate` entries, the valid one equal to the expected plan, the invalid one exit 2 with exactly `suites/b-broken.yml:8:17 E104`; `csharp` removed from `pendingIn`. |
| T2.3 `Bdd.Suite.Testing` | Built; used by every MSTest run below. |
| T2.4 MSTest template and golden files | `TheMsTestCodeEqualsTheGoldenFiles` (6 files). |
| T2.5 MSBuild targets | The sample project builds and generates 21 classes plus the run hook; an edited, added, renamed and removed case appears or disappears at the next build (E12). The design-time build itself was checked in T0.6; Rider's is out of scope. |
| T2.6 Detection | `TheProviderIsDetectedFromPackageReferences` (5 cases), `TwoFrameworksAreAChoiceTheProjectMakes`; the sample project names no provider and is detected as MSTest. |
| T2.7 `--check` | `CheckSaysWhichFilesAreStaleAndExitsOne`: stale (exit 1, file named), written, up to date (exit 0), a suite that does not lint refused (exit 2). |
| T2.8 Teardown reporting | Throwing from `[ClassCleanup]` as chosen in T0.1: the corpus's `teardown-fails` gives the row `[Corpus.Tests.Suite_TeardownFails ClassCleanup]` Failed and its case Passed. The README's "How results show". |
| T2.9 Sample project | `samples/workspace/tests/csharp/mstest`: 9 sample suites and the 14-entry execute corpus. |
| T2.10 Harness | `node samples/workspace/tests/harness/corpus.mjs --provider mstest`. Shown to fail: with one expected case status changed in `hooks.expected.json` it reported the trace and the outcomes as different; the file was restored. |
| T2.11 E4 | `scenarios.mjs E4`: one case by class and name (setup once, teardown once, the other case untraced); one examples row by `Name=` with `=` escaped (setup and teardown markers once); `TestCategory=smoke` runs exactly the cases the plan tags smoke; a failed setup fails both cases with "Suite setup failed". |
| T2.12 E9 | `scenarios.mjs E9`: `dotnet test --list-tests` lists every planned case and row by its exact name, and nothing else (75 tests). The Visual Studio and Rider check once planned here is out of scope (design 1.3, decided 2026-10-19). |
| T2.13 E10, E11 | E10: without the opt-in the 3 guarded cases are `NotExecuted` with the message naming `BDD_SUITE_ALLOW_GUARDED=1`, their setup and teardown markers absent, the offline suite passed; with the opt-in all 3 passed; the option value given at run time (`BDD_SUITE_OPTION_STORE=outlet-7`) is in no generated file. E11: ten rounds of the three overlap suites with `Workers=4, Scope=MethodLevel`: 9 passed tests each round, and every suite's markers in the order before, start, end, after for each case. |
| T2.14 E12 | `scenarios.mjs E12`: added, renamed and removed cases follow at the next build; `order.place` misspelled fails the build with `order-placement.yml(18,17): error E104` (the canonical form); the suite is restored and unchanged in git. |
| T2.15 E13 written | `samples/workspace/tests/csharp/mstest/e13-lab.ps1`: lab values as run-time parameters, a suiterun reference run, the MSTest run with the opt-in and options from the environment, cases and phase order compared, a summary without secrets. Parses with no errors; PSScriptAnalyzer (Warning, Error): 0 findings. Not run: no lab (stage T9). |

## Final runs (after the last change)

| Run | Result |
| --- | --- |
| `dotnet test` in `runtimes/csharp` | Passed 217, Failed 0 (186 before T2 + 31) |
| `node samples/workspace/tests/harness/corpus.mjs --provider mstest` | 14 corpus entries and 9 sample suites checked; 0 differ |
| `node samples/workspace/tests/csharp/mstest/scenarios.mjs` | E4, E9, E10, E11, E12: 5 of 5 pass |
| `Invoke-Pester spec/Schema.Tests.ps1` | Passed 50, Failed 0 |

## Open

* **E10's "options missing" clause** ("with the opt-in and no options, the
  cases fail with a message naming the missing variables") cannot be met as
  written: the extension API has no way for an extension to declare an option
  required, so the runtime cannot know a value is missing. An extension that
  needs one fails its own actions today. Either the design drops the clause or
  the extension API gains required options (all five runtimes).
* CI has not run any of this.
