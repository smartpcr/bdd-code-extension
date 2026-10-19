# Stage T0 evidence: spikes and the shared contract

Plan: [docs/test-providers/implementation.md](../test-providers/implementation.md#stage-t0-spikes-and-the-shared-contract-p0).
Recorded 2026-10-19 on Windows 11, from `ba971ce` plus the uncommitted T0
changes, with .NET SDK 10.0.402, Node.js 24.16.0, Go 1.27.0, Rust 1.96.0,
PowerShell 7 with Pester 5.7.1. The spikes were run by five agents in parallel;
their projects, scripts and result files are under `spikes/test-providers/`
(build output ignored by `.gitignore`) so each finding can be re-run. Nothing
here was run in CI, and no Visual Studio, Rider or VS Code test-explorer UI was
checked; Visual Studio and Rider are out of scope (design 1.3, decided 2026-10-19).

## Spike findings (T0.1-T0.8)

### T0.1, T0.5, T0.6: MSTest

Versions: MSTest.TestFramework/TestAdapter 4.3.2 with Microsoft.NET.Test.Sdk
18.4.0, and 3.8.3 with 17.13.0 for comparison. `spikes/test-providers/mstest/`,
re-run with `tools/run.ps1 <Proj> <ver> <Variant> <tag>`; TRX in `results/`.

| Question | Finding |
| --- | --- |
| A throwing `[ClassCleanup]` (T0.1) | **4.3.2:** its own row `[Q1.SuiteA ClassCleanup]`, Failed; the class's tests stay Passed; run Failed, exit 1. The row **reuses the testId of the class's last test**, so a TRX reader must match by test name (`^\[(.+) ClassCleanup\]$`), not by id. `ClassCleanupBehavior`/`ClassCleanupExecution` no longer exist in 4.x. **3.8.3:** the failure is merged into a passed test of the same or another class, which then fails. |
| A throwing `[AssemblyCleanup]` | 4.3.2: the last test run gets a second, Failed result with the same name and id ("Assembly Cleanup method ... failed"); its Passed row remains; exit 1. Writing to `TestContext`/stdout does not fail the run; `Environment.Exit` loses every result. Throwing is the only way to fail the run. |
| Failing initialize hooks | `[TestInitialize]` throws: body skipped, `[TestCleanup]` runs. `[ClassInitialize]` throws: every test fails, `[ClassCleanup]` runs. Same in 3.8.3. |
| Display names (T0.5) | TRX, `--list-tests` and console show `places an order`, `rejects [qty=0]`, `cancel = refund [full], then (re)check` exactly. **4.x: `[TestMethod("x")]` binds to `[CallerFilePath]` and silently keeps the method name** (only warning MSTEST0056); `[TestMethod(DisplayName = "x")]` is the form. 3.8.3 has no `DisplayName =` (CS0617). |
| Filters | `Name~places`, `FullyQualifiedName~OrderSuite`, `TestCategory=smoke` work; `Name=rejects [qty\=0]` selects one `DataRow`; `= ( ) ! ~ & \|` must be escaped, else "Incorrect format for TestCaseFilter", exit 1. `FullyQualifiedName` cannot pick one `DataRow`. `DisplayName=` is not a filter property (matches nothing, exit 0). |
| Generation target (T0.6) | An incremental target (Inputs `*.yml`, Outputs `obj/.../BddSuite/*.g.cs`) with **`BeforeTargets="BeforeCompile"`**: builds and runs; no-op build skips it; an edited YAML regenerates only its file. With `BeforeTargets="CoreCompile"`, **deleting a YAML leaves a stale test in the dll**. Design-time build: `dotnet msbuild -p:DesignTimeBuild=true -t:Compile -getItem:Compile` and Visual Studio 18's `MSBuild.exe -t:CompileDesignTime` both generate the files and list them in `Compile`. |
| Method-level parallelism | `[assembly: Parallelize(Workers = 4, Scope = MethodLevel)]` runs `[TestInitialize]`/`[TestCleanup]` of different methods of one class concurrently (4 at once observed). |

### T0.2: NUnit 4

Versions: NUnit 4.6.1, NUnit3TestAdapter 6.3.1, Microsoft.NET.Test.Sdk
18.11.0. `spikes/test-providers/nunit-xunit/NUnitSpike`, `run.sh`; evidence in
`out/<label>/`.

| Question | Finding |
| --- | --- |
| A throwing `[OneTimeTearDown]` | Tests stay Passed (`passed=2 failed=0`); TRX `ResultSummary outcome="Failed"` with `RunInfo outcome="Error"` "TearDown failed for test fixture ..."; no extra test row; exit 1. The console still says "Passed! - Failed: 0", so a reader must use the RunInfos and exit code. |
| Exact names | `[TestCase(TestName = "places an order")]` on a parameterless method and `[TestCase("rejects [qty=0]", TestName = ...)]` both give the exact name in TRX and `--list-tests`. |
| Filters | **`Name=` with a space throws in the adapter ("Unexpected Word")**; `=` likewise. `FullyQualifiedName=<Ns.Class.Method>` works (the full name stays the method's); `TestCategory=` works for `[Category]`; `NUnit.Where=name == '...'` works exactly. |
| Failing set-up | `[SetUp]` throws: `[TearDown]` runs. `[OneTimeSetUp]` throws: bodies, SetUp and TearDown do not run, every test fails, `[OneTimeTearDown]` runs. |
| Run hook, skip | A root `[SetUpFixture]` runs once around all fixtures; its throwing teardown keeps tests Passed with a RunInfo error and exit 1. `Assert.Ignore("reason")` is NotExecuted with the reason. |

### T0.3: xUnit v3

Versions: xunit.v3 3.2.1, xunit.runner.visualstudio 3.1.5 (4.x exists on the
feed and was not tested). `spikes/test-providers/nunit-xunit/XunitSpike`.

| Question | Finding |
| --- | --- |
| Class fixture `DisposeAsync` throws | Tests Passed; TRX RunInfo "[Test Class Cleanup Failure (...)]"; run Failed; exit 1. Assembly fixture: the same with "[Test Assembly Cleanup Failure]". |
| Constructor (beforeEach) throws | **`Dispose`/`DisposeAsync` are not called**; a throwing test-class `InitializeAsync` also skips `DisposeAsync`. |
| Display names | `[Fact(DisplayName = ...)]` is exact. **A Theory row's display name gets its arguments appended** (`rejects [qty=0](name: "rejects [qty=0]")`) with `InlineData(TestDisplayName=)` or `TheoryDataRow`. One `[Fact]` per row is exact. |
| Filters | `DisplayName=` with `= ( ) \| & ! ~ \` escaped, `FullyQualifiedName=`, `Category=` for `[Trait("Category", ...)]` work; `Name=`/`TestCategory=` match nothing. **An unescaped filter, or one matching nothing, reports 0 tests and exits 0.** |
| Skip, parallelism | `Assert.Skip("reason")`: NotExecuted with reason, exit 0. Tests of one class run one at a time; different classes run in parallel. |

### T0.4: Jest, Vitest, `node:test`

Versions: Jest 30.5.2 with jest-junit, Vitest 5.0.4, Node.js 24.16.0.
`spikes/test-providers/js/`, commands in `README.txt`, JUnit XML in `out/`.

| Question | Jest | Vitest | `node:test` |
| --- | --- | --- | --- |
| `afterAll` throws after two passing tests | Tests passed, run failed (exit 1); jest-junit adds a made-up test case " Test execution failure: could be caused by test hooks like 'afterAll'." whose counts disagree | Tests passed, exit 1; a separate JUnit test case named after the describe carries the failure (cleanest) | Tests passed, exit 1; **the built-in JUnit reporter drops the failure entirely**; a custom reporter receives `test:fail` with `type=suite` |
| `beforeAll` throws (not used: setup does not throw) | cases failed, `afterAll` runs | cases skipped plus a suite failure, `afterAll` runs | cases cancelled, `after` runs |
| Name filters | unanchored regex on "describe test" | unanchored regex on "describe > test"; also `file:line` | regex on the name or "describe test" |
| Hooks when nothing in a describe matches | not run | not run | not run |
| Module state | **per test file** (not per worker); `maxWorkers` is global only | per file by default (`isolate: true`); `isolate: false, maxWorkers: 1` per project shares it | a process per file; `--test-isolation=none` shares |
| Runtime skip with a reason | **none**; decide at load time with `it.skip` | `ctx.skip(reason)` in a test or `beforeEach` (reason not in JUnit) | `t.skip(reason)` in the test, then `return` (it does not throw; in `beforeEach` the body still runs) |
| Listing | `--listTests` lists files; a `-t` that matches nothing with `--json` lists tests | `vitest list --json` with locations | none |

### T0.7: Rust harness

Version: libtest-mimic 0.8.2 (pinned `=0.8.2`). `spikes/test-providers/rust/`,
harness in `tests/bdd.rs`.

| Question | Finding |
| --- | --- |
| Selection before running | Public `Arguments::is_filtered_out(&Trial)` and `is_ignored`; a probe trial per unit predicts the selection, and it matched libtest-mimic's own decision for all 14 argument combinations tried (`--exact`, `--skip`, `--ignored`, `--include-ignored`, filters with `[`, `=`). |
| Order within a suite | `--test-threads 1` serialises everything (1.23 s against 0.45 s at 8 threads). A **per-suite turnstile** (mutex + condvar on a turn number given only to units that will run, a drop guard advancing it on panic) keeps a suite's units in order and never overlapping (100 runs at 8 threads) while suites run in parallel. Units may hop threads (no thread-local suite state). It relies on 0.8.2 dispatching trials in `Vec` order: keep the pin. One trial reporting several results is not possible. |
| Teardown | A `<suite>::teardown` trial as the last turn reports teardown's result as its own pass/fail; cases keep theirs. **If that trial is filtered out, the last executing case runs teardown after its body**, prints the failure to stderr and the harness exits 101 (cases still `ok`). Selecting only teardown trials runs neither hook. |
| Output | `--list` (`name: test`), `--format terse`, and **`--format json` on stable**, `--logfile` for a file; no per-test duration, no JUnit, no output capture. `cargo test -- --format json` across all targets fails on the plain libtest targets: scope it with `--test <target>`. |
| Other targets | Unaffected: unit tests, a plain `#[test]` target and doc-tests run as before. |

### T0.8: Pester 5

Version: Pester 5.7.1 (`Import-Module Pester -MinimumVersion 5.0`).
`spikes/test-providers/pester/`, runners `run-q*.ps1`, XML in `out/`.

| Question | Finding |
| --- | --- |
| Names | `[ ] = * ?` and backticks render exactly; discovery is deterministic. **`<` and `>` in a literal name are template placeholders** (`It 'a < b and c > d'` fails); escape them with a backtick. Row data is not re-expanded. |
| `AfterAll` throws | Tests Passed; run Failed; `FailedBlocksCount=1`; `-CI` exit 1. **The default NUnit 2.5 output shows everything as Success**; NUnit3 output shows the fixture `result="Failed" site="TearDown"` with the tests Passed. |
| Failing set-up | `BeforeAll` throws: Its fail without running, `AfterAll` runs. `BeforeEach` throws: that It fails, `AfterEach` runs. |
| Filters | `-FullNameFilter`/`Filter.FullName` are wildcards: escape with `[WildcardPattern]::Escape`. **A single `-ForEach` row cannot be selected by its rendered name** (filters match the template). With a tag or name filter that selects nothing in a Describe, neither `BeforeAll` nor `AfterAll` runs. |
| Skip | `Set-ItResult -Skipped -Because` works in It and BeforeEach; NUnit3 keeps the reason. |
| Run-wide state | A module imported without `-Force` keeps `$script:` state across containers and across `Invoke-Pester` calls in the same session; a driver must reset it (remove the module) after the run. |

## What changed in the design (T0.9)

Each change is made in [design.md](../test-providers/design.md) and
[implementation.md](../test-providers/implementation.md):

* **MSTest 4 is the minimum** (DEC-T05). In 3.x a failed class cleanup turns a
  passed test into a failed one, which the suite rules forbid. Display names
  use `[TestMethod(DisplayName = ...)]`.
* **One test per examples row in NUnit, xUnit and Pester** (DEC-T05). NUnit's
  name filter breaks on spaces, so single tests are selected by method;
  xUnit appends arguments to a Theory row's name; Pester cannot select a
  `-ForEach` row. MSTest keeps `[DataRow]` (one row is selectable by `Name=`).
* **Where each provider shows a failed teardown** is now known (DEC-T05): its own
  row (MSTest 4, sharing the last test's id), a run-level error (NUnit, xUnit),
  the parent test (Go), the teardown trial or stderr with exit 101 (Rust), a
  suite entry (Vitest, Pester NUnit3), a synthetic test case (Jest), and a
  custom reporter for `node:test`, whose JUnit reporter drops it. Passed cases
  stay passed in every provider tested.
* **Result readers** must read run-level errors (TRX RunInfos, Pester
  `FailedBlocks`, the exit code) and must treat zero executed tests as an
  error (xUnit and the JavaScript runners exit 0 when a filter matches nothing)
  (DEC-T12).
* **JavaScript run context per test file**, not per worker (DEC-T08): Jest,
  Vitest (default) and `node:test` all give each file its own module state.
* **Jest skips at load time** (DEC-T09): guarded and tag-filtered tests are
  declared with `it.skip`, because Jest has no runtime skip.
* **C# generates `BeforeTargets="BeforeCompile"`** (DEC-T10), with an incremental
  generate target and an always-run target adding the files to `Compile`.
* **Rust: the turnstile, the teardown trial, and teardown run by the last case
  when that trial is filtered out; libtest-mimic pinned at 0.8.2** (DEC-T11).
* **Pester: NUnit3 output, one It per row, escaped `<` `>` in names, the
  module-state pattern** (DEC-T05, DEC-T08).

## The shared contract (T0.10-T0.14)

| Step | What was done | Evidence |
| --- | --- | --- |
| T0.10 | `spec/session.md`: operations, rules 1-9, environment inputs. Rule 4 corrected after reading the runners: an afterEach failure makes the case `failed` with reason `hook`, the `case` trace entry is written after afterEach, and `afterEach` reports its failure by throwing. | file |
| T0.11 | `spec/tests.config.schema.json`, `spec/test-plan.schema.json`, `spec/test-plan.md`; 19 new assertions in `spec/Schema.Tests.ps1` (both corpus configs accepted, a full config accepted, nine bad configs refused, the expected plan accepted, four bad plans refused, manifest files exist). | `Invoke-Pester spec/Schema.Tests.ps1`: Passed 50, Failed 0 |
| T0.12 | `execute/nothing-selected.yml` (a tag filter that selects nothing: no setup, no teardown, both cases skipped). The design said "a name filter"; no runtime has one, and a tag filter is the same rule. All five runtimes' `suiterun run` produced the expected trace before any change. | traces compared by hand for C#, Go, Rust, TypeScript, PowerShell |
| T0.12 | `execute/capture-isolation.yml`. With core actions alone the shallow copy cannot be observed (no core action changes a value in place), so the corpus catalog declares `fixture.append`, which each runtime's corpus test extension implements by changing its list in place. Rust's extension implements it; Rust passes the entry. C#, Go, TypeScript and PowerShell are `pendingIn` until their session stages. | Rust `conformance_execute`: 14 run, 0 differ |
| T0.13 | `conformance/generate/`: a config, eight suite files (one library left out, one excluded folder, one nested), `plan.expected.json` (5 suites, 15 cases), and an invalid config whose second suite has `E104` at 8:17. All suites lint clean (TypeScript); the case lists from `suiterun list` are identical in all five runtimes (C# and PowerShell differ only in how the console encodes `é`, so `--plan` is specified as UTF-8). The identifiers were re-derived from the written rules by a throw-away script: 0 mismatches. | as stated |
| T0.14 | `conformance/run-manifest.yaml`: `generate` is a separate top-level list (C# and Go refuse unknown entry kinds, so `entries` could not hold it); `pendingIn` on the new entries. The C#, Go, TypeScript and PowerShell corpus tests skip entries pending for them and report them; execute counts updated from 12 to 14 and the corpus catalog's action count from 12 to 13. | below |

Test runs after the last contract change (inputs: the manifest, the corpus
catalog and schema, the corpus tests):

| Runtime | Command | Result |
| --- | --- | --- |
| C# | `dotnet test` (runtimes/csharp) | Passed 166, Failed 0 |
| Go | `go test ./...` (runtimes/go) | every package ok |
| Rust | `cargo test` (runtimes/rust) | every target ok (137 unit tests; corpus 6 + 1 + 2) |
| TypeScript | `npm test` (full, 100% lines) before the manifest's `generate` list; `node --test dist-test/test/conformance/*.test.js` after it | pass; pass 10, fail 0; 13 execute entries run, 1 pending |
| PowerShell | `Conformance.Tests.ps1 -RunHarness`; `Invoke-Pester runtimes/powershell/tests` | 1536 assertions: 41 validate, 13 execute (1 pending), 7 reports; Pester Passed 84, Failed 0 |
| spec | `Invoke-Pester spec/Schema.Tests.ps1` | Passed 50, Failed 0 |

## Open

* Visual Studio and Rider test explorers are out of scope (design 1.3).
* xUnit v3 4.x and the Microsoft.Testing.Platform runner mode were not tried.
* CI has not run any of this.
