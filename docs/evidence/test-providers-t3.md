# Stage T3 evidence: NUnit and xUnit

Plan: [docs/test-providers/implementation.md](../test-providers/implementation.md#stage-t3-nunit-and-xunit-p1).
Recorded 2026-10-19 on Windows 11, .NET SDK 10.0.402, NUnit 4.6.1 with
NUnit3TestAdapter 6.3.1, xunit.v3 3.2.1 with xunit.runner.visualstudio 3.1.5,
Microsoft.NET.Test.Sdk 18.11.0 (the versions the T0 spike tested). Nothing here
has run in CI.

## What was built

| Where | What |
| --- | --- |
| `runtimes/csharp/Bdd.Suite/Testing/NUnitTemplate.cs` | **New.** One `[TestFixture] Suite_<id>` per suite: `[OneTimeSetUp] Setup`, `[OneTimeTearDown] Teardown`, `[SetUp] BeforeEach`, `[TearDown] AfterEach` (the case from `TestContext.CurrentContext.Test.MethodName`), one parameterless method per case and row with `[TestCase(TestName = ...)]` and `[Category]` per tag; the run hook a `[SetUpFixture]` in the global namespace (run settings through `TestContext.Parameters`); verdicts `Assert.Ignore` / `Assert.Fail`. |
| `runtimes/csharp/Bdd.Suite/Testing/XUnitTemplate.cs` | **New.** Per suite a class fixture `Suite_<id>_Fixture : IAsyncLifetime` (suite setup and teardown) and `Suite_<id> : IClassFixture<...>, IAsyncLifetime` whose explicit `InitializeAsync` / `DisposeAsync` run beforeEach and afterEach (the case from `TestContext.Current.TestMethod.MethodName`), one `[Fact(DisplayName = ...)]` per case and row, `[Trait("Category", ...)]` per tag; the run hook an assembly fixture; verdicts `Assert.Skip` / `Assert.Fail`. |
| `runtimes/csharp/Bdd.Suite/Testing/{CSharpCode,MsTestTemplate,Generator}.cs` | The session-opening statement, XML text, sources and extensions moved into `CSharpCode` and shared by the three templates; `Generator.Render` picks the template by provider. The MSTest golden files are byte-for-byte unchanged by the move. |
| `runtimes/csharp/Bdd.Suite.Tests/GenerateTests.cs`, `Golden/{nunit,xunit}/` | The golden test runs for all three providers; a provider the C# runtime does not have is refused. |
| `samples/workspace/tests/csharp/shared/` | The two configs, `CorpusExtension.cs` (now `Shop.Suite.Testing`) and the local suites, moved from `mstest/` so the three projects run the same suites. |
| `samples/workspace/tests/csharp/{nunit,xunit}/` | **New** projects; `nunit/Parallel.cs` makes fixtures and their tests parallel on four workers (NUnit's most parallel setting, E11). |
| `samples/workspace/tests/harness/corpus.mjs` | NUnit and xUnit adapters; a teardown failure is read from TRX `RunInfo` for both. **Trace comparison changed** (below). |
| `samples/workspace/tests/csharp/scenarios.mjs` | Moved from `mstest/`; `--provider` with each framework's filter syntax and most parallel setting. |
| `runtimes/csharp/Bdd.Suite.Testing/README.md` | The three providers. |
| `docs/test-providers/design.md` | DEC-T12: how traces are compared when a framework orders cases itself. |

## A finding: frameworks choose the order of cases

NUnit (with the sample's parallel setting) and xUnit (always) ran a suite's
cases in an order other than the file's. Every case outcome matched, but six
corpus traces differed from their expectations only in the order of the case
groups. The suite rules do not fix that order (each case starts from its own
copy of the setup's captures; spec/session.md rules 1, 5 and 7), and E1 already
showed the session gives the same entries in any order. The harness now
compares a trace as: the setup's entries first and the teardown's last,
exactly, and each case's entries as one unbroken group, exactly, in any order.
Interleaved cases would split a group and fail. Shown to still fail: with one
expected beforeEach status changed in `hooks.expected.json`, the xUnit run of
that entry was reported as differing; the file was restored. MSTest (which ran
in file order) passes either way.

## Step by step

| Step | Evidence |
| --- | --- |
| T3.1 NUnit template, golden files, `[SetUpFixture]` | `EachProvidersCodeEqualsTheGoldenFiles(nunit)`; the NUnit project builds with warnings as errors and runs 75 tests. |
| T3.2 NUnit teardown reporting | The corpus's `teardown-fails` through NUnit: its case Passed; the run-level error "TearDown failed for test fixture Corpus.Tests.Suite_TeardownFails" in the TRX; checked by the harness's NUnit adapter. |
| T3.3 NUnit project; E4, E10, E11 | `scenarios.mjs --provider nunit E4 E9 E10 E11`: 4 of 4 pass (E9 run as well). |
| T3.4 xUnit template, golden files, fixtures | `EachProvidersCodeEqualsTheGoldenFiles(xunit)`; the xUnit project builds with warnings as errors and runs 75 tests. |
| T3.5 xUnit skip and traits | E10 (guarded cases `NotExecuted` with the opt-in message, through `Assert.Skip`); E4's tag filter `Category=smoke` selects exactly the cases the plan tags smoke (`[Trait("Category", ...)]`). |
| T3.6 xUnit project; E4, E10, E11 | `scenarios.mjs --provider xunit E4 E9 E10 E11`: 4 of 4 pass. |

The parallel runs were really parallel: in one overlap run each provider had
three cases running at once at its peak, never two of one suite (MSTest with
`Workers=4, Scope=MethodLevel` 4 starts while another suite ran; NUnit 6;
xUnit 6).

## Runs

| Run | Result |
| --- | --- |
| `node samples/workspace/tests/harness/corpus.mjs --provider nunit` | 14 corpus entries and 9 sample suites checked; 0 differ |
| `node samples/workspace/tests/harness/corpus.mjs --provider xunit` | 14 corpus entries and 9 sample suites checked; 0 differ |
| `node samples/workspace/tests/csharp/scenarios.mjs --provider nunit E4 E9 E10 E11` | 4 of 4 pass |
| `node samples/workspace/tests/csharp/scenarios.mjs --provider xunit E4 E9 E10 E11` | 4 of 4 pass |
| After the last change: `dotnet test` in `runtimes/csharp`; the MSTest harness and all five MSTest scenarios (the MSTest project moved to `shared/` and the harness changed) | C#: Passed 220, Failed 0; MSTest harness: 14 corpus entries and 9 sample suites, 0 differ; MSTest scenarios E4, E9, E10, E11, E12: 5 of 5 pass |

## Open

* E10's "options missing" clause, as in T2 (the extension API has no required
  options).
* NUnit's `TestName` treats `{`...`}` sequences as name templates (`{m}`, `{a}`),
  so a case name containing braces would be rewritten in NUnit's report; no
  suite here has one. The session is still called with the exact name.
* CI has not run any of this.
