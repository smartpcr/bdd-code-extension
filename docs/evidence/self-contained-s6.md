# Stage S6 evidence: os-context consumes the pin

Plan: [docs/self-contained/implementation.md](../self-contained/implementation.md#stage-s6-os-context-consumes-the-pin-p1-os-context-worktree).
Recorded 2026-10-15 and 2026-10-16 on Windows 11 with Go 1.26.4, Rust 1.96.0,
.NET SDK 10.0.402, Node.js 24.16, PowerShell 7.6.7 (and Windows PowerShell 5.1
for the wrapper's relaunch), Pester 5.7.1 and powershell-yaml 0.4.12.

The os-context side was built by nine agents: one per language; then the
PowerShell runtime's per-case hooks; the runner wrapper; the remaining tests;
and the documentation. **Every result in the tables below was rerun by hand
after they reported**, except where a row says it is the agent's. Nothing has
run in CI, nothing is pushed, and no release exists yet.

## What this stage proves, and what it does not

* **Proved locally (E5, local half).** os-context, built from the pinned
  runtimes and its own extensions, gives the same results as before:
  * every binding's action list is identical;
  * the lint of every checked-in suite, plain and with `--binding-check` for
    each of five targets, is identical;
  * the generated schema is the same check;
  * os-context's own conformance entries pass under all five bindings;
  * its Pester tests have no new failure.

  These hold for this build and these inputs.
* **Not proved.**
  * **E7 and the tag pin:** no release has been made. The pin is a local
    commit, not a tag.
  * **E5's workflow half (S6.17):** os-context's branch is not pushed.
  * **E6, the lab:** stage S7.

## Commits and trees

| What | Identity |
| --- | --- |
| os-context base | `7633e176fb70140e94ddc7e9d96b07eb39c39b22` plus the uncommitted stage-B7 changes of the worktree `E:\work\os\os-context-ts`, applied unchanged (`git diff --binary` and the untracked TypeScript binding). This is the same source the runtimes were copied from in S1 to S4. |
| os-context worktree for S6 | `E:\work\os\os-context-pin`, branch `bdd-suite-pin`, created from that base. Nothing in it is committed. `E:\work\os\os-context` and `E:\work\os\os-context-ts` were not modified; `os-context-ts` still shows its original 20 changed paths. |
| Baseline copy for the "before" tests | a detached worktree of the same base under the scratchpad (`oc-before`) |
| bdd-suite commits made in S6 (local, not pushed) | `1b27c5f`: the release tags the Go module, and BddSuite option flags use lower-case words. `e5a3214`: per-case hooks in the PowerShell runtime. |
| Submodule `test/e2e/bdd` | URL `https://github.com/smartpcr/bdd-code-extension.git`, pinned to `e5a3214`. The commit was fetched from the local repository because it is not on GitHub yet. |

## S6.1: the release tags the runtimes (D12)

The release job in `.github/workflows/ci.yml` now does three things. Built; not
run, because no release has been made (the open part of S6.1 and E7):
1. **Release notes:** after the Marketplace publish, it writes notes listing
   the runtime versions: the Go module tag, the Rust crate, C# by project
   reference, the TypeScript package and lint API, and the PowerShell module.
   The step's script ran locally and printed the table for v0.6.0.
2. **The release:** it creates the GitHub release `v<version>` with those notes
   followed by the generated ones.
3. **The Go module tag:** it creates `runtimes/go/v<version>` at the commit the
   release tag names. It fails if an existing tag names a different commit (E7's
   "both tags point at the same commit").

**Blocked:** a release needs `main` pushed and the repository variables
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` set (README,
Releasing). The tag is created after the publish, so without them there is no
tag to pin.

## S6.4: the baseline

Captured in the base tree, before any change. The scripts are kept in the
scratchpad (`capture.sh`, `compare.mjs`):
* **Action lists:** `suiterun actions --json` for Go, Rust, C# and TypeScript
  (24 each). PowerShell had no program; its list came from the registry
  `Get-LabActionNames` (100).
* **Lint:** of `test/e2e/suites`, `test/e2e/provisioning` and
  `test/e2e/provisioning/recovery`, plain and with `--binding-check --binding
  <t>` for each of the five targets, under each binding (PowerShell through
  `Invoke-SuiteLint`, as `suite-lint.yml` called it).
  * 90 lint files.
  * Plain lint is clean everywhere.
  * The binding checks find 444, 572 and 139 E201 findings in the three
    directories.
* **Schema:** os-context's `Build-Schema.ps1 -Check` passed; `suite.schema.json`
  and `.md` were saved.
* **Pester:** 242 test files under `scripts/e2e`, `scripts/labs`, `test/e2e` and
  `docs/e2e`: 5478 passed, **34 failed** before any change.

## S6.2, S6.3, S6.10, S6.11: worktree, submodule, catalog, corpus

* **Submodule:** `test/e2e/bdd`.
* **Catalog** (`test/e2e/schema/actions.catalog.yaml`):
  * imports `../bdd/spec/core.catalog.yaml`;
  * lists `os-context.suite.json` (the handed-over `requires`, `sharedChecks`,
    `cluster`, `target`) under `suiteSchema`;
  * drops its own `core.*` and `wait` entries.
* **Schema generator:** `pwsh test/e2e/bdd/spec/Build-Schema.ps1 -Catalog
  test/e2e/schema/actions.catalog.yaml`. `-Check` reports it current.
* **Deleted from `test/e2e/schema`:** os-context's own `Build-Schema.ps1`,
  `suite.base.json`, `actions.catalog.schema.json`, `diagnostic.schema.json` and
  `diagnostics.md`. os-context's rules are now in `os-context.diagnostics.md`.
* **`test/e2e/conformance`** keeps only os-context's own entries:
  * the seven `lifecycle-*` and `shared-checks-*` entries and
    `_lib/shared-checks.yml`, byte-identical to the handover and to the base;
  * a new `run-manifest.yaml`;
  * `Invoke-ExtensionCorpus.ps1`, which lints each entry with any binding's
    `suiterun` and compares codes, severities, positions and exit codes;
  * a README.

  The rest of the corpus is the submodule's. Before the change, the runner
  passed 7 of 7 against the four old compiled bindings.

**The schema is the same check, not the same bytes.** E5 said "identical". The
generated file differs in wording, by design, so E5 now says what is compared
(design, E5). Measured:
* **Same check:** with `$id`, `title` and `description` removed, keys sorted,
  and the action enum and its per-action branches compared as sets, the old and
  new schemas are identical (`semantic.mjs`).
* **The differences are wording and order only:**
  * the header (`$id`, title, generator note);
  * the core's neutral text from S1 (three descriptions: `limit`,
    `paramDecl.input`, `why`);
  * one description added to `stepEnvelope.requires`;
  * the imported core actions listed before os-context's own;
  * the extension's fields placed after the core's.

## S6.5 to S6.9: each binding is os-context's extension on its runtime

| Binding | os-context's part | Program | Tests (rerun) |
| --- | --- | --- | --- |
| Go | `test/e2e/bindings/go`: module `suiterun` with `replace` to `../../bdd/runtimes/go`; `oscontext/` (extension, rules); `lifecycle/` (18 actions); `cmd/suiterun` | `go build ./cmd/suiterun` | `gofmt`, `go vet` clean; `lifecycle` and `oscontext` ok (68 tests, agent's count) |
| Rust | `test/e2e/bindings/rust`: package `os-context-suiterun`, path dependency on the runtime; `src/extension.rs`, `actions.rs`, `rules.rs`, `lifecycle/` | `target/debug/suiterun.exe` | 49 + 3 + 13 passed |
| C# | `test/e2e/bindings/dotnet`: `Hci.E2E.Suite.Lifecycle` (extension), `Hci.E2E.Suite.Cli`, `Hci.E2E.Suite.Tests`; project references into the submodule; build output stays under the binding | `artifacts/bin/Hci.E2E.Suite.Cli/Debug/net10.0/suiterun.exe` | 0 warnings; 63 passed |
| TypeScript | `test/e2e/bindings/typescript`: `file:` dependency on the runtime; `src/extension.ts`, `actions.ts`, `rules.ts`, `cli.ts`, `index.ts` (library with the extension) | `node dist/cli.js` | 39 passed; 100% lines per file (c8) |
| PowerShell | `scripts/e2e/OsContextSuite.psm1` (options, context keys, rules, `HCI_SUITE_`, Start, `Cases` hooks); `scripts/e2e/suiterun.ps1`; actions in `scripts/e2e/actions/*.ps1`; `Invoke-LabTestSuite.ps1` a wrapper over `Invoke-BddSuite` with its old parameters, relaunching under `pwsh` from Windows PowerShell 5.1 | `pwsh -File scripts/e2e/suiterun.ps1` | `OsContextSuite.Tests.ps1` 26 passed |

Every binding:
* registers its actions with its runtime's idiom, one literal name each, so the
  VS Code extension's default recognizers find them;
* declares `--api-url`, `--lab-id` and `--connection-file`, the context keys
  `cluster`, `target`, `labId` and `apiUrl`, the 900 s lifecycle rule, E214 and
  `HCI_SUITE_`.

os-context's runtime copies are deleted (S6.14):
* the compiled bindings' `internal/` trees, runtime sources and runtime tests;
* PowerShell's `SuiteModel`, `SuiteLint`, `StepExecution`, `Expression`,
  `Assertions`, `ReportCompare`, `actions/ActionRegistry.ps1`, `Core.ps1`,
  `Wait.ps1` and `Conformance.Tests.ps1`.

**Two runtime changes were needed here (committed in bdd-suite, see above):**
1. **BddSuite option flags.** BddSuite spelled an option `apiUrl` as `--apiUrl`;
   every other runtime takes `--api-url`. Fixed in the runtime: the flag is the
   name in lower-case words. The PowerShell agent's interim workaround in
   os-context was removed.
2. **Per-case hooks.** The PowerShell lab runner did things around each case that
   the five extension parts cannot express (HANDOVER item 4). **User decision
   2026-10-15:** add a per-case hook to the PowerShell runtime only. BddSuite
   gained the optional `Cases` part (design DEC-S03, addition in S6), with 10 new
   runtime tests; BddSuite now passes 94 tests and the corpus' 1512 assertions.
   os-context's extension uses it to restore:
   * the `requires` skips of cases and steps;
   * case-level `cluster`/`target`;
   * operation evidence;
   * closing streams;
   * stage 7 completion;
   * the fixture-name check;
   * the stream trail on a timed-out case.

## S6.12, S6.13: scripts, settings, workflows, documents

* **`LifecycleBudgetSupport.psm1` and `LifecycleSetSegment.psm1`:**
  * The acceptance source roots name the runtime files in the submodule, each in
    the scope it had: the compiled runtimes and the spec are deployed (they came
    from `test/e2e/bindings` and `test/e2e/schema`); BddSuite is controller (it
    came from `scripts/e2e`).
  * The parent repository lists a submodule as one entry, so
    `Get-LifecycleSourceInputs` lists roots inside `test/e2e/bdd` through the
    submodule's own git. The manifest now holds 188 deployed and 21 controller
    files from it.
  * The `overbudget` scan reads the runtimes' executors.
  * The proof fixtures create the new roots.
* **Payload:** `src/Build-All.ps1` and deploy stage 5c stage
  `test\e2e\bdd\runtimes\powershell\BddSuite` and `test\e2e\bdd\spec` into the
  lab-suites folder. The catalog imports the spec on every lint. Nothing was
  built or deployed.
* **`.vscode/settings.json`:** `bddSuite.contextKeys` and
  `bddSuite.schemaGenerator` (the submodule's generator). The default binding
  layout already matches every binding. The YAML schema mappings point into the
  submodule.
* **`suite-conformance.yml`:** five jobs, each checking out with
  `submodules: true`, building and testing its extension, then running
  `Invoke-ExtensionCorpus.ps1`. The divergence job is gone; that check runs in
  bdd-suite's CI.
* **`suite-lint.yml`:** the submodule's generator, the program's action list
  against the catalog plus the imported core, and the program's lint. Each
  non-Pester step ran locally:
  * "current";
  * "100 actions declared and registered.";
  * "Lint clean: 70 suite file(s), 0 warning(s).";
  * the per-binding report.
* **`e2e-tests.yml`:** submodule checkout; the binding check runs the program
  under `pwsh`. Run locally on `drain.yml`: Go refused 5 actions, PowerShell 0.
* **Documents:**
  * the seven documents `Docs.Tests.ps1` checks, plus two READMEs, describe the
    submodule and the new paths;
  * `Docs.Tests.ps1` passes 14 of 14 and asserts the new workflow shape;
  * historical stage and plan documents that name old paths were left as
    written (listed below).

## E5, local: results (rerun by hand)

| Check | Result |
| --- | --- |
| Action lists and lint, Go | `19 files compared, 0 differ` |
| Rust | `19 files compared, 0 differ` |
| C# | `19 files compared, 0 differ` |
| TypeScript | `19 files compared, 0 differ` |
| PowerShell (program over BddSuite) | `19 files compared, 0 differ` |
| os-context's entries, each binding | `7 of 7 os-context entries pass` for go, rust, csharp, typescript, powershell |
| Schema | `-Check` current; the same check as the baseline (above) |
| Wrapper against the old runner (agent's comparison, 11 runs: lint, `-Json`, dry run, offline run, failing run, precondition, unknown name) | the same exit codes; byte-identical output except step durations and output paths; the same under Windows PowerShell 5.1 |
| Pester, 242 files | see below |

**Pester (S6.16).** These numbers are from the agent's full run, not a rerun.
I diffed its saved per-test output against the baseline myself with
`pester-diff.mjs`. My own full rerun was stopped, because no file had changed
since the agent's run.
* **Runner totals:** 242 files, **5506 passed, 31 failed** (baseline: 5478
  passed, 34 failed).
* **Per test, by name:**
  * **0 newly failing.**
  * **2 fixed:** the two `lifecycle.armEdgeDisks` and
    `lifecycle.armGroupResources` lint tests.
  * **1 removed:** `Conformance.Tests.ps1`, a deleted runtime copy that already
    failed in the baseline. The runtime's own `Conformance.Tests.ps1` covers it,
    'E2: the conformance corpus, PowerShell'.
  * **26 added:** `OsContextSuite.Tests.ps1`, all passing.
  * **30 still failing,** exactly as in the baseline. Data-driven tests that
    share a name count once, which is why these counts are lower than the
    runner's.

The pre-existing failures fail with the same messages in the baseline and here.
The agent ran each failing file in both trees. They include:
* the `Test-Json` defect of PowerShell 7.6.7 recorded in S4;
* a lifecycle suite case assigned to no segment;
* guest-agent, media and restore-agent tests that need host tools.

## Behaviour that differs, and why

None of these shows in the captures or the corpus entries.
1. **An action a binding does not register.** Run under Go, Rust, C# or
   TypeScript, a PowerShell-only action such as `cluster.state` now fails as
   "Unknown action: X. No extension of this runtime registers it." It used to
   say "X needs --api-url ...". The step fails either way, and lint with
   `--binding-check` reports it first.
2. **A lifecycle case limit below 1 or above 14400.** The core's message now
   reports it ("outside 1 to 14400"), not os-context's ("1 to 900"). An
   extension can add a finding but not replace a core one. The code and position
   are the same, and no checked-in suite has such a value.
3. **The lab context is one per run.** It used to be one per suite file
   (compiled bindings), and the secrets list is run-wide (PowerShell). This
   redacts more, never less.
4. **A context key with no value.** `${cluster}`/`${target}` with no suite
   default now read as empty, the runtimes' rule for declared keys.
5. **PowerShell runner details:**
   * A stop before a case skips that case's cleanup; the old runner ran it.
   * `[FILED] <runId>` prints after the verdict line.
   * When a timed-out case also fails in cleanup, the stream trail comes after
     the cleanup message, and the trace reason is `timeout`.
   * The trail prints as its own `[FAIL]` line.
   * The trail is detected from the runtime's message (`$Error[0]`), because
     hooks do not see a case's failure. That is the one fragile seam.
6. **E214's suggestion for a misspelled check** lists the five shared checks
   instead of the nearest spelling (Go, TypeScript). The core does not compare
   suggestions between bindings.

## Open

| Step | Why it is open |
| --- | --- |
| S6.1, E7 | No release yet: needs `main` pushed and the `AZURE_*` variables. Then the tags are checked and the submodule moves from `e5a3214` to the tag. |
| S6.3 | The submodule pins a local commit, not a release tag (same blocker). |
| S6.17 | os-context's branch `bdd-suite-pin` is not committed or pushed, so its workflows have not run. Needs the user to commit and push it. |
| S6.16 | Passes locally, with one fragile item. `SuiteLint.Tests.ps1`'s 2-second full-tree lint budget measured 1.87 s to 1.91 s on a loaded machine, and failed once in a full run. The agent's suspected cause, unconfirmed: load from other jobs. |

**Historical os-context documents that still name old paths** (left as
written, since they record past stages):
* `docs/lab/lifecycle/master-implementation.md`;
* `implementation/stage-03.md`, `stage-01/steps.md`, `stage-10/*`,
  `shared/2.7`, `shared/2.9`, `evidence-log.md`;
* `scenario-catalog/design.md` and `implementation.md`;
* `scenarios/stage-12.md`, `explanations/cases/drain.md`;
* the E-Y walkthroughs under `scenarios/explanations/yml-suite/` (links to the
  old corpus files);
* `sloppy-fix/plan.md`, `sf10-defect-register.md`, `sf12/*`.
