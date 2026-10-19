# Running suites with each language's own test framework: implementation plan

Status: **planned 2026-10-19; nothing built, nothing run.** The design, its
outcomes (O1–O5), decisions (DEC-T01–DEC-T12) and scenarios (E1–E14) are in
[design.md](design.md). This plan says how each outcome is built, in what
order, and what evidence closes each step.

Working rules:

* **Statuses stay separate**: designed, built, unit-tested, locally accepted
  (corpus through the framework), remotely accepted (E13, real lab). A step is
  ticked only with its evidence recorded in
  `docs/evidence/test-providers-<stage>.md`; a skipped, blocked or failed
  scenario stays open.
* **The session lands before any provider in its language**, and its stage
  closes only when E1 and E2 pass for that runtime: `suiterun` must be
  unchanged before anything is built on the session.
* **A manual check is labelled `manual`** and never ticks a scenario.
  Scenarios that could change files (E12) run in their build stage.
* **No lab is available today.** E13 is written in the language stages and
  runs only in stage T9; it stays open until it has run against a real lab.
* **After a change to the VS Code extension** (D16), run `npm run
  install:local` and reload the window before checking it by hand.
* **Nothing is committed or pushed unless the user asks.**

## Contents

* [1. Deliverables](#1-deliverables)
* [2. Order and dependencies](#2-order-and-dependencies)
* [3. Stages](#3-stages)
* [4. Acceptance index](#4-acceptance-index)
* [5. Effort](#5-effort)

## 1. Deliverables

Priority: **P0** is C# with MSTest end to end and the shared spec it needs
(the case the request names); **P1** is the other eight providers and CI;
**P2** is editor support and Mocha. Priority orders the work; it never weakens
a completion condition.

### <a id="d1"></a>D1. The shared contract: session spec, config schema, two execute entries, the generate corpus (P0)

* **Result.** `spec/session.md` (the operations of DEC-T01 with their exact
  failure rules from DEC-T02 and DEC-T03); `spec/tests.config.schema.json`
  (DEC-T07); `conformance/execute/capture-isolation.yml` and
  `nothing-selected.yml` with expected traces (DEC-T04, DEC-T03);
  `conformance/generate/` with suites, a config and `*.expected-plan.json`
  (DEC-T06), listed in `run-manifest.yaml` under a new `generate` kind.
* **Why.** Five runtimes and nine providers need one written contract and one
  set of expected results, as the execute corpus is for running.
* **How.** Write the session spec from the existing whole-file semantics (each
  rule cites the execute entry that pins it). Write the two entries and derive
  expected traces by hand, then confirm with Rust (already deep-copies) for
  `capture-isolation`. Write the plan format (suite file, display name, cases
  with name, identifier, row, tags, guarded) and the generate suites (spaces,
  punctuation, Unicode, C#/Go/Rust reserved words, sanitising collisions,
  outlines, a meta step from a library that uses a guarded action). Extend
  each runtime's manifest reader to skip `generate` entries until its stage.
* **Files.** `spec/session.md`, `spec/tests.config.schema.json`,
  `conformance/execute/*`, `conformance/generate/**`,
  `conformance/run-manifest.yaml`, `conformance/README.md`.
* **Depends on.** Stage T0's spike findings for anything framework-specific in
  the config.
* **Done when.** Schema tests validate the sample configs and refuse bad ones;
  the five runtimes' corpus tests still pass with the new manifest kind
  skipped; Rust passes `capture-isolation` unchanged.
* **Proved by.** E1, E3.

### <a id="d2"></a>D2. C# session, with `RunFile` rebuilt on it (P0)

* **Result.** Public `SuiteSession` and `RunContext` in `Bdd.Suite`
  (`Bdd.Suite.Execution`): `RunContext.Create(options, extensions)` composes
  and starts extensions once; `SuiteSession.Open(path, context)`, `Setup()`,
  `BeforeEach(case)`, `RunCase(case) : CaseResult`, `AfterEach(case)`,
  `Teardown()`, `Cases`, `Trace`. `Executor.RunFile` is reimplemented on it;
  deep copy of setup's bag; a thread-safe `Trace`; options and params from
  the environment (DEC-T09).
* **Why.** O1 for C#, and everything C# providers need.
* **How.** Move the bodies of `RunHook`, `RunCase`, `CloneScope` and the
  per-case loop (`Executor.cs:478–747`) into `SuiteSession`; keep their order
  and messages. `BeforeEach` acquires a per-session `SemaphoreSlim`;
  `AfterEach` releases it in `finally`. Recorded setup and beforeEach failures
  are returned by `RunCase` exactly as the loop reports them today.
  `CloneScope` deep-copies (`OrderedMap.DeepClone`). `Trace` gets a lock.
  `RunContext.FromEnvironment(extensions)` reads `<prefix>OPTION_*`,
  `PARAM_*`, `TAGS`, `DRY_RUN`, `ALLOW_GUARDED`, `TRACE_FILE`.
* **Files.** `runtimes/csharp/Bdd.Suite/Execution/{Executor,SuiteSession,RunContext}.cs`,
  `Tracing/Trace.cs`, `Model/OrderedMap.cs`, tests in `Bdd.Suite.Tests`.
* **Depends on.** D1.
* **Done when.** E1 and E2 pass for C#; unit tests cover each operation's
  failure rule, the lock, environment parsing and deep copy.
* **Proved by.** E1, E2.

### <a id="d3"></a>D3. C# generator and the `Bdd.Suite.Testing` package (P0)

* **Result.** `suiterun generate --config ... [--plan|--check]` in
  `Bdd.Suite.Cli`; a `Bdd.Suite.Testing` library (`BddSuiteRun.Start/Open/Stop`,
  `CaseResult.ThrowIfFailed()` using the framework's assertion exception when
  present, else `BddSuiteCaseFailedException`); an MSBuild targets file in the
  same package that runs the generator before `CoreCompile` with the suites
  and config as inputs and adds `obj/$(Configuration)/BddSuite/*.g.cs` to
  `Compile`; provider auto-detection from `PackageReference`s (DEC-T10).
* **Why.** O2, O5: generation with C#'s own toolchain on every build.
* **How.** `Plan.Build(config, schemaRoot)` uses `SuiteDocument`,
  `SuiteExpansion.Cases`, `CaseTags` and the guard rule (expanded steps'
  actions vs `offlineActions` globs). Identifiers per DEC-T06. Templates are
  embedded C# string builders, one per provider, sharing the plan. The
  targets file runs the CLI with `dotnet exec` from the package's `tools/`
  folder; `Inputs`/`Outputs` make it incremental; a design-time-build target
  makes IDEs see the generated files.
* **Files.** `runtimes/csharp/Bdd.Suite/Testing/Plan*.cs`,
  `runtimes/csharp/Bdd.Suite.Testing/**` (new project),
  `runtimes/csharp/Bdd.Suite.Testing/build/Bdd.Suite.Testing.targets`,
  `Bdd.Suite.Cli` (verb).
* **Depends on.** D2.
* **Done when.** E3 passes for C# (plan corpus and golden files); E12's C#
  part passes; unit tests cover identifier sanitising and collisions, guard
  detection and auto-detection.
* **Proved by.** E3, E12.

### <a id="d4"></a>D4. MSTest provider (P0)

* **Result.** The MSTest template (the example in design section 3:
  `[TestClass]`, `[ClassInitialize]`, `[ClassCleanup]`, `[TestInitialize]`,
  `[TestCleanup]`, `[TestMethod]` with display name, `[DataRow]` with
  `DisplayName`, `[TestCategory]`, the assembly class with
  `[AssemblyInitialize]`/`[AssemblyCleanup]`); `.runsettings` parameter
  support; the guarded skip as `Assert.Inconclusive` with the DEC-T09 reason;
  `samples/workspace/tests/csharp/mstest`.
* **Why.** The requested provider; O2.
* **How.** Template from D3's plan. Class cleanup behaviour per the T0 spike:
  either throw from `[ClassCleanup]` (if MSTest reports it without failing a
  passed test) or report through the run-level error channel the spike
  found; record the choice in the provider README. The sample project runs
  the corpus and sample suites and writes TRX and trace files.
* **Files.** `runtimes/csharp/Bdd.Suite/Testing/Templates/MsTest.cs`,
  `samples/workspace/tests/csharp/mstest/**`.
* **Depends on.** D3.
* **Done when.** E4 (MSTest), E9 (C#), E10 (MSTest), E11 (MSTest) pass; E13's
  MSTest part is written.
* **Proved by.** E4, E9, E10, E11, E13.

### <a id="d5"></a>D5. NUnit 4 provider (P1)

* **Result.** NUnit template (`[TestFixture]`, `[OneTimeSetUp]`,
  `[OneTimeTearDown]`, `[SetUp]`, `[TearDown]`, `[Test]`/`[TestCase(TestName=)]`,
  `[Category]`, a `[SetUpFixture]` for the run context, `Assert.Ignore` for
  guarded); `samples/workspace/tests/csharp/nunit`.
* **Why.** O2 for NUnit users.
* **How.** As D4, with the teardown reporting chosen from the spike.
* **Files.** `.../Templates/NUnit.cs`, `samples/workspace/tests/csharp/nunit/**`.
* **Depends on.** D3.
* **Done when.** E4, E10, E11 pass for NUnit.
* **Proved by.** E4, E10, E11.

### <a id="d6"></a>D6. xUnit v3 provider (P1)

* **Result.** xUnit template: a class fixture `IAsyncLifetime` for suite
  setup/teardown, the test class constructor and `IAsyncDisposable` for
  beforeEach/afterEach, `[Fact(DisplayName=)]`/`[Theory]`+`[InlineData]`,
  `[Trait("Category", ...)]`, an assembly fixture for the run context,
  `Assert.Skip` for guarded; `samples/workspace/tests/csharp/xunit`.
* **Why.** O2 for xUnit users (and the runtime's own test framework).
* **How.** As D4.
* **Files.** `.../Templates/XUnit.cs`, `samples/workspace/tests/csharp/xunit/**`.
* **Depends on.** D3.
* **Done when.** E4, E10, E11 pass for xUnit.
* **Proved by.** E4, E10, E11.

### <a id="d7"></a>D7. Go session (P1)

* **Result.** Public `exec.Session` and `exec.RunContext` (`Open`, `Setup`,
  `BeforeEach`, `RunCase`, `AfterEach`, `Teardown`, `Cases`), `RunFile`
  rebuilt on them; the scope builders moved from `internal/suite` to a public
  package where the session needs them; deep copy (`model.Map.DeepClone`);
  a mutex on `trace.Trace` and an atomic `expr.minted`; environment options.
* **Why.** O1 for Go.
* **How.** As D2, in Go: a `sync.Mutex` case lock; recorded failures; the
  per-case loop of `exec.go:541–668` moved into methods.
* **Files.** `runtimes/go/suite/exec/{exec,session,context}.go`,
  `suite/trace/trace.go`, `suite/expr/expr.go`, `suite/model/ordered.go`,
  tests.
* **Depends on.** D1; D2 as the reference shape.
* **Done when.** E1 and E2 pass for Go; `go vet` and `go test -race ./...`
  pass.
* **Proved by.** E1, E2.

### <a id="d8"></a>D8. Go generator and `suitetest` (P1)

* **Result.** `suiterun generate` for Go; package `suite/suitetest` with
  `Main(m *testing.M, ext ...extension.Extension)`, `Open(t, file)`,
  `(*Session).Case(name) func(*testing.T)` (which calls BeforeEach,
  registers AfterEach with `t.Cleanup`, runs the case, reports with
  `t.Error`/`t.Skip`); generated `*_bdd_test.go` with `TestMain` and one
  `TestSuite_<Name>` per suite whose `t.Cleanup` runs teardown;
  `samples/workspace/tests/go`.
* **Why.** O3, O5 for Go.
* **How.** Plan as in D3, in Go; `text/template` templates; `--check` compares
  bytes after `gofmt`.
* **Files.** `runtimes/go/suite/suitetest/**`, `runtimes/go/suite/generate/**`,
  `runtimes/go/suite/cli` (verb), `samples/workspace/tests/go/**`.
* **Depends on.** D7.
* **Done when.** E3, E5, E9, E10, E11, E12 pass for Go.
* **Proved by.** E3, E5, E9–E12.

### <a id="d9"></a>D9. Rust session (P1)

* **Result.** Public `exec::Session` and `exec::RunContext`, `run_file`
  rebuilt on them; `cli::Options::default()` public; environment options.
* **Why.** O1 for Rust.
* **How.** As D2, in Rust: a `Mutex` case guard returned by `before_each` and
  consumed by `after_each`; recorded failures; deep copy already present.
* **Files.** `runtimes/rust/src/{exec,session,cli}.rs`, tests.
* **Depends on.** D1; D2 as reference.
* **Done when.** E1 and E2 pass for Rust; `cargo test` passes.
* **Proved by.** E1, E2.

### <a id="d10"></a>D10. Rust generator and harness (P1)

* **Result.** Feature `testing` in the crate (with `libtest-mimic`):
  `suiterun::testing::generate(config) -> String` for `build.rs`, and
  `suiterun::testing::main(extensions, suites)` that builds the trials, applies
  filters, orders each suite's trials on one thread and adds the teardown
  trial (DEC-T11); `suiterun generate --plan`; `samples/workspace/tests/rust`
  with `build.rs` and a `[[test]] harness = false` target.
* **Why.** O3, O5 for Rust.
* **How.** Plan in Rust; generated code is a static list of suites and cases
  included with `include!`; the harness groups trials by suite and schedules
  suites across threads.
* **Files.** `runtimes/rust/src/testing/**`, `Cargo.toml`,
  `samples/workspace/tests/rust/**`.
* **Depends on.** D9; T0 spike on libtest-mimic filtering.
* **Done when.** E3, E6, E9, E10, E11, E12 pass for Rust.
* **Proved by.** E3, E6, E9–E12.

### <a id="d11"></a>D11. TypeScript session (P1)

* **Result.** Exported `openSession(file, context)`, `createRunContext(...)`
  from the package root and `@bdd-suite/runtime/testing`; `runFile` rebuilt on
  them; deep copy; environment options.
* **Why.** O1 for TypeScript.
* **How.** As D2: a promise-chain case lock; recorded failures; `cloneScope`
  deep; the per-case loop of `exec.ts:286–378` moved into the session.
* **Files.** `runtimes/typescript/src/{exec,session,context,index}.ts`,
  `package.json` exports, tests.
* **Depends on.** D1; D2 as reference.
* **Done when.** E1 and E2 pass for TypeScript; 100% line coverage as today.
* **Proved by.** E1, E2.

### <a id="d12"></a>D12. TypeScript generator and the `node:test`, Vitest and Jest providers (P1)

* **Result.** `suiterun generate` for TypeScript with three templates; the
  testing module's adapters (`suite(file, hooks)` helpers that call the
  framework's `describe`/`before`/`beforeEach`/`it`/`afterEach`/`after`
  passed in, so one module serves three frameworks); per-worker run context;
  `samples/workspace/tests/typescript/{node,vitest,jest}`.
* **Why.** O3, O5 for TypeScript.
* **How.** Generated `*.bdd.test.ts` imports the framework's functions and the
  adapter; guarded cases use the framework's `skip`; Jest/Vitest worker
  settings per the T0 spike.
* **Files.** `runtimes/typescript/src/testing/**`, `src/generate/**`,
  `samples/workspace/tests/typescript/**`.
* **Depends on.** D11.
* **Done when.** E3, E7, E9, E10, E11, E12 pass for TypeScript.
* **Proved by.** E3, E7, E9–E12.

### <a id="d13"></a>D13. PowerShell session (P1)

* **Result.** Exported `Open-BddSuiteSession`, `Invoke-BddSuiteSetup`,
  `Invoke-BddSuiteBeforeEach`, `Invoke-BddSuiteCase`,
  `Invoke-BddSuiteAfterEach`, `Invoke-BddSuiteTeardown`,
  `New-BddSuiteRunContext`; `Invoke-BddSuiteRun` rebuilt on them; deep copy of
  the bag; environment options; the step runspace owned by the run context.
* **Why.** O1 for PowerShell.
* **How.** As D2: the session is a PowerShell class holding what
  `$script:RunState` holds for one file; `$script:RunState` stays for the
  whole-file path only.
* **Files.** `runtimes/powershell/BddSuite/{Runner.ps1,Session.ps1,BddSuite.psd1}`,
  tests.
* **Depends on.** D1; D2 as reference.
* **Done when.** E1 and E2 pass for PowerShell; Pester suite passes.
* **Proved by.** E1, E2.

### <a id="d14"></a>D14. PowerShell generator and Pester provider (P1)

* **Result.** `Invoke-BddSuite -Generate` / `suiterun.ps1 generate`; generated
  `*.Bdd.Tests.ps1` (`Describe` per suite, `BeforeAll`/`AfterAll`,
  `BeforeEach`/`AfterEach`, `It` per case with `-Tag`, `-ForEach` for rows,
  `Set-ItResult -Skipped` for guarded); `samples/workspace/tests/powershell`.
* **Why.** O3, O5 for PowerShell.
* **Files.** `runtimes/powershell/BddSuite/Generate.ps1`,
  `samples/workspace/tests/powershell/**`.
* **Depends on.** D13.
* **Done when.** E3, E8, E9, E10, E12 pass for PowerShell.
* **Proved by.** E3, E8, E9, E10, E12.

### <a id="d15"></a>D15. CI, documentation and release notes (P1)

* **Result.** CI jobs that run E1–E3 per runtime and E4–E12 per provider
  (Windows for C# and PowerShell, Linux for Go, Rust and TypeScript, plus C#
  on Linux), keeping framework reports and traces as artifacts; a "Run suites
  with your test framework" section in each runtime's README and the
  repository README; release notes listing the DEC-T04 behaviour change.
* **Why.** O5, and so a regression in any provider fails a pull request.
* **Files.** `.github/workflows/ci.yml`, `runtimes/*/README.md`, `README.md`,
  `CHANGELOG.md`.
* **Depends on.** D4–D6, D8, D10, D12, D14 (each job added as its provider
  lands).
* **Done when.** Every job passes on a pushed branch (when the user asks to
  push); the READMEs are reviewed.
* **Proved by.** E4–E12 in CI.

### <a id="d16"></a>D16. Editor support for `bddsuite.tests.yaml` (P2)

* **Result.** The VS Code extension validates and completes the config with
  `spec/tests.config.schema.json`, and reads `offlineActions` from the nearest
  config when present.
* **Files.** `package.json` (yaml validation contribution), `src/config/*`.
* **Depends on.** D1.
* **Done when.** E14 passes; unit tests at 100%; `npm run install:local`.
* **Proved by.** E14.

### <a id="d17"></a>D17. Mocha provider (P2)

* **Result.** Mocha template using D12's adapter; sample project.
* **Depends on.** D12.
* **Done when.** E7's checks pass for Mocha.
* **Proved by.** E7 (Mocha row added).

## 2. Order and dependencies

```text
T0 spikes ──> D1 contract ──> D2 C# session ──> D3 C# generator ──> D4 MSTest ──┬─> D5 NUnit
                   │                                                            └─> D6 xUnit
                   ├──> D7 Go session ──> D8 Go provider
                   ├──> D9 Rust session ──> D10 Rust harness
                   ├──> D11 TS session ──> D12 TS providers ──> D17 Mocha (P2)
                   ├──> D13 PS session ──> D14 Pester
                   └──> D16 editor (P2)
     every provider ──> D15 CI and docs ──> T9 lab acceptance (E13)
```

* **Implementation dependencies.** Each arrow. D7, D9, D11 and D13 need only
  D1 and use D2 as the reference shape; once D2 is done they can be built in
  parallel by different people.
* **Runtime prerequisites** (for users): the language toolchain and the
  framework version listed in each scenario; nothing new for `suiterun`
  users.
* **When a team can use it.** Per language, when its provider deliverable
  passes its scenarios; C# with MSTest first (P0). Guarded suites from native
  frameworks are documented as supported only after E13 passes for that
  provider.

## 3. Stages

Each stage lists its result, entry dependencies, priority, steps (at most 20),
exit evidence and size in engineer-weeks.

### Stage T0: spikes and the shared contract (P0)

Result: spike findings; D1. Entry: none. Exit evidence: findings in
`docs/evidence/test-providers-t0.md` with design.md revised where an answer
differs; D1's schema tests; corpus still green. Size: 1–1.5.

- [ ] T0.1 MSTest 3.x: how a throwing `[ClassCleanup]` is reported (TRX, VS, Rider); does it fail a passed test?
- [ ] T0.2 NUnit 4: same for `[OneTimeTearDown]`; `[TestCase(TestName=)]` on a parameterless test.
- [ ] T0.3 xUnit v3: class-fixture dispose failure reporting; assembly fixtures; `Assert.Skip`.
- [ ] T0.4 Jest and Vitest: `afterAll` failure reporting; worker count control per project.
- [ ] T0.5 MSTest `[DataRow(DisplayName=)]` and `[TestMethod(displayName)]` in TRX, VS and Rider Test Explorer.
- [ ] T0.6 C#: MSBuild-target output visible to VS and Rider design-time builds.
- [ ] T0.7 libtest-mimic: reading filters before running; ordering a group on one thread.
- [ ] T0.8 Pester 5: discovery of generated files with `-ForEach` rows; `AfterAll` failure reporting.
- [ ] T0.9 Record findings; revise DEC-T05, DEC-T08, DEC-T10, DEC-T11 as needed.
- [ ] T0.10 `spec/session.md`.
- [ ] T0.11 `spec/tests.config.schema.json` with schema tests.
- [ ] T0.12 `capture-isolation` and `nothing-selected` execute entries; Rust confirms `capture-isolation`.
- [ ] T0.13 Plan format and `conformance/generate/` suites with expected plans.
- [ ] T0.14 Manifest `generate` kind; each runtime's corpus test skips it; all corpus tests green.

### Stage T1: C# session (P0)

Result: D2. Entry: T0. Exit evidence: E1 and E2 for C#. Size: 1.5–2.

- [ ] T1.1 `RunContext`: compose, start once, options, params, tags, dry run.
- [ ] T1.2 `RunContext.FromEnvironment` and `.runsettings` reader (DEC-T09).
- [ ] T1.3 `SuiteSession.Open`: parse, expand, resolve, case list.
- [ ] T1.4 `Setup` lazy and idempotent, recording failure.
- [ ] T1.5 `BeforeEach` with case lock, recording failure.
- [ ] T1.6 `RunCase` from a deep copy; recorded failures reported as today.
- [ ] T1.7 `AfterEach`, failure appended, lock released in `finally`.
- [ ] T1.8 `Teardown` once if setup ran; pseudo-case `teardown` for the whole-file path.
- [ ] T1.9 Thread-safe `Trace`; `BDD_SUITE_TRACE_FILE` writer.
- [ ] T1.10 `Executor.RunFile` rebuilt on the session.
- [ ] T1.11 Unit tests per operation; E1 for C# (both orders).
- [ ] T1.12 E2 for C#: unit tests, corpus, divergence check, VS Code integration suite.

### Stage T2: C# generator and MSTest (P0)

Result: D3, D4. Entry: T1. Exit evidence: E3 (C#), E4 (MSTest), E9 (C#),
E10 (MSTest), E11 (MSTest), E12 (C#); E13 (MSTest) written. Size: 2.

- [ ] T2.1 `Plan.Build`: suites, cases, rows, tags, guarded, identifiers.
- [ ] T2.2 `suiterun generate --plan`; E3 plan check for C#.
- [ ] T2.3 `Bdd.Suite.Testing` project: `BddSuiteRun`, `ThrowIfFailed`, guarded skip.
- [ ] T2.4 MSTest template; golden files.
- [ ] T2.5 MSBuild targets: incremental generation, `Compile` items, design-time build.
- [ ] T2.6 Provider auto-detection from package references.
- [ ] T2.7 `--check` mode.
- [ ] T2.8 Teardown failure reporting as chosen in T0.1; README note.
- [ ] T2.9 `samples/workspace/tests/csharp/mstest`: corpus and sample suites.
- [ ] T2.10 TRX and trace comparison harness (shared by later providers).
- [ ] T2.11 E4 for MSTest (filters, setup/teardown counts, parallel).
- [ ] T2.12 E9 for C#; `manual` Visual Studio and Rider check recorded.
- [ ] T2.13 E10 and E11 for MSTest.
- [ ] T2.14 E12 for C#.
- [ ] T2.15 E13 written and linted for MSTest.

### Stage T3: NUnit and xUnit (P1)

Result: D5, D6. Entry: T2. Exit evidence: E4, E10, E11 for both. Size: 1.5.

- [ ] T3.1 NUnit template and golden files; `[SetUpFixture]` run context.
- [ ] T3.2 NUnit teardown reporting per T0.2.
- [ ] T3.3 `samples/workspace/tests/csharp/nunit`; E4, E10, E11 for NUnit.
- [ ] T3.4 xUnit v3 template and golden files; class and assembly fixtures.
- [ ] T3.5 xUnit skip and trait mapping.
- [ ] T3.6 `samples/workspace/tests/csharp/xunit`; E4, E10, E11 for xUnit.

### Stage T4: Go (P1)

Result: D7, D8. Entry: T0 (T1 as reference). Exit evidence: E1, E2, E3, E5,
E9–E12 for Go. Size: 2–2.5.

- [ ] T4.1 Move the needed scope builders out of `internal/suite`.
- [ ] T4.2 `RunContext` and environment options.
- [ ] T4.3 `Session` operations with recorded failures and a case mutex.
- [ ] T4.4 Deep copy; mutex on `Trace`; atomic `expr.minted`.
- [ ] T4.5 `RunFile` rebuilt; E1 and E2 for Go; `go test -race`.
- [ ] T4.6 Plan and `suiterun generate --plan`; E3 for Go.
- [ ] T4.7 `suitetest` package: `Main`, `Open`, `Case`.
- [ ] T4.8 Template, `gofmt`, `--check`; golden files.
- [ ] T4.9 `samples/workspace/tests/go`; E5.
- [ ] T4.10 E9, E10, E11, E12 for Go.

### Stage T5: Rust (P1)

Result: D9, D10. Entry: T0 (T1 as reference). Exit evidence: E1, E2, E3, E6,
E9–E12 for Rust. Size: 2.5–3.

- [ ] T5.1 Public `cli::Options::default`; `RunContext` and environment options.
- [ ] T5.2 `Session` operations with recorded failures and a case guard.
- [ ] T5.3 `run_file` rebuilt; E1 and E2 for Rust.
- [ ] T5.4 Plan and `suiterun generate --plan`; E3 for Rust.
- [ ] T5.5 Feature `testing`: `generate` for `build.rs`.
- [ ] T5.6 Harness: trials per case and row, teardown trial, filter handling.
- [ ] T5.7 Harness scheduling: one thread per suite, suites in parallel.
- [ ] T5.8 `samples/workspace/tests/rust`; E6.
- [ ] T5.9 E9, E10, E11, E12 for Rust.

### Stage T6: TypeScript (P1)

Result: D11, D12. Entry: T0 (T1 as reference). Exit evidence: E1, E2, E3,
E7, E9–E12 for TypeScript. Size: 2.5–3.

- [ ] T6.1 `createRunContext` and environment options.
- [ ] T6.2 `openSession` operations with recorded failures and a case lock.
- [ ] T6.3 Deep copy; `runFile` rebuilt; exports; E1 and E2 for TypeScript (100% coverage).
- [ ] T6.4 Plan and `suiterun generate --plan`; E3 for TypeScript.
- [ ] T6.5 Testing adapter taking the framework's hook functions.
- [ ] T6.6 `node:test` template; sample project; E7 for `node:test`.
- [ ] T6.7 Vitest template; per-worker context; sample project; E7 for Vitest.
- [ ] T6.8 Jest template; teardown reporting per T0.4; sample project; E7 for Jest.
- [ ] T6.9 `--check`; E9, E10, E11, E12 for TypeScript.

### Stage T7: PowerShell (P1)

Result: D13, D14. Entry: T0 (T1 as reference). Exit evidence: E1, E2, E3, E8,
E9, E10, E12 for PowerShell. Size: 2.

- [ ] T7.1 Session class and exported functions; run context owns the step runspace.
- [ ] T7.2 Recorded failures; deep copy of the bag.
- [ ] T7.3 `Invoke-BddSuiteRun` rebuilt; E1 and E2 for PowerShell.
- [ ] T7.4 Plan and `-Generate -Plan`; E3 for PowerShell.
- [ ] T7.5 Pester template with tags, rows, guarded skip; `-Check`.
- [ ] T7.6 `samples/workspace/tests/powershell`; E8.
- [ ] T7.7 E9, E10, E12 for PowerShell.

### Stage T8: CI and documentation (P1)

Result: D15. Entry: the providers to be covered. Exit evidence: CI green on a
pushed branch for every job (pushed only when the user asks). Size: 1.

- [ ] T8.1 CI jobs for E1–E3 per runtime.
- [ ] T8.2 CI jobs for each provider's sample project with report and trace artifacts.
- [ ] T8.3 READMEs: runtime sections and repository overview.
- [ ] T8.4 CHANGELOG and release notes (DEC-T04 behaviour change).

### Stage T9: lab acceptance (P1, remote)

Result: E13. Entry: T2 and T7 (MSTest and Pester), a real lab and the
os-context jump path available. Exit evidence: E13's records (lab id, run ids,
per-case comparison with the `suiterun` reference, os-context's cleanup
evidence). Size: 0.5 plus lab time.

- [ ] T9.1 os-context worktree consuming the runtimes; generated projects for the stage 0 lab suite.
- [ ] T9.2 `suiterun` reference run; results recorded.
- [ ] T9.3 MSTest run; comparison recorded.
- [ ] T9.4 Pester run; comparison recorded.
- [ ] T9.5 Cleanup evidence; any failure kept with its lab state, scenario left open.

### Stage T10: editor support and Mocha (P2)

Result: D16, D17. Entry: D1 (D16), D12 (D17). Exit evidence: E14; E7 for
Mocha. Size: 1–1.5.

- [ ] T10.1 Config schema contribution and validation in the extension.
- [ ] T10.2 `offlineActions` read from the nearest config.
- [ ] T10.3 Unit tests at 100%; `npm run install:local`; E14.
- [ ] T10.4 Mocha template and sample; E7 for Mocha.

## 4. Acceptance index

| Scenario | Proves | Deliverables | Stage(s) | Status |
| --- | --- | --- | --- | --- |
| [E1](design.md#e1) | O1, O4 | D1, D2, D7, D9, D11, D13 | T1, T4, T5, T6, T7 | not run |
| [E2](design.md#e2) | O1 | D2, D7, D9, D11, D13 | T1, T4, T5, T6, T7 | not run |
| [E3](design.md#e3) | O2, O3 | D1, D3, D8, D10, D12, D14 | T2, T4–T7 | not run |
| [E4](design.md#e4) | O2, O4 | D4, D5, D6 | T2, T3 | not run |
| [E5](design.md#e5) | O3, O4 | D8 | T4 | not run |
| [E6](design.md#e6) | O3, O4 | D10 | T5 | not run |
| [E7](design.md#e7) | O3, O4 | D12, D17 | T6, T10 | not run |
| [E8](design.md#e8) | O3, O4 | D14 | T7 | not run |
| [E9](design.md#e9) | O2, O3, O5 | D4, D8, D10, D12, D14 | T2, T4–T7 | not run |
| [E10](design.md#e10) | O4 | D4–D6, D8, D10, D12, D14 | T2–T7 | not run |
| [E11](design.md#e11) | O4 | D4–D6, D8, D10, D12 | T2–T6 | not run |
| [E12](design.md#e12) | O5 | D3, D8, D10, D12, D14 | T2, T4–T7 | not run |
| [E13](design.md#e13) | O4 | D4, D14 (and the sessions) | T9 | not run; no lab available today |
| [E14](design.md#e14) | P2 | D16 | T10 | not run |

## 5. Effort

Engineer-weeks for one engineer who knows the runtimes; estimates for
planning, which the T0 spikes may move.

| Part | Stages | Weeks |
| --- | --- | --- |
| Spikes and shared contract | T0 | 1–1.5 |
| C# session, generator, MSTest (P0) | T1, T2 | 3.5–4 |
| NUnit and xUnit | T3 | 1.5 |
| Go | T4 | 2–2.5 |
| Rust | T5 | 2.5–3 |
| TypeScript (three providers) | T6 | 2.5–3 |
| PowerShell | T7 | 2 |
| CI and docs | T8 | 1 |
| Lab acceptance | T9 | 0.5 + lab time |
| **P0 only (C# + MSTest)** | T0–T2 | **4.5–5.5** |
| **P0 + P1 (all five languages, nine providers)** | T0–T9 | **16.5–19** |
| P2 (editor support, Mocha) | T10 | 1–1.5 |

The language stages T4–T7 depend only on T0 and use T1 as their reference, so
with several people they run in parallel and the elapsed time is roughly
T0 + T1–T2 + the longest language stage + T8.
