# Stage S3 evidence: the C# runtime

Plan: [docs/self-contained/implementation.md](../self-contained/implementation.md#stage-s3-c-runtime-p0).
Recorded 2026-10-15, on Windows 11 with the .NET SDK 10.0.402. Built by an
agent that followed the TypeScript runtime (S1) as the reference and the Go
and Rust ports (S2) as precedent. **Every result below was rerun by hand
after the agent reported.** Nothing has run in CI yet (S3.7).

## Source and baseline

Copied with `git archive 7633e176 test/e2e/bindings/dotnet` from the os-context
worktree `E:\work\os\os-context-ts` (commit
`7633e176fb70140e94ddc7e9d96b07eb39c39b22`, tracked files only). os-context was
not modified. Before the move, in the worktree, `dotnet build Hci.E2E.Suite.sln`
was clean and `dotnet test` passed **184 tests**.

## What changed (S3.1-S3.6, D6)

* **Renamed (DEC-S04):**
  * `Hci.E2E.Suite` to `Bdd.Suite`;
  * `Hci.E2E.Suite.Cli` to `Bdd.Suite.Cli`, whose assembly is still `suiterun`;
  * `Hci.E2E.Suite.Tests` to `Bdd.Suite.Tests`;
  * the solution, to `Bdd.Suite.sln`.

  Namespaces and `InternalsVisibleTo` follow. `Directory.Build.props` (net10.0,
  warnings as errors, `artifacts/` output) is kept.
* **Removed:**
  * `Actions/Lifecycle/*` (the lifecycle context, its 18 actions, the event stream);
  * `LifecycleTests.cs`, `EventStreamTests.cs`, `LoopbackServer.cs`;
  * the single `IActionDispatcher` slot and the hard-wired `new LifecycleContext(...)` in the runner.
* **Also removed:**
  * the lab options and run-option fields;
  * `cluster`/`target`/`labId`/`apiUrl` as expression roots and dataflow keys;
  * `HCI_SUITE_*`;
  * `IsLifecycle`, the 900 s ceiling and budget;
  * E214;
  * `RepositoryPaths.CorpusRoot`.
* **The extension API (`Bdd.Suite.Extensions`):**
  * `IExtension`, whose parts all default to adding nothing, and `Extension`, which sets them as properties;
  * `ActionRegistration`, `ExtensionOption`, `ExtensionRules { Lint, CaseLimitSec }`, `RunState`, `RuleInput` (with the suite's imports), `ExtensionException`;
  * `Composite.Compose(...)`, with the TypeScript refusal messages, and `DefaultEnvPrefix = "BDD_SUITE_"`.
* **Entry points:**
  * `Runner.Run(args, stdout, stderr, params IExtension[] extensions)`; `Bdd.Suite.Cli` calls it with none;
  * `Executor.RunFile(..., RunExtensions? run)`.
* **Behaviour:**
  * The catalog loader follows `imports`, refusing duplicates and cycles.
  * `--schema-root` works without a workspace above the working directory. The
    original refused even with it.
  * Reports pass through the extensions' redaction.
  * An unregistered action fails with "Unknown action: X. No extension of this runtime registers it."
* **The example:** `Bdd.Suite.Example` is its own exe project that references
  only `Bdd.Suite`, so it reaches only public types. Its schema imports the
  core catalog.

## Results (from `runtimes/csharp`)

| Check | Result |
| --- | --- |
| `dotnet build Bdd.Suite.sln --nologo` | **0 warnings, 0 errors** (warnings are errors) |
| `dotnet test Bdd.Suite.sln --no-build` | **166 passed, 0 failed, 0 skipped** |
| Validate corpus | `EveryValidateEntry` passed, asserting **41** entries checked |
| Execute corpus | `EveryExecuteEntry` passed, asserting **11** |
| Reports | `ThreeRunsInBothFormatsCanonicaliseToWhatIsStored` passed, asserting **7** |
| Expression and assertion tables | every row (`EveryRowOfTheExpressionTable`, `EveryRowOfTheAssertionTable`) |
| Manifest | names every file, and every file under `validate/` and `execute/` is an entry or support |
| Core catalog against registered actions | `TheCoreCatalogsCsharpSetIsExactlyTheRegisteredNames`: the 6 core actions |
| E3 (`ExampleTests`, 4 tests, plus `ExtensionTests`) | with the extension the run passes and lint is only `E205 5:17`; without it lint is only `E301 9:15`, `--region` is refused, the run fails, and a copy without `${region}` fails with the unknown-action message; two extensions with one action are refused; the slow rule caps a case at run time; the example runs as a separate process |
| Example schema | `Build-Schema.ps1 -Catalog runtimes/csharp/Bdd.Suite.Example/schema/actions.catalog.yaml -Check`: current |

The test count went from 184 to 166. The lifecycle, event-stream and loopback
tests went with the code they tested; the extension, import, corpus and E3
tests came in.

## The os-context scan

A search for the following found nothing outside two kinds of exception:
* the words: os-context, `HCI`, `Hci.E2E`, `cluster.state`/`suspend`, `test/e2e/conformance`, lifecycle, `labId`/`apiUrl`, `--api-url`/`--lab-id`;
* the exceptions: (a) the test that proves the removed flags are refused, and one comment on where the lifecycle and E214 entries went; (b) the corpus test extension's context keys (`Where.cs`).

## S3.7: CI (built, open)

* **`ci.yml` gained `runtime-csharp`:** set up .NET 10, `dotnet build`, `dotnet test`.
* **The release job** waits for it.
* **The `spec` job's staleness check** covers the C# example's schema. I
  first wrote that path wrongly, as `runtimes/csharp/example/`, and corrected
  it to `Bdd.Suite.Example/`.
* **Not run:** CI runs on GitHub after a push.

## State of E2 and E3

Four of the five runtimes (TypeScript, Go, Rust, C#) pass the whole relocated
corpus and E3 locally. PowerShell and the divergence check are stage S4.
