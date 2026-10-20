# Stage K1 evidence: C# end to end

Plan: [docs/packages/implementation.md](../packages/implementation.md#stage-k1-c-end-to-end-p0).
Recorded 2026-10-20 on Windows 11, .NET 10 SDK, on top of `3998301` with K0
and K1 uncommitted. **Status: built; locally accepted (E1 and E2 for C#, E7 and
E8 for C#); CI not run** (nothing pushed; nothing published).

## What was built

| Where | What |
| --- | --- |
| `Bdd.Suite/Cli/CommandLine.cs`, `Extensions/Composite.cs` | **D2.** `--name glob[,glob]` (repeatable, comma-separated, trimmed) and `--progress`; both in the usage and among the core flags an extension may not take. |
| `Bdd.Suite/Execution/SuiteExpansion.cs`, `SuiteSession.cs`, `Executor.cs`, `Run/Runner.Running.cs` | `SuiteExpansion.NameMatches` (the `--path` glob over the whole name); a session's selection is the tag filter **and** the names; `list` applies both; `RunOptions.Names`. |
| `Bdd.Suite/Execution/Executor.cs`, `Tracing/Trace.cs`, `Run/ProgressPrinter.cs` (new) | `IRunObserver` with `CaseStarted`, `CaseFinished` **and `Entry`** (spec/progress.md: an observer is told of every trace entry); `RunFile` attaches it to the trace for the file and detaches it after, never in a dry run, and reports only selected cases; `Trace.Added` is called outside the trace's lock; `ProgressPrinter` writes the spec's lines to `Runner.ProgressWriter` (standard output); `Summary` after the last file. |
| `Bdd.Suite/Execution/Executor.cs` | The action worker catches every exception, not five types (spec/progress.md, "The action worker"). |
| `Bdd.Suite/Schema/SuiteSchema.cs`, `Bdd.Suite.csproj` | `spec/core.catalog.yaml` embedded (`Bdd.Suite.core.catalog.yaml`); `imports: [ bdd-suite:core ]` reads it, each core action's bindings cut to the importer's `bindings` list; `SuiteSchema.CoreCatalogText()`. |
| `Bdd.Suite.Tests/NamesAndProgressTests.cs` (new), `Where.cs` | **K1.5.** update2's patch tests P2-P5 rewritten as xUnit tests, plus the parts the corpus does not reach: the flags parsed and in the usage, glob matching, the `lists` corpus entries, the trace callback, an observer that hears only selected cases and changes nothing (same trace JSON with and without it, detached afterwards), a dry run that tells it nothing, the printer's every line kind, progress on standard output by default, a run without `--progress` printing nothing and one with it summarising three files, the worker, the embedded core equal to the spec's and the cut. The corpus extension implements `fixture.throw` with an exception type nothing in the runtime names. |
| `Bdd.Suite.Tests/{Execute,Validate}CorpusTests.cs`, `SessionTests.cs`, `ConformanceTests.cs` | **K1.6.** Entries' `names`, `schemaRoot` and `progress` honoured (progress lines captured from `Runner.ProgressWriter` and compared with `progress.expected.txt` after the spec's masking; no line printed without `--progress`); counts 42 validate and 20 execute. |
| `conformance/run-manifest.yaml` | `csharp` removed from `pendingIn` of the seven K0 entries and the two `lists` entries. |
| `samples/workspace/tests/harness/corpus.mjs` | An entry with `names` or `progress` proves a `suiterun` flag and is skipped as "command line only" under a test framework, which selects with its own filter and traces only what it runs (session rule 8). |
| `samples/workspace/tests/csharp/shared/CorpusExtension.cs` | `fixture.throw`, so `worker-throws.yml` runs through MSTest, NUnit and xUnit. |
| `runtimes/csharp/Directory.Build.props` | **D7.** Package metadata for every packable project (MIT expression, project and repository URL, tags, symbols as `.snupkg`, deterministic, `ContinuousIntegrationBuild` on GitHub Actions; the SDK's SourceLink); `IsPackable` false by default; packages to `artifacts/packages`. |
| `Bdd.Suite/Bdd.Suite.csproj` | Packable, `Bdd.Suite`, the runtime README; **K1.8** dependency ranges `[16.2.1, 17.0.0)` and `[7.4.0, 8.0.0)`. |
| `Bdd.Suite.Testing/Bdd.Suite.Testing.csproj` | Packable, its own README; the published `suiterun` (framework-dependent, no app host, no `.pdb`) under `tools/net10.0/`; the targets under `build/` only; a private reference to `Bdd.Suite.Cli` so it is built first and never becomes a package dependency. |
| `Bdd.Suite.Testing/build/Bdd.Suite.Testing.targets` | Two modes: from the package, the generator in `tools/` (an error naming the path if it is missing); in a checkout, built from `Bdd.Suite.Cli` two folders up, found by the targets themselves. |
| `packaging/Bdd.Suite{,.Testing}.files.txt`, `scripts/Test-PackageContents.ps1` | **K1.11.** The expected contents, and the check: exactly the listed files, the id, the release version, MIT, a README it holds, the repository, a description. |
| `scripts/local-feeds.ps1` | **K1.13.** Packs C# into `artifacts/feeds/nuget` (cleared first) and checks each package. |
| `samples/consumers/csharp/` | **K1.12-K1.14.** The greeter: a catalog importing `bdd-suite:core`, two suites (one guarded), an extension, its `suiterun`, MSTest, NUnit and xUnit projects, central package management, `nuget.config` with package source mapping (Bdd.Suite only from the local feed), and `run-e2.ps1`. |
| `runtimes/csharp/README.md`, `Bdd.Suite.Testing/README.md` | **K1.15.** "Install" (both packages, the one-line `suiterun`, `bdd-suite:core`, the new flags, the version rule, the consumer sample by its GitHub URL, since nuget.org shows this page); "Use it" leads with the package; the checkout way second. |
| `.github/workflows/ci.yml` | `providers-csharp` runs `run-e2.ps1` (E1 and E2). |
| `.gitignore` | `/artifacts/` (the feeds) and the consumers' build output. |

## Decisions taken in the stage

* **The observer is told of entries itself.** The patch hooked
  `Trace.Added` to the printer in the runner; the spec says an observer hears
  every entry, so `IRunObserver.Entry` exists and `RunFile` wires it. A
  consumer that implemented the patch's two-method interface adds one method.
* **`build/` only, not `buildTransitive/`** (the plan said both): through
  `buildTransitive`, a library that references `Bdd.Suite.Testing` would make
  every project that references the library generate tests.
* **The targets detect a checkout** rather than the samples setting
  `BddSuiteCliProject` (the plan's K1.10): one rule, no sample changes.
* **`Bdd.Suite.Testing` depends on `Bdd.Suite >= 0.6.10`**, NuGet's form for a
  project reference. The README says to keep both at one version; a consumer
  under central package management pins both.
* **E2 takes an upstream feed.** This machine has nuget.org disabled and
  restores through a mirror (`packagefeedproxy.microsoft.io`);
  `run-e2.ps1 -Upstream <feed>` swaps it in through a generated
  `RestoreConfigFile`, and the local feed stays the only source of a
  `Bdd.Suite` package. CI uses nuget.org.

## Step by step

| Step | Status | Evidence |
| --- | --- | --- |
| K1.1 `--name` | done | Unit tests; corpus `names*.yml`, `lists`. |
| K1.2 Observer, `Trace.Added`, `ProgressPrinter`, `--progress` | done | Unit tests; corpus `progress.yml` against `progress.expected.txt`. |
| K1.3 The worker catch-all | done | Unit test; corpus `worker-throws.yml` through `suiterun`, the session, and MSTest, NUnit, xUnit. |
| K1.4 Embedded core; `bdd-suite:core` with the cut | done | Unit tests; corpus `validate/core-import.yml` (E201 at 6:17 and 8:17) and `execute/core-import.yml`. |
| K1.5 Patch tests ported | done | `NamesAndProgressTests.cs`, 17 tests. |
| K1.6 The corpus with K0's entries; C# not pending | done | 42 validate, 20 execute, 2 lists; none pending in C#. |
| K1.7 Package metadata, SourceLink, symbols, `IsPackable` | done | `.nuspec` read back: license, readme, repository with commit, tags. |
| K1.8 Dependency ranges | done | `.nuspec`: `[16.2.1, 17.0.0)`, `[7.4.0, 8.0.0)`. |
| K1.9 Generator under `tools/`, targets under `build/` | done | Package listing below. |
| K1.10 Two modes in the targets; the samples unchanged | done | The samples' build and providers below. |
| K1.11 Expected contents and the check (E1, C#) | done | Both pass; a list with an extra file fails ("lacks extra.txt", exit 1). |
| K1.12 `samples/consumers/csharp` | done | |
| K1.13 Local feed script; E2 with MSTest | done | `run-e2.ps1`. |
| K1.14 E2 with NUnit and xUnit | done | `run-e2.ps1`. |
| K1.15 The C# README's package section | written; for the user's review | |

## Runs

| Run | Result |
| --- | --- |
| By hand, the built `suiterun`: `list --name '*-an-order,order-?'` on `names.yml`; `run --name 'the-*-case' --progress` on `progress.yml`; `lint --binding-check --binding go` against `schema-core-import`; `run` of `core-import.yml` | the three cases; the transcript's lines (after masking); E201 at 6:17 and 8:17; passed |
| `dotnet test Bdd.Suite.Tests`, then `dotnet build` and `dotnet test Bdd.Suite.sln --no-build` as CI runs it | 237 passed (220 before K1, 17 new) |
| `dotnet pack Bdd.Suite.sln -c Release` | `Bdd.Suite.0.6.10.nupkg` (3 files: nuspec, README, `lib/net10.0/Bdd.Suite.dll`) and `Bdd.Suite.Testing.0.6.10.nupkg` (13: nuspec, README, `build/Bdd.Suite.Testing.targets`, `lib/net10.0/Bdd.Suite.Testing.dll`, `tools/net10.0/` with `suiterun.dll`, its runtimeconfig and deps, `Bdd.Suite.dll`, YamlDotNet, JsonSchema.Net and its three dependencies), each with a `.snupkg` |
| `Test-PackageContents.ps1` on both | 3 and 13 files as listed, 0.6.10, MIT, README, repository |
| `dotnet build` of `samples/workspace/tests/csharp/mstest` (checkout mode) | succeeded; 30 generated files |
| `samples/consumers/csharp/run-e2.ps1 -Upstream https://packagefeedproxy.microsoft.io/nuget/v3/index.json` | **E2 passed**, 15 checks: no project file points into the repository; restore under central package management; `Bdd.Suite 0.6.10` from the local feed in the consumer's own cache; `lint` clean through `bdd-suite:core`; `list --name '*hello'`; `run --name --progress` with its `StartGroup` and `Summary`; and under MSTest, NUnit and xUnit: `says-hello` and `the-core-still-works` Passed and the guarded `shouts-hello` NotExecuted; all three Passed with `BDD_SUITE_ALLOW_GUARDED=1`; the smoke filter selects `says-hello` alone |
| `harness/corpus.mjs --provider mstest` after `fixture.throw` | 16 corpus entries and 9 sample suites, 0 differ (`worker-throws` and `core-import` through MSTest; the four name and progress entries "command line only") |
| Harness and scenarios for `mstest`, `nunit`, `xunit` after the packaging changes | 6 of 6 exit 0: each 16 corpus entries and 9 sample suites, 0 differ; scenarios 5 of 5 each |

## Open

* **CI**, including the new E1/E2 step in `providers-csharp`.
* **K1.15** awaits the user's review.
* Go, Rust, TypeScript and PowerShell stay pending on the K0 entries until K2 to K5.
