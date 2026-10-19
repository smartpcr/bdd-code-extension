# Stage T1 evidence: the C# session

Plan: [docs/test-providers/implementation.md](../test-providers/implementation.md#stage-t1-c-session-p0).
Recorded 2026-10-19 on Windows 11 from `ba971ce` plus the uncommitted T0 and T1
changes, with .NET SDK 10.0.402 (net10.0, warnings as errors). Nothing here
has run in CI.

## What was built

| File | What it is |
| --- | --- |
| `runtimes/csharp/Bdd.Suite/Execution/RunContext.cs` | **New.** The per-process run context (spec/session.md): `Create` (compose and start the extensions once), `ForRun` (over extensions `suiterun` already started), `FromEnvironment` / `FromValues(lookup, ...)` reading `<prefix>OPTION_<FLAG>`, `TAGS`, `DRY_RUN`, `ALLOW_GUARDED`, `TRACE_FILE`, `RECORD_PATH`; `OptionVariable`; `WriteTrace`. |
| `runtimes/csharp/Bdd.Suite/Execution/SuiteSession.cs` | **New.** `Open` (as `suiterun run` opens a file, no lint), `OpenFile` (as a test process does: lints first, `SuiteRefusedException` with the findings), `Cases`, `IsSelected`, `Setup`, `BeforeEach`, `RunCase`, `AfterEach`, `Teardown` (by name, and by index for the whole-file run, which tolerates a duplicate name as it always has), `TeardownResult`, the case lock, the guarded skip. |
| `runtimes/csharp/Bdd.Suite/Execution/Executor.cs` | `RunFile` rebuilt on the session (setup, then each case through beforeEach / runCase / afterEach, then teardown, whose failure is still the extra `teardown` entry). The per-case bag class `RunContext` renamed `CaseContext`, freeing the name for the spec's run context (only this repository's tests used it; os-context's copy is the submodule). `CaseResult` gains `Reason` and `AfterEachFailed`. `RunStep`, `RunHook`, `LimitOf` and the default limits became `internal` for the session. |
| `runtimes/csharp/Bdd.Suite/Model/OrderedMap.cs` | `DeepClone`: every nested map and list copied. |
| `runtimes/csharp/Bdd.Suite/Tracing/Trace.cs` | Every access under a lock; `Entries` returns a copy. |
| `runtimes/csharp/Bdd.Suite.Tests/SessionTests.cs` | **New.** E1 and 19 rule tests (below). |
| `runtimes/csharp/Bdd.Suite.Tests/Where.cs` | The corpus extension implements `fixture.append` (changes its list in place). |
| `runtimes/csharp/Bdd.Suite.Tests/{ExecuteCorpusTests,ConformanceTests}.cs` | 14 execute entries checked, none pending; the corpus's actions are checked against the core plus the corpus extension. |
| `conformance/run-manifest.yaml` | `csharp` removed from `capture-isolation`'s `pendingIn` (now `[go, typescript, powershell]`). |
| `spec/session.md` | Aligned with the build: operations return results and the provider throws; opening for a test process lints first while the whole-file run does not; a guarded skip is traced with reason `guard`; rule 10 for a dry run. |

## Step by step

| Step | Evidence |
| --- | --- |
| T1.1 `RunContext` | `RunContext.Create` composes and starts once; used by `SessionTests` (guarded, trace file) and, through `ForRun`, by every whole-file run. |
| T1.2 `FromEnvironment` and run settings | `FromValues(lookup, ...)` with `FromEnvironment` over the process environment; tests `FromValuesReadsOptionsTagsAndSwitchesUnderThePrefix` (option to an extension's `start`, tags trimmed, dry run, allow guarded, trace file, record path) and `FromValuesDefaultsToNothingAllowedAndUsesTheExtensionsPrefix` (an extension's own prefix wins; defaults). **A `.runsettings` file is not read here**: MSTest and NUnit hand their run parameters to test code at run time, so the provider (T2, T3) passes a lookup over them that falls back to the environment. |
| T1.3 `Open` | `Open` and `OpenFile`; test `OpenFileRefusesASuiteThatDoesNotLintClean` (E104 refused with findings; a clean file opened, cases listed, selection read). |
| T1.4 `Setup` | `Rule2SetupRunsOnceHoweverOftenItIsCalled`, `Rule2NothingSelectedRunsNeitherSetupNorTeardown`, `Rule2BeforeEachRunsTheSetupWhenNoClassHookDid`, `Rule3AFailedSetupIsRecordedAndEveryCaseReportsIt`. |
| T1.5 `BeforeEach` | `Rule3AFailedBeforeEachIsRecordedAndTheCaseStillCleansUp`; the lock in `Rule7OneCaseOfASessionRunsAtATime`. |
| T1.6 `RunCase` | Deep copy: `Rule5ACaseStartsFromADeepCopyOfTheSetupBag` and the corpus entry `capture-isolation` (below). Recorded failures: the two rule 3 tests. |
| T1.7 `AfterEach` | `Rule4AFailedAfterEachSettlesTheCaseAndSaysSo`, `Rule4AnAfterEachWithoutTheCaseStillCleansUpAndFails`; order refused in `Rule1OperationsOutOfOrderAreRefused`; lock released in `finally`. |
| T1.8 `Teardown` | `Rule6TeardownRunsOnceAndOnlyAfterASetup`, `Rule6AFailedTeardownIsReturnedNotThrown`; the whole-file `teardown` entry by the corpus entry `teardown-fails`. |
| T1.9 `Trace` | `TheTraceTakesEntriesFromManyThreads` (1,000 parallel adds); `WriteTraceWritesTheTraceWhereTheRunContextSays`. |
| T1.10 `RunFile` on the session | Every existing C# test passes unchanged in its assertions (166), including the 13 previously checked execute entries byte for byte. |
| T1.11 Unit tests and E1 | `E1EveryExecuteEntryThroughTheSessionInFileOrderAndReversed`: all 14 execute entries driven as a framework drives them (class-hook setup, each case, class-hook teardown); in file order the trace equals the expectation; with the cases reversed it equals the expectation with each case's entries moved as a group; the case results equal the whole-file run's. Also `Rule9AGuardedSuiteSkipsUnlessTheRunAllowsIt`, `ADryRunValidatesAndTracesNothing`. |
| T1.12 E2 | See below. |

## The deep copy is what makes `capture-isolation` pass

With `fixture.append` implemented, `capture-isolation` passes. To show the
entry can fail, the case scope was temporarily built with the old one-level
copy: the execute corpus test then failed (`Failed: 1, Passed: 1` for the two
execute-corpus tests) and passed again once the deep copy was restored.

## Test runs

| Run | Command | Result |
| --- | --- | --- |
| C# | `dotnet test` in `runtimes/csharp` | Passed 186, Failed 0 (166 existing + 20 new) |
| Session tests | `dotnet test --filter FullyQualifiedName~SessionTests` | Passed 20, Failed 0 |
| Divergence check | not run | It patches the Go and TypeScript runtimes only; neither changed in T1, so a run would prove nothing about this change. |
| VS Code integration suite | `npm run test:integration` (builds the sample workspace's C# binding against this runtime, then drives a real VS Code) | exit 0: node tests 14 passed; VS Code suites 28 + 1 + 61 + 5 passing, 0 failing, 1 pending (B9.2, which runs only with `--vsix`, by design) |

## Open

* CI has not run any of this.
* The `.runsettings` lookup is the provider's (T2, T3).
