# Running suites with each language's own test framework: design

Status: **designed 2026-10-19; stage T0 built the same day** (spikes and the
shared contract, [evidence](../evidence/test-providers-t0.md)); no session,
generator or provider built yet. The plan that builds it is
[implementation.md](implementation.md). Every outcome here links to the
deliverables that produce it and the scenarios that prove it. The spike
findings are folded into the decisions below; each revised decision says
"(T0)" where a finding changed it.

Audience: anyone who writes suites or bindings and wants `dotnet test`,
`go test`, `cargo test`, `npm test` or `Invoke-Pester` to run them; runtime
maintainers in all five languages; reviewers. No knowledge of the runtimes'
source is assumed. The suite words (suite, case, action, binding, runtime,
catalog, extension) mean what [the self-contained design](../self-contained/design.md#vocabulary)
says; the words below are new.

## Contents

* [Vocabulary](#vocabulary)
* [1. What we want to achieve](#1-what-we-want-to-achieve)
* [2. What exists today](#2-what-exists-today)
* [3. The shape of the result](#3-the-shape-of-the-result)
* [4. Decisions](#4-decisions)
* [5. Failure, rollback and cleanup](#5-failure-rollback-and-cleanup)
* [6. Verification](#6-verification)
* [7. Traceability](#7-traceability)

## Vocabulary

| Word | Meaning, and why it matters here |
| --- | --- |
| **Test framework** (or **provider**) | The library and runner a language's developers already use to write and run tests: MSTest, NUnit or xUnit for C#; Go's `testing` package; Rust's test harness; `node:test`, Vitest or Jest for TypeScript; Pester for PowerShell. "Test provider support" means each suite case runs as one of that framework's tests. |
| **Lifecycle hooks** | The places a framework lets code run around tests: once per class/file (`[ClassInitialize]`/`[ClassCleanup]`, `beforeAll`/`afterAll`), around each test (`[TestInitialize]`/`[TestCleanup]`, `beforeEach`/`afterEach`), and once per test process (`[AssemblyInitialize]`). Each maps to a suite phase. |
| **Suite phases** | The six phases a suite runs, in this order (pinned by `conformance/execute/hooks.yml`): suite **setup** (once, before the first selected case), **beforeEach**, case **setup**, the case's **steps**, case **cleanup**, **afterEach**, and suite **teardown** (once, after the last case, even if cases failed). |
| **Capture bag** | The values steps publish with `captureAs`. Suite setup fills one; every case starts from its own copy, so one case cannot see another's captures. |
| **Session** | New: an object in each runtime that holds one suite file's state across separate calls (parsed suite, started extensions, setup's capture bag, which phases ran) so a framework can call setup, one case, and teardown at different times. Today a whole file runs in one call; the session splits that call without changing what it does. |
| **Run context** | New: the per-test-process state a session belongs to: the composed extensions and their started state, the schema, options and parameters. `suiterun` creates one per invocation; a test process creates one at assembly/package start. |
| **Generator** | New: `suiterun generate`, in each runtime, which reads suite files and writes test source code for one framework: one test class (or file, or function) per suite and one test per case, with the hooks wired to the session. |
| **Test plan** | New: the language-independent list a generator renders: for each suite, its file, display name, and for each case and examples row its exact name, a safe identifier, its tags and whether it is guarded. Five generators render the same plan, which is how they are kept in agreement. |
| **Guarded suite** | A suite that uses an action not on the configured offline list, so running it may touch a lab or other real environment. A guarded test skips unless the run explicitly opts in ([DEC-T09](#dec-t09)), so `dotnet test` in CI cannot reach a lab by accident. |
| **Spike** | A short experiment that checks an assumption about a framework before it is built on; its result is a written finding. |

## 1. What we want to achieve

### 1.1 The problem

Suites run only through each binding's `suiterun` program (or the VS Code
extension, which calls it). Teams already run their unit tests with
`dotnet test`, `go test`, `cargo test`, `npm test` or `Invoke-Pester`, in CI
pipelines, coverage tools, IDE test explorers (Visual Studio, Rider, VS Code's
C#, Go and Vitest extensions) and test-result dashboards. Suites stay outside
all of that: they need a separate CI step, their results are not in the same
report, a single case cannot be run from the IDE's test explorer, and a C#
developer cannot set a breakpoint in an action and press *Debug Test*.

The cause is structural. Every runtime runs a whole suite file in one call
(`runFile` / `RunFile` / `run_file` / `Invoke-BddSuite`); setup, one case and
teardown cannot be called separately, which is what a framework needs. And
nothing generates the framework's test declarations (`[TestClass]`,
`[TestMethod]`, `t.Run`, `#[test]`, `it`, `It`).

### 1.2 Outcomes

| ID | Outcome (observable) | Built by | Proved by |
| --- | --- | --- | --- |
| <a id="o1"></a>**O1** | **Each runtime can run a suite's phases separately**, through a session, with exactly the results and trace a whole-file run produces; `suiterun` itself runs through the session, so the command line and native tests cannot disagree. | [D1](implementation.md#d1), [D2](implementation.md#d2), [D7](implementation.md#d7), [D9](implementation.md#d9), [D11](implementation.md#d11), [D13](implementation.md#d13) | [E1](#e1), [E2](#e2) |
| <a id="o2"></a>**O2** | **C# suites run as MSTest, NUnit or xUnit tests.** For each suite file the build generates a test class: `[TestClass]`, `[ClassInitialize]`/`[ClassCleanup]` for suite setup/teardown, `[TestInitialize]`/`[TestCleanup]` for beforeEach/afterEach, one `[TestMethod]` per case with `[DataRow]` per examples row, `[TestCategory]` per tag, and `[AssemblyInitialize]`/`[AssemblyCleanup]` for the run context (and the NUnit and xUnit equivalents). | [D3](implementation.md#d3)–[D6](implementation.md#d6) | [E3](#e3), [E4](#e4), [E9](#e9) |
| <a id="o3"></a>**O3** | **Go, Rust, TypeScript and PowerShell suites run under `go test`, `cargo test`, `node:test`/Vitest/Jest and Pester**, with the same mapping in each language's idiom. | [D8](implementation.md#d8), [D10](implementation.md#d10), [D12](implementation.md#d12), [D14](implementation.md#d14) | [E3](#e3), [E5](#e5)–[E9](#e9) |
| <a id="o4"></a>**O4** | **A native run keeps the suite's rules**: the six phases in order with their failure rules (the execute corpus), selection by name and tag with setup and teardown once around what is selected, cases of one suite never overlapping, and guarded suites never running without an explicit opt-in. | [D1](implementation.md#d1), every session and provider | [E1](#e1), [E4](#e4)–[E8](#e8), [E10](#e10), [E11](#e11), [E13](#e13) |
| <a id="o5"></a>**O5** | **Generated tests stay in step with the YAML and are found by the usual tools**: a suite edit is reflected at the next build or fails a check; each framework's list command shows one test per case and row (IDE test explorers are out of scope, 1.3). | [D3](implementation.md#d3), [D8](implementation.md#d8), [D10](implementation.md#d10), [D12](implementation.md#d12), [D14](implementation.md#d14), [D15](implementation.md#d15) | [E9](#e9), [E12](#e12) |

### 1.3 Scope and non-goals

In scope: a session API in all five runtimes; a generator per runtime; these
providers: **MSTest, NUnit, xUnit v3** (C#), **`testing`** (Go), **libtest via
a custom harness** (Rust), **`node:test`, Vitest, Jest** (TypeScript), **Pester
5** (PowerShell); the shared spec, corpus and CI for all of it.

Not in scope:

* **Visual Studio and Rider.** How their test explorers show, run and debug the
  generated tests, and their design-time builds, are deferred and not checked
  here (decided 2026-10-19). The generated tests are ordinary framework tests,
  so the frameworks' own command lines (`dotnet test`, `--list-tests`) are
  what this work proves.

* **Changing what a suite means.** No phase order, failure rule, finding code
  or trace field changes, with one exception made explicit and tested:
  [DEC-T04](#dec-t04) makes the per-case copy of the capture bag deep in all
  five runtimes, as Rust's already is.
* **Replacing `suiterun`.** It stays the reference runner and the VS Code
  extension keeps using it.
* **MSTest 3, xUnit v2, NUnit 3, Pester 4.** These older majors are not
  planned (MSTest 3 cannot keep a passed case passed when a
  suite teardown fails, T0).
* **Step-level test results.** A framework reports per case; steps appear in
  the case's output and failure message, as in `suiterun`'s reports today.

## 2. What exists today

Surveyed on `main` at `48d9355`, 2026-10-19 (paths relative to `runtimes/`).

| | Whole-file entry point | Phases callable separately? | Case selection | Per-case capture copy | Shared state that matters for native tests |
| --- | --- | --- | --- | --- | --- |
| C# | `Executor.RunFile` (`csharp/Bdd.Suite/Execution/Executor.cs:478`) | no: `RunHook`, `RunCase`, `RunStep`, `CloneScope` are private | tags only | one level (`Executor.cs:736`) | `Trace` is an unsynchronised list; extension state per run |
| Go | `exec.RunFile` (`go/suite/exec/exec.go:486`) | no: helpers unexported; scope builders in `internal/suite` | tags only | one level (`exec.go:731`) | unsynchronised `Trace` and `expr.minted` counter |
| Rust | `exec::run_file` (`rust/src/exec.rs:454`) | no: `Context`, `run_hook`, `run_step` private | tags only | deep (`exec.rs:556`) | none static; `cli::Options` not constructible outside |
| TypeScript | `runFile` (`typescript/src/exec.ts:286`), not exported | no | tags only | one level (`exec.ts:261`) | `declaredIn` reset per schema load |
| PowerShell | `Invoke-BddSuite` (`powershell/BddSuite/Runner.ps1:521`) | no: `-TestName` picks one case but still runs setup and teardown around it | tags and `-TestName` | one level (`Runner.ps1:816`) | `$script:RunState` reset per call |

Common to all five: an examples row is its own case named
`<name> [col=value, ...]`; a failed suite setup marks every selected case
`error`; a failed teardown is appended as a pseudo-case named `teardown`;
extensions are started once per run and their state is shared by every case.
No runtime generates test code; the only generators in the repository are the
schema generator and the VS Code extension's action stubs (`templates/`). The
runtimes' own tests use xUnit 2.9 (C#), `testing` (Go), libtest (Rust),
`node:test` (TypeScript) and Pester 5 (PowerShell).

## 3. The shape of the result

What a developer writes and what the build produces, for C# with MSTest:

```yaml
# suites/orders.yml
suite: orders
setup:      [ { action: core.set, values: { region: eu } } ]
beforeEach: [ { action: core.record, marker: before } ]
afterEach:  [ { action: core.record, marker: after } ]
teardown:   [ { action: core.record, marker: done } ]
tests:
  - name: places an order
    tags: [smoke]
    steps: [ ... ]
  - name: rejects a bad quantity
    examples: { columns: [qty], rows: [ { qty: 0 }, { qty: -1 } ] }
    steps: [ ... ]
```

```csharp
// obj/.../BddSuite/orders.g.cs  (generated at build; never edited)
[TestClass]
public sealed partial class Suite_Orders
{
    static SuiteSession s = null!;
    public TestContext TestContext { get; set; } = null!;

    [ClassInitialize] public static void Setup(TestContext c) => s = BddSuiteRun.Open("suites/orders.yml", c).Setup();
    [ClassCleanup]    public static void Teardown() => s.Teardown();          // throws only if teardown failed
    [TestInitialize]  public void BeforeEach() => s.BeforeEach(TestContext.TestDisplayName!);
    [TestCleanup]     public void AfterEach() => s.AfterEach(TestContext.TestDisplayName!);  // throws only if afterEach failed

    [TestMethod(DisplayName = "places an order"), TestCategory("smoke")]
    public void PlacesAnOrder() => s.RunCase("places an order").ThrowIfFailed();

    // One method per examples row (T0): every row is selectable by its method.
    [TestMethod(DisplayName = "rejects a bad quantity [qty=0]")]
    public void RejectsABadQuantityQty0() => s.RunCase("rejects a bad quantity [qty=0]").ThrowIfFailed();

    [TestMethod(DisplayName = "rejects a bad quantity [qty=-1]")]
    public void RejectsABadQuantityQty1() => s.RunCase("rejects a bad quantity [qty=-1]").ThrowIfFailed();
}

// obj/.../BddSuite/_Run.g.cs: one per test assembly
[TestClass] public static class BddSuiteAssembly
{
    [AssemblyInitialize] public static void Start(TestContext c) => BddSuiteRun.Start(c, new MyActions());
    [AssemblyCleanup]    public static void Stop() => BddSuiteRun.Stop();
}
```

The same suite in the other providers (the full mapping is
[DEC-T05](#dec-t05)):

```text
Go      func TestOrders(t *testing.T) { s := suitetest.Open(t, "suites/orders.yml"); t.Run("places an order", s.Case("places an order")) ... }
        func TestMain(m *testing.M)  { suitetest.Main(m, myactions.Extension) }
Rust    tests/suites.rs (harness = false): suiterun::testing::main(&[my_extension()], include!(concat!(env!("OUT_DIR"), "/suites.rs")))
TS      describe('orders', () => { before(s.setup); beforeEach(s.beforeEach); it('places an order', s.case('places an order')); after(s.teardown) })
Pester  Describe 'orders' { BeforeAll { $s = Open-BddSuiteSession ... } It 'places an order' -Tag smoke { $s | Invoke-BddSuiteCase 'places an order' } ... }
```

Where the parts live:

```text
spec/
  tests.config.schema.json      NEW  the generator's config file (one schema, five languages)
  session.md                    NEW  the session contract every runtime implements
conformance/
  execute/                      +2 entries (deep copy; nothing selected runs no setup)
  generate/                     NEW  suite + config -> expected test plan, for all five generators
runtimes/<lang>/
  session API                   NEW  in the runtime library; suiterun's run verb rebuilt on it
  suiterun generate             NEW  writes the provider's test code (and --plan, --check)
  testing glue                  NEW  csharp: Bdd.Suite.Testing (+ MSBuild targets); go: suite/suitetest;
                                     rust: suiterun::testing (+ build.rs helper); ts: @bdd-suite/runtime/testing;
                                     powershell: Pester helpers in BddSuite
samples/workspace/tests/<lang>/ NEW  one test project per language/provider running the sample suites
```

## 4. Decisions

### <a id="dec-t01"></a>DEC-T01. Each runtime gets a session API with one contract, and its whole-file run is rebuilt on it

**Choice.** `spec/session.md` defines the contract; each runtime implements
it in its idiom:

| Operation | Does | Phase(s) |
| --- | --- | --- |
| `open(file, run context)` | parse, expand imports and meta steps, resolve params and vars, list cases (with rows expanded) | none |
| `setup()` | runs suite setup once; idempotent; records a failure instead of throwing | suite setup |
| `beforeEach(case)` | ensures setup ran, acquires the suite's case lock, runs beforeEach; records a failure instead of throwing | beforeEach |
| `runCase(case) -> CaseResult` | runs case setup, steps, case asserts and case cleanup from a deep copy of setup's bag; reports a recorded setup or beforeEach failure as this case's result, exactly as the whole-file run does | case setup, steps, cleanup |
| `afterEach(case)` | runs afterEach, settles the case result (an afterEach failure makes it `failed`, reason `hook`), writes the case's trace entry, releases the lock; throws only if afterEach failed | afterEach |
| `teardown() -> result` | runs teardown once if setup ran, on setup's bag | suite teardown |
| `cases()`, `trace()` | the expanded case list; the trace so far | none |

The whole-file run (`runFile` and its equivalents) becomes: `open`, then for
each selected case `beforeEach`, `runCase`, `afterEach`, then `teardown`.

**Why.** A framework calls these at times it chooses; only a session can hold
state between the calls. Rebuilding `suiterun` on the same object means the
existing corpus and the extension's integration suite prove the session, and
there is no second implementation of the phases to drift.

**Tradeoff.** The largest refactor in the work is in each runtime's executor,
the code every user depends on. It is contained by the unchanged execute
corpus (E2) passing before any provider is built.

**Serves.** O1, O4. **Verified by.** E1, E2.

### <a id="dec-t02"></a>DEC-T02. Hooks record, the case reports: framework quirks cannot change a result

**Choice.** `setup()` and `beforeEach()` never throw for a step failure; they
record it. The next `runCase()` reports it as that case's result, with the
same status, reason and message the whole-file run gives (setup failure:
`error`, "Suite setup failed: ..."; beforeEach failure: `failed`, reason
`hook`), and still runs case cleanup when the whole-file run would. Only
`afterEach()` and `teardown()` throw, each only when its own block failed:
afterEach is the last per-case hook, so nothing a framework skips after it can
change a result, and every framework shows a failed per-test cleanup as that
test's failure ([spec/session.md](../../spec/session.md), rules 3, 4 and 6).

**Why.** Frameworks differ when an initialize hook throws (T0): MSTest and
NUnit skip the test body and still run the per-test cleanup, while xUnit
calls neither `Dispose` nor `DisposeAsync` after a throwing constructor; Jest
fails the cases, Vitest marks them skipped and `node:test` cancels them after
a throwing `beforeAll`. If hooks threw, the same suite would report
differently in each framework, and cleanup might not run. Recording keeps the
corpus's failure rules exact everywhere and guarantees the matching
`afterEach` is called.

**Tradeoff.** In a framework's UI a setup failure appears on each test, not on
the initialize hook. That is what `suiterun` reports too.

**Serves.** O4. **Verified by.** E1, E4–E8.

### <a id="dec-t03"></a>DEC-T03. Setup is lazy and idempotent; teardown runs once if and only if setup ran

**Choice.** The class-level hook calls `setup()`, and `beforeEach()` calls it
again if needed; it runs once. If a framework selects no case of a suite (a
name filter matching nothing in it), setup does not run, and `teardown()` does
nothing, as in a whole-file run with no selected case. Teardown runs on
setup's bag, after the last case the framework ran.

**Why.** "Runs once, before the first selected case" is the suite rule;
frameworks differ on whether class hooks run when no test of the class is
selected. Lazy setup makes the rule hold in all of them.

**Serves.** O4. **Verified by.** E1, E4–E8 (filter checks).

### <a id="dec-t04"></a>DEC-T04. Each case starts from a deep copy of setup's capture bag, in every runtime

**Choice.** `runCase` deep-copies setup's bag. C#, Go, TypeScript and
PowerShell change from a one-level copy; Rust already deep-copies. A new
execute entry (`conformance/execute/capture-isolation.yml`) has a case change a
nested captured list in place, through the corpus's `fixture.append` action
(no core action changes a value in place, so the leak needs one), and the next
case and the teardown read it unchanged.

**Why.** The schema promises each case "a copy" and teardown setup's bag. With
a one-level copy, a case that changes a nested value changes it for later
cases and for teardown, and the result depends on case order, which a
framework may change. Four runtimes differ from the fifth today.

**Tradeoff.** A behaviour change in four runtimes for suites that rely on the
leak; such a suite is order-dependent already. Listed in the release notes.

**Serves.** O4. **Verified by.** E1, E2.

### <a id="dec-t05"></a>DEC-T05. The phase-to-hook mapping per provider

| Suite phase | MSTest 4 | NUnit 4 | xUnit v3 | Go `testing` | Rust (custom harness) | `node:test` / Vitest / Jest | Pester 5 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| run context | `[AssemblyInitialize]` / `[AssemblyCleanup]` | root `[SetUpFixture]` `[OneTimeSetUp]`/`[OneTimeTearDown]` | `[assembly: AssemblyFixture]` | generated `TestMain` | harness `main` | module scope of each test file ([DEC-T08](#dec-t08)) | a module imported (without `-Force`) in each file's `BeforeAll`, reset by the driver after the run |
| suite setup | `[ClassInitialize]` | `[OneTimeSetUp]` | `IClassFixture<T>`, `InitializeAsync` | start of `TestSuite_<id>` | the suite's first executing trial | `before` / `beforeAll` | `BeforeAll` |
| beforeEach | `[TestInitialize]` | `[SetUp]` | test class constructor | start of each `t.Run` | inside each trial | `beforeEach` | `BeforeEach` |
| case | `[TestMethod(DisplayName = ...)]` | `[TestCase(TestName = ...)]` on a parameterless method | `[Fact(DisplayName = ...)]` | `t.Run(name)` | one trial per case | `it` / `test` | `It` with the name's `<` `>` escaped |
| examples row | one method per row | one method per row | one `[Fact]` per row (a Theory row's name gets its arguments appended) | one `t.Run` per row | one trial per row | one `it` per row | one `It` per row (a `-ForEach` row cannot be selected by name) |
| afterEach | `[TestCleanup]` | `[TearDown]` | `DisposeAsync` of the test class | `t.Cleanup` in the subtest | inside each trial, after the case | `afterEach` | `AfterEach` |
| suite teardown | `[ClassCleanup]` | `[OneTimeTearDown]` | class fixture `DisposeAsync` | `t.Cleanup` on `TestSuite_<id>` | a final `<suite>::teardown` trial, or the last executing case when that trial is filtered out | `after` / `afterAll` | `AfterAll` |
| tags | `[TestCategory]` | `[Category]` | `[Trait("Category", ...)]` | names only; `BDD_SUITE_TAGS` | names only; `BDD_SUITE_TAGS` | names only; `BDD_SUITE_TAGS` | `-Tag` |
| one test, from the command line | `--filter "Name=<escaped>"` | `--filter FullyQualifiedName=<method>` (a `Name=` with a space breaks the adapter) | `--filter FullyQualifiedName=<method>` | `-run 'TestSuite_<id>/<name>'` | `-- --exact '<suite>::<name>'` | `-t` / `--test-name-pattern` with an escaped, anchored regex (Vitest joins with ` > `) | `-FullNameFilter` with `[WildcardPattern]::Escape` |

**Where a failed teardown appears (T0).** Every provider tested keeps passed
cases passed and fails the run, as the suite rule requires; where the failure
shows differs:

| Provider | A failed suite teardown is shown as |
| --- | --- |
| MSTest 4 | its own Failed row `[<class> ClassCleanup]`, which reuses the class's last test's id, so a result reader matches rows by name. MSTest 3.x attaches it to a passed test, which is why MSTest 4 is the minimum. |
| NUnit 4 | a run-level error (TRX `RunInfo`), exit 1; the console summary says "Failed: 0" |
| xUnit v3 | a run-level error "[Test Class Cleanup Failure (...)]", exit 1 |
| Go | the parent test `TestSuite_<id>` fails; its subtests keep their results |
| Rust | the `<suite>::teardown` trial fails; when that trial is filtered out, the failure is printed to stderr and the harness exits 101 |
| Vitest | a separate JUnit test case named after the describe |
| Jest | jest-junit's synthetic test case " Test execution failure ..." (exit 1) |
| Mocha | the hook failure `"after all" hook for "<last test>"`, under the describe, in the `xunit` report (exit 1); the cases keep their results |
| `node:test` | only to a reporter: the built-in JUnit reporter drops it, so the provider ships a reporter that records it |
| Pester | the container's `FailedBlocks` and, in NUnit3 output, the fixture with `site="TearDown"`; the provider writes NUnit3, because NUnit 2.5 output shows everything as Success |

A failed run-level stop (`[AssemblyCleanup]` and equivalents) is reported by
throwing, the only way the frameworks fail a run from there; MSTest then adds
a second, Failed result to the last test, which a reader recognises by its
message ("Assembly Cleanup method ...").

**Why.** Each row uses the framework's native construct, so its UI, filters,
reports and debugger work as for hand-written tests.

**Serves.** O2, O3. **Verified by.** E3–E8.

### <a id="dec-t06"></a>DEC-T06. Each runtime's `suiterun` generates its own language, from one shared test plan

**Choice.** `suiterun generate --config <file> [--plan | --check]` in every
runtime. It reads the config ([DEC-T07](#dec-t07)), lists suites, builds the
**test plan** with the runtime's own parser (case names, rows, tags, guards,
identifiers) and renders it with the provider's templates. `--plan` prints the
plan as JSON; `--check` exits 1 if the files on disk differ from what it would
write. A new corpus, `conformance/generate/`, holds suites with tricky names
(spaces, punctuation, Unicode, reserved words, two names that sanitise alike,
outlines) and the expected plan; all five runtimes must produce it exactly.

Identifiers: letters and digits of the name in PascalCase (C#), as Go/Rust
idents, or kept as strings (TypeScript, Pester), with a numeric suffix on
collision in plan order; the display name is always the exact case name, which
is what the session is called with.

**Why.** Each ecosystem should generate with its own toolchain (no Node.js to
build a C# project, no .NET to build a Go one). The shared plan corpus keeps
five generators naming and selecting tests identically, as the execute corpus
keeps five runtimes running them identically.

**Tradeoff.** Five generators to maintain. Templates are small; the plan,
which carries the logic, is checked by the corpus.

**Serves.** O2, O3, O5. **Verified by.** E3, E12.

### <a id="dec-t07"></a>DEC-T07. One config file per test project, `bddsuite.tests.yaml`, with a schema in `spec/`

**Choice.** The file sits at the test project root:

```yaml
suites: [ "../suites/**/*.yml" ]      # globs relative to this file
schemaRoot: ../schema                  # the folder with actions.catalog.yaml and suite.schema.json
provider: mstest                       # mstest | nunit | xunit | go | rust | node | vitest | jest | mocha | pester; auto when omitted (DEC-T10)
extensions: [ "MyCompany.Actions.OrdersExtension" ]   # how the language names an extension (type, import path + symbol, module path)
offlineActions: [ "core.*", "wait", "orders.*" ]     # actions that need no lab (DEC-T09)
output: { namespace: MyCompany.Suites.Tests }        # language-specific naming
```

`spec/tests.config.schema.json` describes it; the VS Code extension offers
completion and validation for it (P2, [D16](implementation.md#d16)) and reads
`offlineActions` from it when present, so the editor and the tests share one
list.

**Why.** A generator run must be reproducible from files in the repository;
command-line flags in five build systems would drift. One schema means the
same keys in every language.

**Serves.** O2, O3, O5. **Verified by.** E3, E12.

### <a id="dec-t08"></a>DEC-T08. One run context per test process; cases of one suite never overlap; suites may run in parallel

**Choice.** The run context (composed extensions, started once, schema,
options, params) is created once per test process: by the generated
assembly/package hook, or lazily by the first session in frameworks without
one. In the JavaScript frameworks that means **once per test file** (T0):
Jest, Vitest's default isolation and `node:test` all give each test file its
own module state, and Jest's `globalSetup` runs in another process. Each session holds a case
lock from `beforeEach` to `afterEach`, so even under method-level parallelism
two cases of one suite never run at once; different suites may run in
parallel if the framework does so. The runtimes' shared trace and counters are
made safe for concurrent sessions (C#, Go).

**Why.** `suiterun` starts extensions once per run and runs a file's cases one
after another; actions and lab extensions rely on both. Frameworks vary in
their defaults (xUnit runs classes in parallel; `cargo test` runs tests on
threads; Jest uses worker processes); the lock and the per-process context
make the defaults safe rather than asking users to change them.

**Tradeoff.** Under the JavaScript frameworks, extension state is per test
file, so an extension that assumes one process (one lab connection) is
started once per suite file. Vitest can share it (`isolate: false`,
`maxWorkers: 1`, set per project); Jest's worker count is global only and its
module state stays per file. The TypeScript provider documents this, and its
generated Vitest config for guarded suites sets `isolate: false` and one
worker (T0).

**Serves.** O4. **Verified by.** E11.

### <a id="dec-t09"></a>DEC-T09. Guarded suites skip unless the run opts in; options and params come from the environment

**Choice.** The plan marks a suite **guarded** when any of its steps (after
meta-step expansion) uses an action outside `offlineActions`. A guarded test
reports *skipped* ("guarded suite: set BDD_SUITE_ALLOW_GUARDED=1 to run it")
unless that variable is `1`. Extension options (what `suiterun` takes as
`--api-url`, `--lab-id`, ...) come from `<prefix>OPTION_<FLAG>` variables
(`BDD_SUITE_OPTION_API_URL`), params from the existing
`<prefix>PARAM_<NAME>`, tags from `BDD_SUITE_TAGS`, dry run from
`BDD_SUITE_DRY_RUN=1`; MSTest and NUnit also read the same names from
`.runsettings` test run parameters. Generated files contain no option values.

**Why.** Native tests run whenever anyone types `dotnet test`, including in CI
and in an IDE's *Run All*. The VS Code extension requires a confirmation
before a lab run (INV-6); the equivalent for a test framework is an explicit,
visible opt-in. Environment variables are the one input every framework and CI
system can supply; values like lab ids and connection files are run-time
inputs and must never be written into generated code (INV-7).

How a test skips, per provider (T0): MSTest `Assert.Inconclusive`, NUnit
`Assert.Ignore`, xUnit `Assert.Skip`, Go `t.Skip`, Rust an ignored trial,
Vitest `ctx.skip(reason)`, `node:test` `t.skip(reason)` followed by `return`
(it does not throw), Pester `Set-ItResult -Skipped -Because`. **Jest has no
runtime skip**, so its generated file decides at load time, from the same
environment variables, and declares a guarded or tag-filtered case with
`it.skip`; the environment is read when the file loads, which is before any
test runs, so the result is the same.

**Tradeoff.** Forgetting the opt-in makes guarded tests skip rather than fail;
the skip reason says exactly what to set, and CI can assert the expected count
of skips.

**Serves.** O4. **Verified by.** E10, E13.

### <a id="dec-t10"></a>DEC-T10. Where generation runs, per ecosystem

| Language | When it runs | Output | Kept in step by |
| --- | --- | --- | --- |
| C# | Two MSBuild targets in the `Bdd.Suite.Testing` package: an incremental one generating with the suites as inputs, and an always-run one, `BeforeTargets="BeforeCompile"`, adding the files to `Compile`. `CoreCompile` is too late: a deleted suite would leave its tests in the assembly (T0). | `obj/<config>/BddSuite/*.g.cs`, compiled, not committed | incremental build (inputs/outputs); design-time builds run it too (checked with `dotnet msbuild -p:DesignTimeBuild=true` and Visual Studio 18's MSBuild, T0) |
| Go | `//go:generate suiterun generate --config bddsuite.tests.yaml` | `*_bdd_test.go`, committed (Go convention) | `suiterun generate --check` in CI |
| Rust | `build.rs` calling `suiterun::testing::generate` (the crate as a build-dependency) | `$OUT_DIR/suites.rs`, included by the harness file | Cargo's `rerun-if-changed` on the suites |
| TypeScript | `npx suiterun generate` (an `npm` `pretest` script) | `*.bdd.test.ts`, committed or ignored by the team's choice | `--check` in CI when committed |
| PowerShell | `Invoke-BddSuite -Generate` / `suiterun.ps1 generate` | `*.Bdd.Tests.ps1`, committed | `-Check` in CI |

Provider auto-detection when `provider` is omitted: C# from the test
project's package references (MSTest.TestFramework, NUnit, xunit.v3);
TypeScript from `package.json` dev dependencies (vitest, jest, mocha, else
`node:test`); one choice each in Go, Rust and PowerShell.

**Why.** Each row is how that ecosystem normally generates code. C# and Rust
can regenerate on every build at no cost to the developer, so their output is
never committed and cannot go stale; Go convention commits generated files;
TypeScript and PowerShell have no build step every developer runs.

**Tradeoff.** In C#, a suite added since the last build appears in the IDE's
test explorer after the next build (or design-time build). Rust: tests in a
custom harness get no per-test gutter icons in rust-analyzer or RustRover;
filtering by name works on the command line and in their run configurations.

**Serves.** O5. **Verified by.** E9, E12.

### <a id="dec-t11"></a>DEC-T11. Rust uses a generated custom harness (libtest-mimic), not `#[test]` functions

**Choice.** A `[[test]]` target with `harness = false` on libtest-mimic,
pinned at `=0.8.2`, whose `main`:

* builds one trial per case and row plus one `<suite>::teardown` trial per
  suite, the suites interleaved round-robin;
* predicts, before running, which trials the command line selects, with the
  public `Arguments::is_filtered_out` and `is_ignored` on a probe trial (T0:
  the prediction matched libtest-mimic's own for every argument combination
  tried);
* gives each suite a **turnstile**: a turn number for each unit that will run,
  a mutex and condition variable so a unit waits for its turn, and a guard
  that advances the turn even on panic. A suite's units therefore run in
  order and never overlap, while suites run in parallel on the harness's
  threads (a unit may run on any thread, so no suite state is thread-local);
* runs setup in the suite's first executing unit and teardown in its last:
  the teardown trial when it is selected, which then reports teardown's own
  result; otherwise the last executing case, which prints a teardown failure
  to stderr and makes the harness exit 101 after the run.

The pin matters: the turnstile cannot deadlock only because 0.8.2 hands
trials to its threads in list order; the T0 spike stays as the regression test
for an upgrade. CI runs it with `cargo test --test <target> -- --format json
--logfile <file>`, which works on stable for this target only.

**Why.** libtest has no "before all"/"after all": with `#[test]` functions,
setup can be done lazily but teardown has no place to run once after the last
selected case, and default threading would interleave a suite's cases. A
custom harness keeps `cargo test`, its filters and `--list`, while giving the
session the order it needs.

**Tradeoff.** Adds the `libtest-mimic` dependency to the testing feature (not
the runtime itself); loses rust-analyzer gutter icons ([DEC-T10](#dec-t10)).

**Serves.** O3, O4. **Verified by.** E6.

### <a id="dec-t12"></a>DEC-T12. Proof: the corpus through every provider, plus framework behaviour checks

**Choice.** For each provider, a test project in `samples/workspace/tests/`
generates tests for the whole execute corpus and the sample suites, runs them
with the framework's own command, and compares (a) the framework's results
(TRX, JUnit XML, `go test -json`, libtest JSON, TAP/JUnit, Pester NUnit XML)
per case with the expected statuses, and (b) the trace the session writes
(`BDD_SUITE_TRACE_FILE`) with each corpus entry's expected trace: the suite
setup's entries first and the teardown's last, exactly, and each case's
entries as one unbroken group, exactly, in whatever order the framework ran the
cases (T3: NUnit and xUnit do not keep file order, and the suite rules do not
ask them to; interleaved cases break a group and fail the comparison). The
same project checks name and tag filters, parallel settings, guarded skips and
staleness.

Result readers follow the T0 findings: they read run-level errors as well as
per-test outcomes (TRX `RunInfo` rows, MSTest's `[<class> ClassCleanup]` row
matched by name rather than id, Pester `FailedBlocks`, the exit code), and
they treat zero executed tests as an error, because xUnit and the JavaScript
runners exit 0 when a filter matches nothing.

**Why.** The execute corpus already defines correct behaviour for every phase
and failure; running it through each provider proves the mapping, not just
that the code compiles.

**Serves.** O1–O5. **Verified by.** all scenarios.

### <a id="dec-t13"></a>DEC-T13. A C# test assembly finds its suites beside itself when the build's paths are gone

**Choice.** The generated `BddSuiteRun.Open` call keeps the absolute paths the
suite and its schema had where the tests were generated. When those paths do
not exist where the tests run, the runtime looks for the same layout near the
test assembly: the schema folder by its build-time name and the suite at its
build-time place relative to it (`schema` and `suites/orders.yml`), in the
assembly's folder and each folder above it, and in a `test/e2e` folder there
(the default layout). The nearest folder holding both wins. When none does, the
build's paths are used, and the error names them.

**Why.** A test package built on one machine (a CI agent) and run on another
(a lab's test VM, under a runner such as TAEF) carries its suites with it, but
not at the agent's paths, so every test class failed to open its suite.

**Tradeoff.** A package must keep the schema and suites in the layout they had
at build time (or under `test/e2e`), beside or above the assembly; one that
rearranges them still fails, naming the build's path. `suiterun` in the same
package needs `--schema-root` unless the layout is `test/e2e`. A test
project built and run in place behaves exactly as before. Only the C# provider
does this; the other providers run where they are generated.

**Serves.** O4. **Verified by.** `ToolboxTests.AGeneratedSuitePathIsFoundBesideTheAssemblyOnAnotherMachine`
(unit); E13 in a consumer's lab.

### <a id="dec-t14"></a>DEC-T14. The mstest provider can generate for TAEF's CoreCLR host

**Choice.** `output.host: taef` in `bddsuite.tests.yaml` (mstest only) makes
the generator emit MSTest-attributed classes that never use MSTest's
`TestContext`:

- no `[AssemblyInitialize]`: the run context starts on the first test, from
  the environment alone, and stops in a parameterless `[AssemblyCleanup]`;
- no `[ClassInitialize]`: each class opens its suite on its first test, under
  a lock; the session runs the suite setup from that test's beforeEach, as it
  does for every provider (spec/session.md rule 2);
- no `[TestInitialize]`/`[TestCleanup]` and no `TestContext` property: each
  test calls beforeEach, the case and afterEach itself, with its own method
  name, which the generator knows;
- a failed afterEach fails the test it ran after; a failed suite teardown
  still fails the parameterless `[ClassCleanup]`.

**Why.** TAEF runs MSTest-attributed tests, but its CoreCLR host refuses a
fixture that takes MSTest's `TestContext` ("It must be
WEX.TestExecution.Markup.TestContext when using the CoreCLR TAEF binaries"),
and one refused assembly fixture blocks every test in the assembly. update2's
BVTs (69 cases) were all Blocked on a lab for that reason. A test assembly
cannot reference both TestContext types for one fixture, so the generated
code needs no context at all.

**Tradeoff.** Under TAEF the run's inputs (`BDD_SUITE_*`) come only from the
environment; MSTest run settings parameters are not read. A failed afterEach
is reported against its test instead of a separate cleanup row. Each test
carries its beforeEach and afterEach, so a test filter that runs one test
still runs both. The same code also runs under the MSTest runner, with those
same differences.

**Serves.** O4. **Verified by.** `GenerateTests.EachProvidersCodeEqualsTheGoldenFiles`
(mstest-taef golden files), `GenerateTests.TheTaefHostsCodeTakesNoTestContextAndNoInitializeFixture`,
`GenerateTests.AHostIsRefusedForAProviderOtherThanMsTest` (unit); E13 under
TAEF in update2's lab.

### <a id="dec-t15"></a>DEC-T15. A test process can print its step lines live (`<prefix>PROGRESS=1`)

**Choice.** When the run context is made from the environment (or a
framework's run settings) and `<prefix>PROGRESS` is `1`, it writes each hook
and step line to standard output as the trace records it, in the shape
`suiterun --progress` prints (spec/progress.md). It writes no
`StartGroup`/`EndGroup` lines: the test framework (TAEF, MSTest) prints its
own case lines, and a second copy would double every count a log reader takes.
A dry run prints nothing, as it traces nothing. C# runtime.

**Why.** A lab case runs for minutes. Under `suiterun` the progress lines say
which step it is on; a generated test only wrote its trace when the run ended,
so a TAEF console showed `StartGroup` and then nothing until `EndGroup`. TAEF
shows a test's output as it happens, so the same lines give the same live view.

**Tradeoff.** Opt-in, so a framework's output is unchanged unless asked for.
The lines go to the process's standard output, which every host captures; a
host that captures per test shows them under the test that was running.

**Serves.** O4. **Verified by.** `SessionTests.ProgressWritesTheHookAndStepLinesAsTheyAreTraced`
(unit); E13 under TAEF in update2's lab.

## 5. Failure, rollback and cleanup

* **What the work owns.** Generated test files (in `obj/`, `OUT_DIR`, or
  committed `*_bdd_test.go` / `*.bdd.test.ts` / `*.Bdd.Tests.ps1`), trace
  files a run writes when asked, and the processes and threads a run starts.
  It owns no lab or environment state: guarded suites change real
  environments only through their binding's actions, whose ownership and
  cleanup rules belong to the extension that registers them (for os-context,
  its lifecycle actions).
* **A case's afterEach always runs** once its beforeEach was called
  ([DEC-T02](#dec-t02)), and **teardown runs once if setup ran**
  ([DEC-T03](#dec-t03)), even after failures, as in `suiterun`.
* **A run aborted by the framework** (timeout, Ctrl+C, a crashed worker): the
  framework's process ends; `[AssemblyCleanup]`/`TestMain`/harness exit run
  `BddSuiteRun.Stop()` where the framework still calls them, which runs any
  pending teardowns. A hard kill skips them, exactly as killing `suiterun`
  does today; for guarded suites the binding's own recovery applies, and the
  skipped teardown is visible as a missing trace entry.
* **A step that times out** is abandoned on its thread (C#, Rust) or runspace
  (PowerShell) as today; the session marks the case failed and continues.
* **Undoing the change for a project:** remove the package reference (C#), the
  `go:generate` line and generated files (Go), the test target (Rust), the
  `pretest` script and generated files (TypeScript), or the generated
  `.Tests.ps1` (PowerShell); `suiterun` keeps working unchanged. The DEC-T04
  behaviour change is not reverted by this; it is part of the runtimes.

## 6. Verification

Every scenario records the source commit, runtime and framework versions, OS,
exact commands, results (framework report files and trace files kept as
evidence) and cleanup, in `docs/evidence/test-providers-<stage>.md`. A
skipped, blocked or failed scenario stays open. Local framework runs are
separate evidence from E13, which needs a real lab. The guarantee covers the
tested framework versions and the listed scenarios, not every framework
configuration.

### <a id="e1"></a>E1. The session reproduces the execute corpus in all five runtimes

* **Given** the execute corpus plus the two new entries (`capture-isolation`,
  and `nothing-selected`: a tag filter that selects no case of a suite, the same
  rule a framework's name filter meets), and
  each runtime built from the tested commit.
* **When** a session-level test drives each entry through the session in each
  framework's call order: class hook `setup()`, then per case `beforeEach`,
  `runCase`, `afterEach`, then `teardown()`; once in file order and once with
  cases in reverse order.
* **Then** the trace equals the entry's expected trace (in reverse order, the
  case entries are permuted and nothing else changes); case statuses, reasons
  and messages equal the whole-file run's; in `capture-isolation`, the second
  case and teardown read the unmodified value; in `nothing-selected`, setup
  and teardown do not run.
* **Cleanup.** None.

### <a id="e2"></a>E2. `suiterun` behaves exactly as before, rebuilt on the session

* **Given** the five runtimes with their whole-file run rebuilt on the session.
* **When** each runtime's unit tests and full conformance corpus run; the
  divergence check runs; the VS Code extension's integration suite runs
  against `samples/workspace`.
* **Then** everything passes with no expectation changed except the new
  `capture-isolation` entry; the divergence check still catches its injected
  defect.
* **Cleanup.** `git status` clean.

### <a id="e3"></a>E3. Five generators produce the same test plan

* **Given** `conformance/generate/`: suites with spaces, punctuation, Unicode,
  reserved words, names that sanitise to the same identifier, outlines,
  imports, meta steps using guarded actions, and a config.
* **When** each runtime runs `suiterun generate --plan`.
* **Then** every plan equals the expected JSON exactly (suite and case display
  names, identifiers with collision suffixes, rows, tags, guarded flags, order);
  the C# generator's output compiles for all three C# providers; each
  generator's output for the corpus matches its committed golden files.
* **Cleanup.** None.

### <a id="e4"></a>E4. C#: MSTest, NUnit and xUnit run the corpus

* **Given** `samples/workspace/tests/csharp/{mstest,nunit,xunit}`, each
  referencing `Bdd.Suite.Testing` and the sample extension, with the corpus
  and sample suites as inputs; .NET 10 SDK; MSTest 4.x, NUnit 4.x, xUnit v3
  (versions recorded).
* **When** `dotnet test` runs each project, then with
  `--filter "FullyQualifiedName~Suite_Orders&Name~places"`, then with
  `--filter TestCategory=smoke` (MSTest/NUnit) or `Category=smoke` (xUnit),
  then with the framework's parallelism set to method level, 4 workers.
* **Then** the generated source contains the attributes of [DEC-T05](#dec-t05)
  (checked by reading `obj/.../BddSuite/*.g.cs`); per case and row, the TRX
  outcome matches the expected status (error and failed both reported failed;
  skipped as not executed); the trace file equals the corpus's; the filtered
  runs run only the selected cases with setup and teardown once each; a failed
  teardown fails the run without turning a passed case into a failure, or the
  framework shows it where DEC-T05's table says; a failed
  setup reports "Suite setup failed" on each case; the parallel run passes
  E11's overlap check.
* **Cleanup.** `dotnet clean`.

### <a id="e5"></a>E5. Go: `go test` runs the corpus

* **Given** `samples/workspace/tests/go` with `bddsuite.tests.yaml`,
  `go generate` run, Go 1.24+.
* **When** `go test -json ./...`, then `-run 'TestOrders/places_an_order'`,
  then with `BDD_SUITE_TAGS=smoke`.
* **Then** one subtest per case and row with the expected status; the trace
  equals the corpus's; the filtered run runs setup and teardown once around
  one subtest; tag-filtered cases are skipped with reason "tag filter"; a
  failed teardown fails the parent test only.
* **Cleanup.** None.

### <a id="e6"></a>E6. Rust: `cargo test` runs the corpus through the generated harness

* **Given** `samples/workspace/tests/rust` with `build.rs` and the harness
  target.
* **When** `cargo test`, `cargo test -- --list`, `cargo test -- "orders::places"`,
  `cargo test -- --test-threads 8`, and `cargo test -- -Z unstable-options
  --format json` on nightly if available (else the harness's JSON report).
* **Then** one trial per case and row plus one teardown trial per suite with
  expected statuses; `--list` lists them; the filter runs setup and teardown
  once around the selected case; with 8 threads, no two cases of one suite
  overlap (E11); a suite edit followed by `cargo test` reflects the edit.
* **Cleanup.** `cargo clean -p` the sample.

### <a id="e7"></a>E7. TypeScript: `node:test`, Vitest, Jest and Mocha run the corpus

* **Given** `samples/workspace/tests/typescript/{node,vitest,jest,mocha}`, Node.js
  24, the generated `*.bdd.test.ts`.
* **When** each project's `npm test`, with a name filter (`--test-name-pattern`,
  `-t`, `--grep`), and with Vitest/Jest at their default worker counts
  (Mocha with `--parallel`).
* **Then** one test per case and row with expected statuses (JUnit reporter);
  traces equal the corpus's; filters run setup and teardown once around the
  selection; teardown failure is reported as a suite-level error; Jest's
  failure appears where DEC-T05's table says (Jest's synthetic test case, the
  `node:test` provider's own reporter).
* **Cleanup.** None.

### <a id="e8"></a>E8. PowerShell: Pester runs the corpus

* **Given** `samples/workspace/tests/powershell` with generated
  `*.Bdd.Tests.ps1`, PowerShell 7, Pester 5.
* **When** `Invoke-Pester -Output Detailed -CI`, then with `-FullNameFilter`
  and `-TagFilter smoke`.
* **Then** one `It` per case and row with expected results in the NUnit XML;
  traces equal the corpus's; filters run `BeforeAll` and `AfterAll` once
  around the selection; a failed teardown fails the container, not the cases.
* **Cleanup.** None.

### <a id="e9"></a>E9. Tests are listed and selectable by the usual tools

* **Given** E4–E8's projects.
* **When** `dotnet test --list-tests`, `go test -list .`, `cargo test --
  --list`, `vitest list` / `jest --listTests` with `--json`, and Pester's
  discovery (`Invoke-Pester -Configuration @{Run=@{SkipRun=$true}}` with
  `PassThru`) run.
* **Then** each lists one entry per case and row with the case's exact display
  name (Go: with Go's space-to-underscore rewrite). How an IDE's test explorer
  shows them (Visual Studio, Rider) is out of scope (see 1.3).
* **Cleanup.** None.

### <a id="e10"></a>E10. Guarded suites skip without the opt-in, in every provider

* **Given** E4–E8's projects with a sample suite that uses `example.lab`
  (not in `offlineActions`), and an offline suite.
* **When** each framework runs without `BDD_SUITE_ALLOW_GUARDED`; then with it
  set to `1` and `BDD_SUITE_OPTION_*` unset; then with options set to the
  sample extension's fake values.
* **Then** without the opt-in, the guarded suite's cases are skipped with the
  stated reason and its setup and teardown do not run, while the offline suite
  runs; with the opt-in and no options, the cases fail with a message naming
  the missing variables; with fake values, they run; no generated file
  contains an option value (search of the generated sources).
* **Cleanup.** Unset the variables.

### <a id="e11"></a>E11. Cases of one suite never overlap under parallel settings

* **Given** a suite whose cases each record start and end times through
  `core.record`, three such suites, and each provider set to its most parallel
  configuration (MSTest method level, NUnit `ParallelScope.All`, xUnit
  defaults, `cargo test` 8 threads, Vitest/Jest defaults).
* **When** each runs the three suites ten times.
* **Then** within each suite, no case's interval overlaps another's, and each
  case's beforeEach/afterEach brackets only its own steps; different suites
  may overlap; no trace entry is lost or duplicated.
* **Cleanup.** None.

### <a id="e12"></a>E12. Generated tests stay in step with the YAML

* **Given** E4–E8's projects.
* **When** a case is added, renamed and removed in a sample suite, and each
  project builds or checks: `dotnet build`, `cargo test --no-run`,
  `suiterun generate --check` for Go, TypeScript and PowerShell.
* **Then** C# and Rust reflect each edit at the next build with no committed
  file changing; Go, TypeScript and PowerShell `--check` exit 1 naming the
  stale file until `generate` is run, then 0; a suite with a lint error makes
  generation fail with the runtime's finding and position rather than emit
  partial tests.
* **Cleanup.** `git checkout samples/workspace`.

### <a id="e13"></a>E13. A guarded suite runs against a real lab from a native framework (remote)

* **Given** a real lab reachable through os-context's documented jump path; an
  os-context worktree consuming this repository's runtimes, with a test
  project per binding generated for its portable stage 0 lab suite;
  `BDD_SUITE_ALLOW_GUARDED=1` and the lab's `BDD_SUITE_OPTION_*` values and
  connection file supplied at run time.
* **When** the suite runs through MSTest (`dotnet test`) and through at least
  one other provider (Pester for the PowerShell binding), and once through
  `suiterun` for reference.
* **Then** per-case results equal the `suiterun` reference; the trace's phase
  order equals the reference's; os-context's cleanup leaves the lab at its
  baseline (its own evidence); nothing lab-specific is in any committed file.
* **Cleanup.** os-context's teardown; if it fails, the evidence and lab state
  are kept and the scenario stays open.

### <a id="e14"></a>E14. The editor knows the config file (P2)

* **Given** D16 built; `samples/workspace/tests/csharp/shared/bddsuite.tests.yaml`
  open in VS Code (the C# projects share that one config); a scratch suite
  beside a config of its own, run from the Test Explorer with a fake binding
  program, so nothing reaches a lab.
* **When** a key is misspelled, an unknown provider is typed, and completion is
  requested under `provider:`; a guarded action is used in a suite.
* **Then** the misspelling and the unknown provider are underlined; completion
  offers the ten providers; the editor's run of a suite treats actions in the
  file's `offlineActions` as offline, the same as the generated tests do.
* **Cleanup.** The config edit is reverted unsaved; the scratch folder is
  removed.

## 7. Traceability

| Outcome | Decisions | Deliverables | Scenarios |
| --- | --- | --- | --- |
| O1 | DEC-T01, DEC-T04, DEC-T12 | D1, D2, D7, D9, D11, D13 | E1, E2 |
| O2 | DEC-T02, DEC-T03, DEC-T05, DEC-T06, DEC-T07, DEC-T10 | D3, D4, D5, D6 | E3, E4, E9 |
| O3 | DEC-T05, DEC-T06, DEC-T07, DEC-T10, DEC-T11 | D8, D10, D12, D14 | E3, E5, E6, E7, E8, E9 |
| O4 | DEC-T02, DEC-T03, DEC-T04, DEC-T08, DEC-T09, DEC-T11, DEC-T13 | D1, D2, D4–D14 | E1, E4–E8, E10, E11, E13 |
| O5 | DEC-T06, DEC-T07, DEC-T10 | D3, D8, D10, D12, D14, D15 | E9, E12 |

D16 (editor support for the config file) and D17 (Mocha) are P2 and serve no
outcome above; D16 is proved by [E14](#e14), D17 by [E7](#e7)'s Mocha row.
