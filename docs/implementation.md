# Suite authoring in VS Code: implementation plan

The design is [design.md](design.md). It says what the extension does and why;
this plan says how, step by step, with a status that is ticked only against
evidence. Goals, decisions and scenarios are not restated here; they are linked
by ID: outcomes `O1`-`O8`, decisions `DEC-B01`-`DEC-B14`, scenarios
`E-B1`-`E-B11`.

---

## 1. Purpose and audience

**For the developer writing the next step.** Open the plan at any step and the
mechanism is already decided: which module, which function, which setting, which
command line, which failure is distinguished from which. If a step leaves a
choice open, that is a defect in the plan; fix the plan first, then the code.

**This is the first version.** Nothing is built. The prototype `yml-gherkin`
0.1.0 is the only prior code, and it suggests a shape to avoid: one
`extension.ts` that registers every provider inside a `setup()` closure, with
settings read in five places and parsing done inside providers. Two concrete
consequences of that shape, so they are not repeated:

* The prototype's providers call `index.match(step)` on every hover and
  completion, which re-runs every binding's regular expression against every
  step. Here the join is a map lookup by action name, computed once per index
  update (B1.3).
* The prototype publishes diagnostics by clearing the whole collection and
  rebuilding it, so a slow scan briefly shows a clean workspace. Here a file's
  lint result replaces only that file's entries, and a failed lint never
  replaces anything (INV-3, INV-4).

**How to read a step.** Fields in order: Deliverable, Why its own step,
Implementation (a numbered recipe), Contracts (`<step>-n`, cited by code
comments and tests), Constraints, Files (new files marked *new*), Unit, E2E,
Depends on, Status.

---

## 2. Shared context, read once

### 2.1 Components and where they live

All paths in this table are in this repository unless they start with
`os-context:`.

| Component | Source | What it ships | Where it runs |
| --- | --- | --- | --- |
| Extension entry | `src/extension.ts` | `activate()`, `deactivate()` | VS Code extension host (Node, one process per window) |
| Limits | `src/limits.ts` | every constant in [2.6](#26-hard-limits) | imported everywhere |
| Workspace layout | `src/config/layout.ts`, `src/config/defaults.ts` | `WorkspaceLayout`, `readSettings()`, `findRepositoryRoot()`, `DEFAULT_BINDINGS` | extension host |
| Positions | `src/core/text.ts`, `src/core/yamlPositions.ts` | `LineIndex` (from the prototype), `parseYaml()` returning a `yaml` `Document` with a `LineCounter` | pure, no `vscode` import |
| Catalog | `src/core/catalog.ts` | `parseCatalog()` returning `Catalog` | pure |
| Suites | `src/core/suites.ts` | `parseSuite()` returning `SuiteFile` | pure |
| Registrations | `src/core/registrations.ts` | `compileRecognizers()`, `scanRegistrations()` | pure |
| Index | `src/core/workspaceIndex.ts` | `WorkspaceIndex` | pure; held by the extension |
| Scope | `src/core/scope.ts`, `src/core/exprCursor.ts` | `scopeAt()`, `cursorContext()` | pure |
| Coverage | `src/core/coverage.ts` | `computeCoverage()` | pure |
| Scaffolding text | `src/core/catalogEdit.ts`, `src/core/stubs.ts`, `templates/*` | `renderCatalogEntry()`, `planStub()` | pure |
| Lint and trace parsing | `src/core/diagnostics.ts`, `src/core/trace.ts` | `parseLintOutput()`, `mapTrace()` | pure |
| Tool runner | `src/tools/runTool.ts`, `src/tools/profiles.ts` | `runTool()`, `lintCommand()`, `actionsCommand()`, `listCommand()`, `runCommand()`, `buildCommand()` | extension host, spawns child processes |
| Providers and controllers | `src/features/*.ts` | navigation, hover, inlay hints, completion, lint controller, status bar, coverage view, scaffolding commands, testing | extension host |
| Unit tests | `test/unit/*.test.ts` | `node:test` suites over `src/core`, `src/tools`, `src/config` | Node |
| Fake tool | `test/fake-tool/fake-suiterun.mjs` | a program that sleeps, prints junk, prints too much, or exits with a chosen code | Node child process |
| Integration harness | `test/integration/` | `runTest.ts` (launcher), `suite/*.test.ts` (mocha in the extension host), `harness/worktree.ts`, `harness/oracle.ts` | a real VS Code downloaded by `@vscode/test-electron` |

The `os-context` side, read or invoked and never modified except by the
scaffolding commands (B5) and by the scenarios inside a worktree:

| Artefact | Path in `os-context` | Used by |
| --- | --- | --- |
| Action catalog | `test/e2e/schema/actions.catalog.yaml` | Catalog, scaffolding |
| Generated schema | `test/e2e/schema/suite.schema.json` | `redhat.vscode-yaml` only |
| Generator | `test/e2e/schema/Build-Schema.ps1` | scaffolding, E-B8 |
| Suites, libraries | `test/e2e/**/*.yml` with a top-level `suite:` or listed in an `imports:` | Suites |
| Binding sources | `scripts/e2e/actions/*.ps1`; `test/e2e/bindings/go/internal/**/*.go`; `test/e2e/bindings/rust/src/**/*.rs`; `test/e2e/bindings/dotnet/Hci.E2E.Suite/**/*.cs` | Registrations |
| Binding programs | see [2.4](#24-how-a-tool-call-is-set-up-end-to-end) | Tool runner |
| Corpus | `test/e2e/conformance/run-manifest.yaml` and its entries | E-B1, E-B9 oracles |

### 2.2 Interfaces and who calls whom

```
 VS Code --(provider calls)--> features/* --(queries)--> WorkspaceIndex
 VS Code --(save/open/change events)--> features/indexer glue --(parse*)--> WorkspaceIndex.update*
 features/lintController --> tools/profiles.lintCommand --> tools/runTool --spawn--> suiterun | pwsh
 features/coverageView   --> tools/profiles.actionsCommand --> tools/runTool
 features/scaffold       --> core/catalogEdit, core/stubs --> WorkspaceEdit --> tools/runTool(Build-Schema.ps1)
 features/testing        --> tools/profiles.listCommand / runCommand --> tools/runTool --> core/trace.mapTrace
```

Nothing in `src/core` imports `vscode` or `child_process`. Nothing in
`src/features` parses YAML or source text. That boundary is INV-9 and is
checked by a unit test that reads the import lines of every file under
`src/core` (B1.1).

### 2.3 Data types

Declared in `src/core/types.ts` (*new*). Positions are zero-based
`{ line, character }` as in VS Code; conversion from the tools' one-based
positions happens in exactly one function, `toZeroBased()` in
`src/core/diagnostics.ts`.

```ts
type BindingName = string;                 // 'powershell' | 'csharp' | 'go' | 'rust' by default; open set
interface Range { start: Pos; end: Pos }   // from text.ts

interface Catalog {
  file: string;                            // absolute path
  bindings: BindingName[];                 // top-level bindings:
  actions: Map<string, CatalogAction>;
  errors: { message: string; range: Range }[];
}
interface CatalogAction {
  name: string; nameRange: Range; entryRange: Range;
  summary: string; notes?: string; deprecated?: boolean;
  bindings: BindingName[]; bindingsRange?: Range;
  interruptible: boolean;
  params: { name: string; type?: string; required?: boolean; default?: unknown; description?: string; range: Range }[];
  captures: CaptureShape;
}
interface CaptureShape { type?: string; open: boolean; properties: Map<string, CaptureShape>; items?: CaptureShape }

type StepHome =
  | { kind: 'case'; caseName: string; caseIndex: number }
  | { kind: 'hook'; hook: 'setup'|'teardown'|'beforeEach'|'afterEach'; caseName?: string }   // caseName for case setup/cleanup
  | { kind: 'meta'; metaName: string };
interface StepInfo {
  file: string; range: Range; index: number; home: StepHome;
  keyword?: 'given'|'when'|'then'|'and'; sentence?: string;
  action?: string; actionRange?: Range;
  meta?: string; metaRange?: Range; withKeys: { name: string; range: Range }[];
  captureAs?: string; captureAsRange?: Range;
  params: { name: string; range: Range; value: unknown }[];
  tableColumns?: string[];
  expressions: { text: string; range: Range }[];     // each ${...} including the delimiters
}
interface SuiteFile {
  file: string; isLibrary: boolean; suiteName?: string;
  imports: { path: string; resolved: string; range: Range }[];
  params: { name: string; range: Range }[];
  vars: { name: string; range: Range; caseName?: string }[];
  metaSteps: { name: string; range: Range; params: string[]; exports: string[] }[];
  cases: { name: string; range: Range; tags: string[]; examplesColumns?: string[]; examplesRows: number; params: string[] }[];
  steps: StepInfo[];
  parseError?: { message: string; range: Range };
}
interface RegistrationSite { binding: BindingName; action: string; handler?: string; file: string; range: Range; recognizer: number }
```

### 2.4 How a tool call is set up end to end

Every process the extension starts goes through `runTool()` in
`src/tools/runTool.ts`. This is the whole path for a lint; the other verbs differ
only in arguments and in what is parsed.

1. **Trigger.** `LintController` (B2.2) receives an open or save of a document
   the index classifies as a suite or library. It cancels the
   `CancellationTokenSource` of any lint still running for the same file and
   creates a new one (INV-4).
2. **Root and relative path.** `WorkspaceLayout.root` is the folder holding
   `test/e2e/schema`, found once by `findRepositoryRoot()` walking up from the
   catalog path, the same rule as `os-context:test/e2e/bindings/go/internal/paths/paths.go`
   `RepositoryRoot`. The file's path relative to `root`, with forward slashes,
   is `rel`.
3. **Command.** `lintCommand(profile, rel, target)` in `src/tools/profiles.ts`
   returns `{ argv, cwd: root, env }`:
   - `suiterun` tools: `[...profile.tool, 'lint', '--path', rel, '--json',
     '--binding-check', '--binding', target]`.
   - `powershell` tool: `['pwsh', '-NoProfile', '-NonInteractive', '-Command',
     script]`, where `script` is fixed text that imports
     `scripts/e2e/SuiteLint.psm1`, calls
     `Invoke-SuiteLint -Path @('<rel>') -Binding '<target>' -BindingCheck`,
     and writes the result with `ConvertTo-Json -Depth 5 -AsArray`. `rel` and
     `target` are inserted with single-quote doubling; `target` is also
     checked against `^[a-z]+$` before insertion. (B2.1 records whether the
     function's output objects already match `diagnostic.schema.json`; if not,
     the script maps them, and the mapping is written into this item.)
4. **Spawn.** `child_process.spawn(argv[0], argv.slice(1), { cwd, env:
   process.env, shell: false, windowsHide: true, detached: process.platform
   !== 'win32' })`. `shell: false` so a file name is never interpreted by a
   shell.
5. **Collect.** stdout and stderr are buffered separately. If stdout passes
   `MAX_TOOL_OUTPUT_BYTES`, the process is killed and the result is
   `{ kind: 'failure', reason: 'oversize' }`. stderr keeps its last
   `MAX_STDERR_BYTES` for the output channel.
6. **Bound.** A timer of `LINT_TIMEOUT_MS` (or the verb's own limit) and the
   cancellation token both call `killTree(pid)`: on Windows
   `taskkill /PID <pid> /T /F`; elsewhere `process.kill(-pid, 'SIGKILL')`.
   The result is `failure/timeout` or `cancelled`. `deactivate()` kills every
   live child the same way (INV-5).
7. **Interpret.** On exit, `parseLintOutput(stdout, exitCode)` in
   `src/core/diagnostics.ts` returns either a list of `LintDiagnostic` or a
   `ToolFailure`. Exit 0 or 2 with stdout that parses as a JSON array whose
   every element has `code` matching `^[EW][0-9]{3}$`, `severity` in
   `{error, warning}`, string `file`, integer `line >= 1` and `column >= 1`,
   string `message` is a result. Anything else, including exit 2 with
   non-JSON, is a failure carrying the exit code and stderr. Exit 2 is both
   "findings" and "harness error" in DEC-Y14, so the parse, not the code,
   decides.
8. **Map.** Each diagnostic's `file` is joined to `root`; line and column go
   through `toZeroBased()`. The end of the range is the end of the YAML token
   at that position, found with the document's `getWordRangeAtPosition` and the
   pattern `/[^\s:,\[\]{}#]+/`; if none, the end of the line.
9. **Publish.** `LintController` stores the result under the linted file's key
   and republishes the union over keys for each affected file (INV-3).

### 2.5 State and its single owner

| State | Owner | Written when | Read by |
| --- | --- | --- | --- |
| Settings snapshot | `WorkspaceLayout` | activation; `onDidChangeConfiguration` for `bddSuite` | everything |
| Catalog | `WorkspaceIndex.catalog` | catalog file save or file-system change | every provider, scaffolding, coverage |
| Suite files | `WorkspaceIndex.suites` (by absolute path) | open-buffer edit (debounced), save, file-system change | providers, scope, testing |
| Registration sites | `WorkspaceIndex.sites` (by file) | binding source save or file-system change | navigation, coverage, scaffolding |
| Derived joins (steps by action, sites by action, meta definitions by name) | `WorkspaceIndex`, rebuilt lazily after any update | first query after an update | providers |
| Lint results | `LintController.byLintedFile` | each completed lint | `DiagnosticCollection 'bddSuite.lint'` |
| Live child processes | `runTool` module's `live` set | spawn, exit | `deactivate()` |
| Test items and last results | `TestingController` | discovery from the index; each run | Test Explorer |
| Temporary trace and report files | `TestingController` under `context.storageUri/runs/` | each run | the same run; deleted by the next run of the same file |

### 2.6 Hard limits

All in `src/limits.ts`. Every one is enforced by code and tested at its edge.

| Symbol | Value | Why that number |
| --- | --- | --- |
| `INDEX_DEBOUNCE_MS` | 250 | One re-parse per pause in typing; a 68 KB suite parses in well under that (measured in B1.3) |
| `LINT_DEBOUNCE_MS` | 300 | *Save All* fires one save per file in a burst; lint each file once |
| `LINT_TIMEOUT_MS` | 20000 | PowerShell's lint imports a 109 KB module on a cold `pwsh`; B2.5 measures all four tools and this must stay at least 3x the slowest measured p95, or B2.5 raises it and says so |
| `ACTIONS_TIMEOUT_MS` | 20000 | Same programs, smaller job |
| `LIST_TIMEOUT_MS` | 20000 | Same |
| `BUILD_TIMEOUT_MS` | 600000 | A cold `cargo build` or `dotnet build` of a binding; above that, something is wrong and the operator should look |
| `SCHEMA_TIMEOUT_MS` | 120000 | `Build-Schema.ps1` regenerates a 10141-line schema |
| `MAX_TOOL_OUTPUT_BYTES` | 16 MiB | Lint of the largest suite emits kilobytes; 16 MiB is far above any legal answer and far below what hurts the extension host |
| `MAX_STDERR_BYTES` | 64 KiB | Enough for a stack trace; the tail is what matters |
| `MAX_INDEXED_FILE_BYTES` | 1 MiB | The largest binding source file is 179 KB (`scripts/e2e/Invoke-LabTestSuite.Tests.ps1`, excluded anyway) and the largest suite 68 KB; a file above 1 MiB is generated or a mistake and is skipped with a log line |
| `META_DEPTH_LIMIT` | 5 | The format's own nesting limit (`yml_suite_design.md` DEC-Y10); scope resolution stops there |
| `KILL_GRACE_MS` | 1000 | E-B11 asserts no child survives 1 s after a kill |
| Run timeout | none | The suite declares and the binding enforces its own limits (DEC-Y08, DEC-Y09); an extension timeout would kill the runner before its cleanup. A run ends by finishing or by an explicit, confirmed cancel (DEC-B12) |

### 2.7 Invariants

No step may break these. Reviews cite them by number.

1. **INV-1.** The extension never writes `suite.schema.json` or
   `suite.schema.md`. Only `Build-Schema.ps1` does.
2. **INV-2.** Every `E`/`W` diagnostic shown came from a tool's output in this
   session. The extension's own findings (catalog parse errors, recognizer
   errors) use source `bddSuite` and codes `BDD001`-`BDD099`, never the
   `[EW][0-9]{3}` space.
3. **INV-3.** A lint result replaces exactly the previous result of the same
   linted file. Results of other linted files are untouched.
4. **INV-4.** Only the newest lint of a file publishes. A superseded or failed
   lint publishes nothing; a failed lint marks the previous result stale.
5. **INV-5.** No child process outlives its request: every spawn is killed on
   timeout, cancellation and `deactivate()`.
6. **INV-6.** No suite runs except from an explicit Test Explorer run or
   command. A lab run requires the confirmation of DEC-B12.
7. **INV-7.** The extension stores no credential. Lab settings are an API URL,
   a lab id and a file path.
8. **INV-8.** Each scaffolding command applies its text changes in one
   `WorkspaceEdit`, so one undo reverts them. Generator output is not part of
   that edit and is regenerated, not undone.
9. **INV-9.** `src/core` imports neither `vscode` nor `child_process`;
   providers never read files or parse; they query the index.
10. **INV-10.** Every path from a tool's output is resolved against
    `WorkspaceLayout.root`, never against `process.cwd()`.

### 2.8 Settings

Contributed in `package.json` under `contributes.configuration`, section
`bddSuite`. Defaults live in `src/config/defaults.ts` and are copied into
`package.json` by `npm run sync-defaults`, which a unit test runs with `--check`
so the two cannot drift.

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `bddSuite.catalogPath` | string | `test/e2e/schema/actions.catalog.yaml` | Catalog, relative to the workspace folder |
| `bddSuite.suiteGlobs` | string[] | `["test/e2e/**/*.yml"]` | Candidate suites; content decides (DEC-B13) |
| `bddSuite.exclude` | string | `**/{node_modules,bin,obj,target,artifacts,.git}/**` | Never indexed |
| `bddSuite.lintTool` | string | `go` (provisional, B2.5) | Binding whose program lints |
| `bddSuite.targetBinding` | string | `powershell` | Binding `--binding-check` asks about, and runs use |
| `bddSuite.bindings` | object | see below | Per binding: sources, recognizers, tool |
| `bddSuite.schemaGenerator` | string[] | `["pwsh","-NoProfile","-NonInteractive","-File","test/e2e/schema/Build-Schema.ps1"]` | Run after catalog edits |
| `bddSuite.inlayHints.bindings` | boolean | `true` | Per-step binding badges |
| `bddSuite.templatesDir` | string | `""` | Workspace directory overriding stub templates |
| `bddSuite.lab.apiUrl` / `.labId` / `.connectionFile` | string | `""` | Lab run parameters; prompted when empty |

Default `bddSuite.bindings` (paths relative to the workspace folder;
`${storage}` is `context.globalStorageUri.fsPath`):

| Binding | `sources` | `exclude` | `recognizers` (`name`, optional `handler` groups) | `tool` | `build` |
| --- | --- | --- | --- | --- | --- |
| `powershell` | `scripts/e2e/actions/*.ps1` | `**/*.Tests.ps1` | `Register-LabAction\s+-Name\s+'(?<name>[^']+)'`; `Register-LabAction\s+-Name\s+"(?<name>[^"]+)"` | `kind: powershell` | none |
| `go` | `test/e2e/bindings/go/internal/**/*.go` | `**/*_test.go` | `^\s*"(?<name>[a-z][\w]*(?:\.[\w]+)+)"\s*:\s*(?<handler>[\w.]+)`; `append\(names,\s*"(?<name>[\w.]+)"\)` | `["${storage}/go/suiterun.exe"]` | `go build -o ${storage}/go/suiterun.exe ./cmd/suiterun` in `test/e2e/bindings/go` |
| `rust` | `test/e2e/bindings/rust/src/**/*.rs` | none | `map\.insert\(\s*"(?<name>[^"]+)"\s*,\s*(?<handler>\w+)\s*\)`; `^\s*"(?<name>[^"]+)"\s*=>\s*(?<handler>\w+)\(`; `names\.push\("(?<name>[^"]+)"\.to_string\(\)\)` | `["test/e2e/bindings/rust/target/debug/suiterun.exe"]` | `cargo build` in `test/e2e/bindings/rust` |
| `csharp` | `test/e2e/bindings/dotnet/Hci.E2E.Suite/**/*.cs` | none | `^\s*\[\s*"(?<name>[^"]+)"\s*\]\s*=\s*(?<handler>[^,\r\n]+?),?\s*$`; `names\.Add\("(?<name>[^"]+)"\)` | `["test/e2e/bindings/dotnet/artifacts/bin/Hci.E2E.Suite.Cli/Debug/net10.0/suiterun.exe"]` | `dotnet build Hci.E2E.Suite.sln` in `test/e2e/bindings/dotnet` |

The patterns are a starting point checked by E-B3 and E-B7, not a claim: B1.4
runs them over the tree and records every false positive and miss it finds, and
the table above is corrected in that step.

---

## 3. Working rules

### 3.1 Toolchain and commands

Measured on the development host on 2026-10-13: Node 24.16.0, npm 11.13.0,
VS Code 1.141.0. `engines.vscode` is `^1.95.0` (Test Controller, inlay hints
and `TestRunProfile` are all older than that).

| Command | What it does |
| --- | --- |
| `npm ci` | install |
| `npm run compile` | `tsc -p .` type-check plus `node esbuild.mjs` bundle to `dist/extension.js` |
| `npm run test:unit` | `tsc -p test/unit` then `c8 --100 --include out-test/src/core --include out-test/src/tools --include out-test/src/config node --test out-test/test/unit` |
| `npm run test:integration` | `node out-test/test/integration/runTest.js`; needs `OS_CONTEXT_ROOT` |
| `npm run test:lab` | the same launcher with `BDD_LAB=1`; runs E-B10 only; needs the lab variables of B7.3 |
| `npm run package` | `vsce package` to `bdd-suite-<version>.vsix`, then prints its SHA-256 |
| `npm run sync-defaults -- --check` | fails if `package.json` defaults differ from `src/config/defaults.ts` |

### 3.2 Preparing `os-context` for the integration suite

Once per `os-context` commit under test, from `OS_CONTEXT_ROOT`:

1. `cargo build` in `test/e2e/bindings/rust` (run from that directory so its
   `.cargo/config.toml`, if any, applies).
2. `go build -o <storage>/go/suiterun.exe ./cmd/suiterun` in
   `test/e2e/bindings/go`, where `<storage>` is the test instance's global
   storage path, which `runTest.ts` prints and fixes with `--user-data-dir`.
3. `dotnet build Hci.E2E.Suite.sln` in `test/e2e/bindings/dotnet`.
4. Record `git -C $OS_CONTEXT_ROOT rev-parse HEAD`; the harness writes it into
   every result file.

The harness never builds bindings itself in the main checkout; the B2.4 *Build
lint tool* command does, when a user asks.

### 3.3 Coverage gates

* `src/core`, `src/tools` and `src/config`: 100 percent of lines and branches
  under `npm run test:unit`, enforced by `c8 --100`. These are the modules
  where a wrong branch is a wrong answer.
* `src/features`: not measured by `c8`, because it runs only inside the
  extension host. Each provider is proved by its scenario in a real VS Code.
  That is a real gap in measurement, stated rather than hidden: a provider
  branch no scenario reaches is untested.
* A step that cannot reach 100 percent names the exact lines and why in its
  Unit field.

### 3.4 Local verification discipline

Adapted from the repository guideline: stabilise and verify locally, then run
the remote scenario once; rerun only what a change affects.

* Focused unit tests while editing; the whole unit suite and the step's
  integration scenario before ticking the step.
* Never re-run a green suite whose inputs did not change.
* Every mock is listed with what it replaces. There are two: the fake tool
  (replaces a binding program in process-handling unit tests) and none else.
  Every scenario uses real programs, a real VS Code and the real checkout.
* E-B10 (the only lab scenario) runs once, on the packaged `.vsix`, after all
  local scenarios are green on that same `.vsix` (B7.3).

### 3.5 Step template and definition of done

A step is **done** when all three status boxes are ticked:

* `[ ] code` - the deliverable exists and matches its contracts.
* `[ ] unit` - unit tests green at the stated coverage.
* `[ ] scenario` - its E2E scenario passed, with evidence (commit of this
  repository, `os-context` commit, VS Code version, result file path).

`[-]` marks a box that cannot be ticked in this stage and names the step that
will. A stage is done when all its steps are. "Built" (code and unit) and
"done" are separate statuses in the progress table.

---

## 4. Progress and acceptance index

| Stage | Result | Priority | Depends on | Steps | Built | Done |
| --- | --- | --- | --- | --- | --- | --- |
| [B1](#stage-b1-navigation-and-hover-over-one-index) | Navigation and hover over one index | P0 | none | 7 | 0 of 7 | 0 of 7 |
| [B2](#stage-b2-lint-diagnostics-from-a-binding-program) | Lint diagnostics from a binding program | P0 | B1.1, B1.3 | 5 | 0 of 5 | 0 of 5 |
| [B3](#stage-b3-completion-that-knows-the-scope) | Completion that knows the scope | P1 | B1.2, B1.3, B1.6 | 5 | 0 of 5 | 0 of 5 |
| [B4](#stage-b4-the-binding-table-and-drift) | The binding table and drift | P1 | B1.4, B2.1 | 3 | 0 of 3 | 0 of 3 |
| [B5](#stage-b5-declaring-and-implementing-an-action) | Declaring and implementing an action | P1 | B1.2, B1.4, B2.1 | 4 | 0 of 4 | 0 of 4 |
| [B6](#stage-b6-running-suites-from-test-explorer) | Running suites from Test Explorer | P2 | B1.3, B2.1 | 5 | 0 of 5 | 0 of 5 |
| [B7](#stage-b7-package-and-accept) | Package and accept | P0 | all above | 3 | 0 of 3 | 0 of 3 |

Priority says what ships first, never what may be skipped: P0 is the minimum
useful release (navigate, hover, lint), P1 the authoring features, P2 running.
A stage at any priority is done only against its full criteria.

**Scenario to step index.** Read from the step status blocks.

| Scenario | Signs off | Needs a lab | Status |
| --- | --- | --- | --- |
| [E-B1](design.md#e-b1-the-editor-shows-exactly-what-the-corpus-says-lint-must-find) | B2.1, B2.2, B2.5 | no | not run |
| [E-B2](design.md#e-b2-a-step-the-target-binding-cannot-run-is-marked-and-says-who-can) | B1.2, B2.3, B3.1 | no | not run |
| [E-B3](design.md#e-b3-go-to-definition-on-an-action-lists-the-catalog-entry-and-every-registration) | B1.3, B1.4, B1.6 | no | not run |
| [E-B4](design.md#e-b4-a-registration-site-shows-and-lists-the-steps-that-use-it) | B1.5 | no | not run |
| [E-B5](design.md#e-b5-completion-offers-what-is-in-scope-and-nothing-the-format-forbids) | B3.1-B3.5 | no | not run |
| [E-B6](design.md#e-b6-a-new-action-is-declared-and-implemented-in-all-four-bindings-from-the-editor) | B5.1-B5.4 | no | not run |
| [E-B7](design.md#e-b7-the-binding-table-matches-the-catalog-and-the-binaries-and-drift-appears-when-introduced) | B4.1-B4.3, B1.4 | no | not run |
| [E-B8](design.md#e-b8-a-catalog-change-is-picked-up-without-a-reload) | B1.2, B1.7 | no | not run |
| [E-B9](design.md#e-b9-an-offline-suite-runs-under-each-binding-and-each-case-shows-the-corpus-result) | B6.1-B6.3, B6.5 | no | not run |
| [E-B10](design.md#e-b10-the-portable-stage-0-cases-run-from-the-editor-against-a-real-lab) | B6.4 | yes | not run |
| [E-B11](design.md#e-b11-a-missing-slow-or-broken-lint-tool-is-reported-not-hidden) | B2.4 | no | not run |

Some scenarios need features from more than one step (E-B5 needs all of B3).
Where a scenario signs off several steps, each step names the *part* of the
scenario it makes runnable, and that part runs when the step lands; the whole
scenario runs when the last of them lands.

---

## Stage B1: navigation and hover over one index

**Entry state.** This repository holds `README.md` and `.vscode/settings.json`.
The prototype's source is in
`C:\Users\xiaodoli.REDMOND\Downloads\bdd-ext\yml-gherkin-src.zip`; `text.ts`
(`LineIndex`) is reused verbatim, and nothing else is copied.

**What it delivers.** Hover on an action explains it; Go to Definition goes to
the catalog and the four registration sites; references and CodeLens go back;
meta step uses go to their definitions; everything stays current as files
change. This is worth shipping alone: it answers "what does this action do and
where is it" with no build of any binding.

**How it is built.**

```
 activation
   | findRepositoryRoot(catalogPath)  -- none --> inert
   v
 WorkspaceLayout --> initial scan: findFiles(suiteGlobs) + findFiles(binding sources)
   |                    | parseCatalog / parseSuite / scanRegistrations  (pure)
   v                    v
 watchers -----> WorkspaceIndex.update{Catalog,Suite,Sources}(file, result)
 open-buffer edits (INDEX_DEBOUNCE_MS) -+        | marks joins dirty
                                                 v
 providers ---query--> byAction(name) / sitesFor(name) / metaDefinition(file, name) / stepAt(file, pos)
```

Construction decisions that hold across the stage:

* Parsers return values, never throw; a parse error is data on the result
  (`SuiteFile.parseError`, `Catalog.errors`), shown as a `BDD0xx` diagnostic.
* The index keeps the last good parse of a file when a new parse fails, and
  marks it stale; providers still answer from it.
* Joins are recomputed lazily on the first query after an update, in one pass
  over all suites and sites, so a burst of file events costs one rebuild.

**Step order and why.** B1.1 first because nothing can be observed without an
activated extension that knows its root. B1.2 (catalog) before B1.3 (suites)
because hover on a step needs the catalog entry. B1.4 (registrations) after the
suite index, because its scenario half starts from a step. B1.5 (reverse
direction) needs both. B1.6 (meta steps) depends only on B1.3 but is separate
because it is a different join (name to definition across imports). B1.7
(watching) last, because it changes when the index updates, not what it holds,
and its scenario edits files the earlier steps only read.

**Checklist.**

- [ ] B1.1 Extension skeleton that activates on a catalog and finds the root
- [ ] B1.2 Catalog parsed with positions, and hover on an action
- [ ] B1.3 Suites indexed with positions, and Go to Definition to the catalog
- [ ] B1.4 Registration sites found by recognizers, and Go to Definition to every binding
- [ ] B1.5 References and CodeLens from registration sites and catalog entries
- [ ] B1.6 Meta step uses resolved to definitions across imports
- [ ] B1.7 Watchers and debounced re-index keep everything current

### B1.1 Extension skeleton that activates on a catalog and finds the root

* **Deliverable.** An installable extension that activates in `os-context`,
  logs the root and the catalog path to an output channel named *Suite
  Authoring*, and does nothing in a workspace with no catalog.
* **Why its own step.** Every later step needs the build, the test harness and
  the layout object; proving them once, with nothing else in the way, keeps
  later failures about features.
* **Implementation.**
  1. `package.json`: `name: bdd-suite`, `displayName: Suite Authoring`,
     `publisher: local`, `engines.vscode: ^1.95.0`, `main: ./dist/extension.js`,
     `activationEvents: ["workspaceContains:**/test/e2e/schema/actions.catalog.yaml"]`,
     `extensionDependencies: ["redhat.vscode-yaml"]`, the configuration of
     [2.8](#28-settings), and the scripts of [3.1](#31-toolchain-and-commands).
     Dependencies: `yaml@^2.5`, `minimatch@^9`. Dev: `typescript`, `esbuild`,
     `@types/vscode@~1.95.0`, `@types/node@^20`, `@vscode/test-electron`,
     `@vscode/vsce`, `mocha`, `c8`.
  2. `src/limits.ts` with every symbol in [2.6](#26-hard-limits).
  3. `src/config/defaults.ts`: `DEFAULT_BINDINGS` exactly as the table in 2.8.
     `scripts/sync-defaults.mjs` writes them into `package.json`; `--check`
     compares instead.
  4. `src/config/layout.ts`:
     `findRepositoryRoot(start: string, exists: (p) => boolean): string | undefined`
     walks parents until `join(dir, 'test', 'e2e', 'schema')` exists.
     `readSettings(get: (key, default) => unknown): Settings` validates types
     and returns defaults for wrong ones, collecting a `BDD010` message per bad
     key. `WorkspaceLayout.create(folder, settings, storagePath)` resolves every
     path, expands `${storage}`, and exposes `root`, `catalogPath`,
     `suiteGlobs`, `exclude`, `bindings`.
  5. `src/extension.ts`: `activate(context)` builds the layout for the first
     workspace folder whose catalog exists; if none, returns with one log line.
     Multi-root: one layout per folder that has a catalog, each with its own
     index (B1.3 onward key everything by folder).
  6. `test/unit/boundaries.test.ts` reads every `src/core/**/*.ts` and fails on
     an import of `vscode` or `child_process` (INV-9).
  7. `test/integration/runTest.ts`: downloads VS Code with
     `@vscode/test-electron`, installs `redhat.vscode-yaml` into a fresh
     `--extensions-dir`, opens `OS_CONTEXT_ROOT`, and runs
     `test/integration/suite/index.ts` (mocha). `harness/worktree.ts` provides
     `createWorktree(): Promise<string>` (`git -C $OS_CONTEXT_ROOT worktree add
     <tmp> HEAD --detach`) and `removeWorktree(path)`.
* **Contracts.**
  - B1.1-1 The extension activates in `os-context` and its output channel's
    first line names the root and the catalog path.
  - B1.1-2 In a folder without `test/e2e/schema/actions.catalog.yaml` the
    extension registers no provider.
  - B1.1-3 `findRepositoryRoot` returns the nearest ancestor with
    `test/e2e/schema`, or `undefined`.
  - B1.1-4 A setting of the wrong type is ignored with a `BDD010` log line and
    the default used.
* **Constraints.** No provider registered in this step.
* **Files.** *new*: `package.json`, `tsconfig.json`, `esbuild.mjs`,
  `.vscodeignore`, `src/extension.ts`, `src/limits.ts`, `src/config/layout.ts`,
  `src/config/defaults.ts`, `scripts/sync-defaults.mjs`,
  `test/unit/layout.test.ts`, `test/unit/boundaries.test.ts`,
  `test/integration/runTest.ts`, `test/integration/suite/index.ts`,
  `test/integration/suite/activation.test.ts`,
  `test/integration/harness/worktree.ts`.
* **Unit.** `layout.test.ts`: root found at depth 0, 3 and not at all; every
  setting with a wrong type; `${storage}` expansion. `boundaries.test.ts`.
  100 percent of `src/config`.
* **E2E.** Not a design scenario; `activation.test.ts` asserts B1.1-1 and
  B1.1-2 in a real VS Code (the second against an empty temporary folder).
  Every later scenario depends on it.
* **Depends on.** Nothing.
* **Status.** [ ] code [ ] unit [ ] scenario

### B1.2 Catalog parsed with positions, and hover on an action

* **Deliverable.** Hovering on the value of `action:` in a suite shows the
  action's summary, parameters, capture shape, `interruptible`, notes, and one
  line per binding saying implemented or not, with each implemented one a
  link (links filled by B1.4; until then the line names the binding only).
* **Why its own step.** The catalog is the vocabulary every later feature reads;
  getting its positions and shapes right is separable and testable on its own.
* **Implementation.**
  1. `src/core/yamlPositions.ts`: `parseYaml(text)` returns
     `{ doc: Document, lines: LineCounter, range(node): Range }` using
     `parseDocument(text, { keepSourceTokens: true, lineCounter })` from
     `yaml`. `range()` converts `node.range[0..1]` offsets with `LineIndex`.
  2. `src/core/catalog.ts`: `parseCatalog(text, file): Catalog`. Reads
     top-level `bindings` (array of strings) and `actions` (sequence). For each
     item, `name`, `summary`, `notes`, `deprecated`, `bindings`, `interruptible`
     (default `true`), `params` (sequence of maps), `captures` (recursive into
     `CaptureShape`: `type`, `additionalProperties === true` sets `open`,
     `properties`, `items`). A duplicate action name is a `BDD020` error at the
     second occurrence; the first wins. A missing `name` is `BDD021`.
  3. `WorkspaceIndex` (*new* `src/core/workspaceIndex.ts`) gets `catalog` and
     `updateCatalog(c: Catalog)`.
  4. `src/features/hover.ts`: `HoverProvider` for `{ language: 'yaml' }`
     documents the index classifies as suites. Until B1.3 lands, it locates the
     action value with a line-local test (`/^\s*(-\s+)?action:\s*(\S+)/`) and is
     replaced by `index.stepAt()` in B1.3. Markdown: `**name** - summary`,
     a parameter table (name, type, required, default, description), the
     capture shape flattened to dotted paths to depth 3 (open shapes say
     *open*), `interruptible: false` called out, notes, then the binding lines
     in the catalog's top-level `bindings` order.
  5. Catalog `errors` publish to a `DiagnosticCollection` named
     `bddSuite.catalog` with source `bddSuite` (INV-2).
* **Contracts.**
  - B1.2-1 `parseCatalog` on the real catalog returns 100 actions, of which 24
    list four bindings, with no errors (the numbers read from the file by the
    test, not typed in).
  - B1.2-2 Every action's `nameRange` starts at the action name's text.
  - B1.2-3 A capture shape with `additionalProperties: true` is `open`; one
    without is closed and lists its properties.
  - B1.2-4 Hover on `lifecycle.get` names all four bindings as implementing; on
    `cluster.state`, PowerShell only.
* **Constraints.** `MAX_INDEXED_FILE_BYTES` applies to the catalog too (today
  1719 lines).
* **Files.** *new*: `src/core/types.ts`, `src/core/text.ts`,
  `src/core/yamlPositions.ts`, `src/core/catalog.ts`,
  `src/core/workspaceIndex.ts`, `src/features/hover.ts`,
  `test/unit/catalog.test.ts`, `test/unit/fixtures/catalog-*.yaml`.
* **Unit.** Duplicate name, missing name, missing `bindings`, nested capture
  shape, array capture, malformed YAML; B1.2-1 against a copy of the real file
  read from `OS_CONTEXT_ROOT` when set, skipped with a visible message when not.
  100 percent of `catalog.ts` and `yamlPositions.ts`.
* **E2E.** The hover half of [E-B2](design.md#e-b2-a-step-the-target-binding-cannot-run-is-marked-and-says-who-can)
  (hover lists bindings) and of [E-B8](design.md#e-b8-a-catalog-change-is-picked-up-without-a-reload)
  (with B1.7).
* **Depends on.** B1.1.
* **Status.** [ ] code [ ] unit [ ] scenario

### B1.3 Suites indexed with positions, and Go to Definition to the catalog

* **Deliverable.** Every suite and library in the workspace is indexed; Go to
  Definition on an action value opens the catalog entry; hover answers from
  the index.
* **Why its own step.** The suite index is the largest pure module and every
  provider after this reads it. Proving it alone, against every real suite,
  isolates parse problems from feature problems.
* **Implementation.**
  1. `src/core/suites.ts`: `parseSuite(text, file, resolveImport): SuiteFile`.
     A document is a suite if its root map has `suite:`; a library if it is
     listed in another suite's `imports:` (decided by the index, which sets
     `isLibrary` after all files are parsed). Walk with explicit recursion, not
     `visit`, so the walker knows where it is:
     - root keys `params`, `vars`, `metaSteps`, `imports`, `setup`, `teardown`,
       `beforeEach`, `afterEach`, `tests`;
     - `tests[i]`: `name`, `tags`, `params`, `vars`, `examples` (columns from
       the first row's keys; row count), `setup`, `steps`, `cleanup`, `asserts`;
     - `metaSteps[i]`: `name`, `params[].name`, `exports`, `steps`.
     For each step map: the one key of `given|when|then|and` present (first
     wins; lint reports two), `action`, `meta`, `with` keys, `captureAs`,
     `table` (columns), every other key as a parameter, and every `${...}` in
     any string value beneath the step found with a brace-depth scan that skips
     quoted strings inside the expression (the format's expressions use `"`
     literals). The step's `home` comes from where the walker is.
  2. `WorkspaceIndex.updateSuite(file, s)`; derived maps
     `stepsByAction: Map<string, StepInfo[]>`, `stepAt(file, pos)` (smallest
     step range containing pos).
  3. `src/extension.ts`: initial scan with `workspace.findFiles` over
     `suiteGlobs` minus `exclude`, reading with `workspace.fs.readFile`
     (open documents use their buffer text).
  4. `src/features/navigation.ts`: `DefinitionProvider` returning the catalog
     entry's `nameRange` when the position is inside a step's `actionRange`.
  5. Hover switches to `index.stepAt()`.
  6. Measure: parse time of `lifecycle-stage1.yml` (68 KB) over 20 runs;
     record p50 and max here. If max exceeds `INDEX_DEBOUNCE_MS`, the step
     records it and B1.7 debounces per file instead of per edit.
* **Contracts.**
  - B1.3-1 For every suite in `os-context`, the indexed steps whose `action` is
    set equal the steps an independent walk (the E-B4 oracle) finds, by file,
    line and action.
  - B1.3-2 `home` is right for a step in each of the six hook positions, a case
    and a meta step.
  - B1.3-3 Every `${...}` in a step is recorded with the range of its `$`
    through its `}`.
  - B1.3-4 A file with a YAML error keeps its previous index and reports
    `BDD030` at the parser's position.
* **Constraints.** `MAX_INDEXED_FILE_BYTES`; nothing outside `suiteGlobs`.
* **Files.** *new*: `src/core/suites.ts`, `src/features/navigation.ts`,
  `test/unit/suites.test.ts`, `test/unit/fixtures/suite-*.yml`,
  `test/integration/harness/oracle.ts`.
* **Unit.** One fixture per home, per keyword, a table step, an outline, nested
  expressions with quoted braces, a flow-style map step, a broken file. 100
  percent of `suites.ts`.
* **E2E.** The catalog half of
  [E-B3](design.md#e-b3-go-to-definition-on-an-action-lists-the-catalog-entry-and-every-registration)
  (first location of five). B1.3-1 runs in the integration suite over the real
  tree.
* **Depends on.** B1.2.
* **Status.** [ ] code [ ] unit [ ] scenario

### B1.4 Registration sites found by recognizers, and Go to Definition to every binding

* **Deliverable.** Go to Definition on an action lists, after the catalog
  entry, the registration site in each binding that has one; hover's binding
  lines become links.
* **Why its own step.** The recognizers are the riskiest guess in the design
  (DEC-B05). Landing them as their own step, with a scenario that checks exact
  lines in four languages, makes the guess falsifiable immediately.
* **Implementation.**
  1. `src/core/registrations.ts`:
     `compileRecognizers(list: {pattern: string; flags?: string}[]): {ok: RegExp[]; errors: string[]}`
     compiles each with flags `gm` plus the given flags; a pattern without a
     `name` group is an error (`BDD040`).
     `scanRegistrations(text, file, binding, recognizers): RegistrationSite[]`
     runs each over the text with `matchAll`, takes `groups.name`,
     `groups.handler`, and the range of the name group (computed from
     `match.index` and the group's offset via the `d` flag's `indices`).
     A match on a line whose trimmed text starts with `//`, `#` or `--` is
     skipped (commented out).
  2. The extension scans `sources` minus `exclude` per binding at activation.
  3. `WorkspaceIndex.updateSources(file, binding, sites)`; derived
     `sitesByAction: Map<string, RegistrationSite[]>`.
  4. Definition provider returns `[catalogEntry, ...sites]`, sites ordered by
     the catalog's top-level `bindings` order, then file, then line.
  5. Run the defaults over `os-context` and diff against the catalog: for every
     binding, list names found and not declared for it, and declared and not
     found. Each item is either a recognizer defect (fix the pattern in
     `defaults.ts` and the 2.8 table) or real drift (record it in this step and
     report it to the `os-context` owner). The list and its resolution are
     recorded here before the step is ticked.
* **Contracts.**
  - B1.4-1 Each default recognizer, on the real tree, yields exactly one site
    per action the catalog declares for that binding, and no other names
    (subject to drift recorded in item 5).
  - B1.4-2 The range of a site is the action name inside its quotes.
  - B1.4-3 A commented-out registration is not a site.
  - B1.4-4 An invalid pattern is reported with its setting path and does not
    stop the other recognizers.
* **Constraints.** `MAX_INDEXED_FILE_BYTES`.
* **Files.** *new*: `src/core/registrations.ts`,
  `test/unit/registrations.test.ts`, `test/unit/fixtures/reg-*.{ps1,go,rs,cs}`;
  *edit*: `src/config/defaults.ts`, `src/features/navigation.ts`,
  `src/features/hover.ts`.
* **Unit.** One fixture per default recognizer with a positive match, a
  near-miss that must not match, a commented line, and the `wait` special case;
  bad pattern; missing name group. 100 percent of `registrations.ts`.
* **E2E.** [E-B3](design.md#e-b3-go-to-definition-on-an-action-lists-the-catalog-entry-and-every-registration)
  except its meta half (B1.6).
* **Depends on.** B1.3.
* **Status.** [ ] code [ ] unit [ ] scenario

### B1.5 References and CodeLens from registration sites and catalog entries

* **Deliverable.** On a registration line in any binding, a CodeLens shows how
  many suite steps use that action and opens the list; Find All References on
  a registration, a catalog entry name or a step's action value lists every
  step that uses the action.
* **Why its own step.** It is the reverse join and the one binding implementers
  use; it has its own scenario with an independent oracle.
* **Implementation.**
  1. `ReferenceProvider` registered for suite documents, the catalog document,
     and each binding's `sources` as document filters
     (`{ pattern: <glob relative to root> }`).
  2. At a position: if inside a step's `actionRange` or a catalog `nameRange` or
     a site's range, resolve the action name; return
     `stepsByAction.get(name)` mapped to `Location(step.file, step.actionRange)`.
  3. `CodeLensProvider` for binding sources: one lens per site,
     `N suite step(s)`, command `editor.action.showReferences` with the
     locations; `no suite steps` when zero. `onDidChangeCodeLenses` fires on
     index updates.
* **Contracts.**
  - B1.5-1 The three entry points return the same set for one action.
  - B1.5-2 The lens count equals the set's size.
  - B1.5-3 Steps inside `metaSteps`, hooks and libraries are included; a step
    reached through a meta use is counted once, at its definition.
* **Constraints.** None beyond the index.
* **Files.** *edit*: `src/features/navigation.ts`; *new*:
  `test/integration/suite/references.test.ts`.
* **Unit.** Pure parts are already in the index tests; this step adds
  `workspaceIndex.test.ts` cases for `stepsByAction` with meta and library
  steps.
* **E2E.** [E-B4](design.md#e-b4-a-registration-site-shows-and-lists-the-steps-that-use-it).
* **Depends on.** B1.4.
* **Status.** [ ] code [ ] unit [ ] scenario

### B1.6 Meta step uses resolved to definitions across imports

* **Deliverable.** Go to Definition on `meta: <name>` opens the definition,
  locally or in an imported library; references on a definition list its uses.
* **Why its own step.** Import resolution is a different join from action
  names, with its own ordering rules, and E-B3 has a separate half for it.
* **Implementation.**
  1. `WorkspaceIndex.visibleMetaSteps(file): Map<string, {file, def}>` follows
     the format's rule (DEC-Y17): imports depth-first in listed order, then the
     file's own definitions, later ones replacing earlier ones (the
     `override: true` check is lint's job, not this map's). Cycle-safe with a
     visited set; stops at `META_DEPTH_LIMIT` levels of import.
  2. Definition provider: position in a step's `metaRange` returns the visible
     definition's range.
  3. Reference provider: position on a definition's name returns every step in
     every file whose visible map resolves that name to this definition.
* **Contracts.**
  - B1.6-1 A local definition shadows an imported one of the same name.
  - B1.6-2 An import cycle terminates and resolves what it can.
  - B1.6-3 `meta: select-lab` in `lifecycle-stage0.yml` resolves to
    `_lib/lifecycle.yml`.
* **Constraints.** `META_DEPTH_LIMIT`.
* **Files.** *edit*: `src/core/workspaceIndex.ts`,
  `src/features/navigation.ts`; *new*: `test/unit/meta.test.ts`.
* **Unit.** Local, imported, two-level import, shadowing, cycle, missing
  import. 100 percent of the new index code.
* **E2E.** The meta half of
  [E-B3](design.md#e-b3-go-to-definition-on-an-action-lists-the-catalog-entry-and-every-registration).
* **Depends on.** B1.3.
* **Status.** [ ] code [ ] unit [ ] scenario

### B1.7 Watchers and debounced re-index keep everything current

* **Deliverable.** Editing, saving, creating or deleting a suite, the catalog
  or a binding source updates navigation, hover and lenses without a reload.
* **Why its own step.** It changes *when* the index updates, not what it holds;
  separating it keeps B1.2-B1.6 testable on a static tree.
* **Implementation.**
  1. One `FileSystemWatcher` per glob: `suiteGlobs`, the catalog path, each
     binding's `sources`. Create and change re-read and re-parse; delete removes
     the file's entries.
  2. `workspace.onDidChangeTextDocument`: per document, a timer of
     `INDEX_DEBOUNCE_MS`; on fire, re-parse from the buffer. Closing an unsaved
     document re-reads from disk.
  3. `onDidChangeConfiguration('bddSuite')`: dispose watchers and providers,
     rebuild the layout and the index (same path as activation).
  4. After any update, fire one `onDidChangeIndex` event, debounced to one per
     `INDEX_DEBOUNCE_MS`, which lenses and (later) the coverage view listen to.
* **Contracts.**
  - B1.7-1 A catalog save is visible in hover within 1 s.
  - B1.7-2 A new registration line in a binding file is a definition target
    within 1 s of save.
  - B1.7-3 A burst of 50 file events produces one join rebuild.
* **Constraints.** `INDEX_DEBOUNCE_MS`.
* **Files.** *new*: `src/features/indexer.ts`; *edit*: `src/extension.ts`.
* **Unit.** The debounce helper (`src/core/debounce.ts`, *new*) with an
  injected clock scoped to each test. 100 percent.
* **E2E.** [E-B8](design.md#e-b8-a-catalog-change-is-picked-up-without-a-reload)
  (hover half; the completion half lands with B3.4), and the timing half of
  E-B7 (with B4.2).
* **Depends on.** B1.2, B1.4, B1.6.
* **Status.** [ ] code [ ] unit [ ] scenario

---

## Stage B2: lint diagnostics from a binding program

**Entry state.** After B1: index and navigation; no process is ever started.
In `os-context`, the Rust `suiterun` is built at
`test/e2e/bindings/rust/target/debug/suiterun.exe`; Go and C# are not built in
the tree; `pwsh` is installed.

**What it delivers.** Every lint finding in the editor, from a real binding, on
open and save, with failure states that cannot be mistaken for a clean file;
per-step binding badges; a measured default lint tool. This closes the biggest
gap in [design 2.3](design.md#23-what-the-editor-does-and-the-gap).

**How it is built.**

```
 save/open --> LintController.schedule(file)  (LINT_DEBOUNCE_MS)
                 | cancel previous token for file
                 v
               lintCommand(profile(lintTool), rel, targetBinding) --> runTool --> suiterun/pwsh
                 |                                                            |
                 | <------------ {result | failure | cancelled} ---------------+
                 v
   result:  byLintedFile[file] = diagnostics; publish union per affected file
   failure: mark byLintedFile[file] stale; status bar; output channel
   cancelled: nothing
```

The tool runner is the stage's foundation and is the only code that touches
`child_process`. The lint controller is a small state machine per file:
`idle -> scheduled -> running -> idle`, where a new trigger in `running` cancels
and restarts.

**Step order and why.** B2.1 (runner) has no UI, but it is observable on its own
through a command that prints a tool's `actions --json`, which is also what B4
needs. B2.2 is the lint controller. B2.3 adds the target binding and badges on
top. B2.4 hardens failure states, after the happy path exists to compare against.
B2.5 measures latency, which needs all four tools wired.

**Checklist.**

- [ ] B2.1 Tool runner and per-binding command profiles
- [ ] B2.2 Lint on open and save, mapped to editor ranges
- [ ] B2.3 Target binding: `--binding-check` and per-step binding badges
- [ ] B2.4 Failure states: missing, slow, broken and oversized tools
- [ ] B2.5 Lint latency measured for all four tools, and the default chosen

### B2.1 Tool runner and per-binding command profiles

* **Deliverable.** The command *Suite: Show actions implemented by binding...*
  asks for a binding and prints that program's `actions --json` answer in the
  output channel, or says why it could not.
* **Why its own step.** Process handling is where timeouts, orphans and
  quoting bugs live; it is proved alone with a fake tool before any feature
  depends on it.
* **Implementation.**
  1. `src/tools/runTool.ts`: `runTool(cmd: {argv, cwd, env?, timeoutMs, maxStdout},
     token: CancellationLike): Promise<ToolResult>` exactly as
     [2.4](#24-how-a-tool-call-is-set-up-end-to-end) items 4 to 6.
     `ToolResult = { kind: 'exited', code, stdout, stderrTail } | { kind:
     'failure', reason: 'not-found'|'timeout'|'oversize'|'spawn', detail } |
     { kind: 'cancelled' }`. `ENOENT` on spawn is `not-found`. `killTree` is a
     separate export so it can be unit-tested with a real child.
  2. `src/tools/profiles.ts`: `lintCommand`, `actionsCommand`, `listCommand`,
     `runCommand`, `buildCommand`, each a pure function of
     `(BindingSettings, layout, args)`. The PowerShell profile's scripts are
     constants in this file; `rel` and every string are single-quote-escaped.
     `actionsCommand` for PowerShell imports
     `scripts/e2e/actions/ActionRegistry.ps1` and prints
     `Get-LabActionNames | ConvertTo-Json -AsArray`.
  3. Read `Invoke-SuiteLint`'s output objects (`SuiteLint.psm1` line ~2032 at
     the time of writing) and record here whether they already carry `code`,
     `severity`, `file`, `line`, `column`, `message`. If not, the profile's
     script projects them with `Select-Object`, and the projection is written
     into this item.
  4. `src/core/diagnostics.ts`: `parseLintOutput(stdout, code)`,
     `parseActionsOutput(stdout)` (a JSON array of strings), `toZeroBased()`.
  5. The command in `src/features/commands.ts` (*new*).
* **Contracts.**
  - B2.1-1 A tool that is not there is `not-found`, never an exception.
  - B2.1-2 A tool that outlives its timeout is killed with its children, and no
    process with its pid or a child pid exists `KILL_GRACE_MS` later.
  - B2.1-3 More than `maxStdout` bytes is `oversize` and the process is killed.
  - B2.1-4 Cancellation kills and returns `cancelled`.
  - B2.1-5 A file name containing spaces, quotes and `$` reaches the tool as
    one argument, unchanged, for both the `suiterun` and PowerShell profiles.
  - B2.1-6 `parseLintOutput` accepts exactly the shape of
    `diagnostic.schema.json` and rejects every other.
* **Constraints.** `LINT_TIMEOUT_MS`, `ACTIONS_TIMEOUT_MS`,
  `MAX_TOOL_OUTPUT_BYTES`, `MAX_STDERR_BYTES`, `KILL_GRACE_MS`; `shell: false`
  always.
* **Files.** *new*: `src/tools/runTool.ts`, `src/tools/profiles.ts`,
  `src/core/diagnostics.ts`, `src/features/commands.ts`,
  `test/fake-tool/fake-suiterun.mjs`, `test/unit/runTool.test.ts`,
  `test/unit/profiles.test.ts`, `test/unit/diagnostics.test.ts`.
* **Unit.** The fake tool, driven by its arguments, exits with a code, sleeps,
  spawns a grandchild then sleeps, prints N bytes, prints given text, or echoes
  its argv as JSON (for B2.1-5). Every `ToolResult` branch, both platforms'
  kill paths (the non-Windows one through an injected `process.kill`, which is
  recorded as unit-only evidence). 100 percent of `src/tools` and
  `diagnostics.ts`.
* **E2E.** The parse-and-map half of
  [E-B1](design.md#e-b1-the-editor-shows-exactly-what-the-corpus-says-lint-must-find):
  the integration suite runs each real tool's `lint --json` on every manifest
  entry through `runTool` and `parseLintOutput` and compares with the
  expectations, before any editor wiring.
* **Depends on.** B1.1.
* **Status.** [ ] code [ ] unit [ ] scenario

### B2.2 Lint on open and save, mapped to editor ranges

* **Deliverable.** Opening or saving a suite shows every finding from the lint
  tool at its position, with code and message, in the Problems panel.
* **Why its own step.** It is the first user-visible lint behaviour and has a
  complete oracle in the corpus.
* **Implementation.**
  1. `src/features/lintController.ts`: `LintController` with
     `byLintedFile: Map<string, {diags: LintDiagnostic[]; stale: boolean}>`, a
     per-file `CancellationTokenSource`, and `DiagnosticCollection
     'bddSuite.lint'`.
  2. Triggers: `onDidOpenTextDocument` and `onDidSaveTextDocument` for files
     the index classifies as suite or library; `LINT_DEBOUNCE_MS` per file.
  3. On result: replace `byLintedFile[file]`; compute affected files (the
     linted file plus every `file` in the old and new results); for each,
     publish the union across all keys (INV-3). Diagnostic: range per 2.4 item
     8, severity from `severity`, `code` = the code, `source` =
     `suiterun:<tool>`, message = `message` plus `\n<suggestion>` when present.
  4. On close of a document: keep its diagnostics (lint is about the file, not
     the buffer).
* **Contracts.**
  - B2.2-1 For every manifest validate entry without `catalogOverlay`, the
    editor's diagnostics equal the expectation (E-B1's Then).
  - B2.2-2 Two saves within `LINT_DEBOUNCE_MS` produce one lint.
  - B2.2-3 A save during a running lint cancels it; only the second publishes.
* **Constraints.** `LINT_DEBOUNCE_MS`; INV-3, INV-4.
* **Files.** *new*: `src/features/lintController.ts`,
  `test/integration/suite/lint.test.ts`.
* **Unit.** The union-and-replace logic is extracted as
  `mergeLintResults()` in `src/core/diagnostics.ts` and unit-tested with two
  linted files reporting into a shared library.
* **E2E.** [E-B1](design.md#e-b1-the-editor-shows-exactly-what-the-corpus-says-lint-must-find)
  with the lint tool `rust` (the one built in the tree); the other three tools
  run in B2.5.
* **Depends on.** B2.1, B1.3.
* **Status.** [ ] code [ ] unit [ ] scenario

### B2.3 Target binding: `--binding-check` and per-step binding badges

* **Deliverable.** With `bddSuite.targetBinding` set, saving marks every step
  that binding cannot run (`E201`), and every step shows an inlay hint of the
  bindings that implement its action.
* **Why its own step.** It adds a second setting and a second provider on top
  of a working lint, and has its own scenario.
* **Implementation.**
  1. `lintCommand` always passes `--binding-check --binding <target>` (2.4
     item 3). Changing `targetBinding` re-lints every open suite.
  2. `src/features/inlay.ts`: `InlayHintsProvider` for suites. For each step
     with an action in the catalog, one hint after `actionRange.end`:
     abbreviations `PS`, `C#`, `Go`, `Rs` for the four defaults (a binding
     without an abbreviation shows its name), in the catalog's top-level
     order. Tooltip: "Implemented by: ..." and, when the target binding is
     absent, "Not implemented by <target>". Off when
     `bddSuite.inlayHints.bindings` is false.
  3. A status bar item `src/features/statusBar.ts` (*new*) shows
     `Suite: lint <tool> -> <target>`; clicking it opens a quick pick for
     each setting.
* **Contracts.**
  - B2.3-1 The editor's `E201` set equals the terminal's for the same file,
    tool and target.
  - B2.3-2 The hint for an action lists exactly its catalog `bindings`.
  - B2.3-3 Changing the target re-lints open suites without a save.
* **Constraints.** None new.
* **Files.** *new*: `src/features/inlay.ts`, `src/features/statusBar.ts`;
  *edit*: `src/features/lintController.ts`, `src/tools/profiles.ts`.
* **Unit.** Hint text rendering (`renderBindingBadge()` in
  `src/core/coverage.ts`) for four, one and zero bindings and an unknown
  binding name.
* **E2E.** [E-B2](design.md#e-b2-a-step-the-target-binding-cannot-run-is-marked-and-says-who-can)
  except the completion-order assertion (B3.1).
* **Depends on.** B2.2, B1.2.
* **Status.** [ ] code [ ] unit [ ] scenario

### B2.4 Failure states: missing, slow, broken and oversized tools

* **Deliverable.** When the lint tool is missing, times out, prints something
  that is not a diagnostic array, or prints too much, the author is told which
  and why, the last good diagnostics stay visible and marked stale, and the
  command *Suite: Build lint tool* builds the missing one.
* **Why its own step.** These states are what decides whether an empty
  Problems panel can be trusted; they deserve a scenario of their own.
* **Implementation.**
  1. On `failure`: set `stale: true` on `byLintedFile[file]`, republish with
     each message prefixed `[stale] `, set the status bar item to the failure
     (`Lint: go not built`, `Lint timed out after 20 s`, `Lint output was not
     diagnostics`, `Lint output too large`), and write argv, cwd, exit code and
     `stderrTail` to the output channel.
  2. On `not-found`, one notification per session per tool, with actions
     *Build lint tool* (runs `buildCommand(profile)` with `BUILD_TIMEOUT_MS`,
     streaming output to the channel) and *Choose another tool*.
  3. A successful lint clears `stale` and the status text.
* **Contracts.**
  - B2.4-1 No failure replaces a diagnostic set with an empty one.
  - B2.4-2 Each failure kind produces its own status text.
  - B2.4-3 No child process survives `KILL_GRACE_MS` after a timeout.
  - B2.4-4 *Build lint tool* for Go produces the program at the configured
    path, after which the next save lints.
* **Constraints.** `BUILD_TIMEOUT_MS`.
* **Files.** *edit*: `src/features/lintController.ts`,
  `src/features/statusBar.ts`, `src/features/commands.ts`; *new*:
  `test/integration/suite/lintFailures.test.ts`.
* **Unit.** The stale-marking path of `mergeLintResults()`.
* **E2E.** [E-B11](design.md#e-b11-a-missing-slow-or-broken-lint-tool-is-reported-not-hidden),
  using the fake tool as the configured program for the timeout, junk and
  oversize cases, and a nonexistent path for the missing case.
* **Depends on.** B2.2.
* **Status.** [ ] code [ ] unit [ ] scenario

### B2.5 Lint latency measured for all four tools, and the default chosen

* **Deliverable.** A recorded measurement of lint latency per tool, the default
  `lintTool` set from it, and E-B1 green under all four tools.
* **Why its own step.** DEC-B04's default is provisional on this number, and
  E-B1 is not complete until all four tools agree in the editor.
* **Implementation.**
  1. Build Go and C# per [3.2](#32-preparing-os-context-for-the-integration-suite).
  2. `test/integration/suite/latency.test.ts`: for each tool, 1 warm-up then 20
     timed lints of `test/e2e/suites/lifecycle-stage1.yml` through `runTool`
     with the target `powershell`; record p50, p95, max and the machine.
  3. Set the default in `defaults.ts` to the tool with the lowest p95; if that
     is not Go, edit DEC-B04 in the design with the measurement. Check
     `LINT_TIMEOUT_MS` >= 3 x the slowest p95; raise it if not, here and in
     2.6.
  4. Run E-B1 with each of the four tools.
* **Contracts.**
  - B2.5-1 The measurement table is in this step, with date, machine and
    `os-context` commit.
  - B2.5-2 E-B1 passes for all four tools.
* **Constraints.** `LINT_TIMEOUT_MS`.
* **Files.** *new*: `test/integration/suite/latency.test.ts`; *edit*:
  `src/config/defaults.ts`, `docs/design.md` (only if the default changes).
* **Unit.** None new.
* **E2E.** [E-B1](design.md#e-b1-the-editor-shows-exactly-what-the-corpus-says-lint-must-find),
  all four tools.
* **Depends on.** B2.2.
* **Status.** [ ] code [ ] unit [ ] scenario

---

## Stage B3: completion that knows the scope

**Entry state.** After B1 and B2: the index records every step, its home,
captures and expressions; the catalog records capture shapes. Nothing completes
inside `${ }` or after `action:` or `meta:`.

**What it delivers.** Completion for action names, expression namespaces,
captures in scope, capture-shape paths, parameters, variables, row columns,
functions, meta step names and their `with:` parameters; hover on a
`${capture...}` path. This is the authoring speed-up for suite writers.

**How it is built.**

```
 completion request (doc, pos)
   +- line context: after "action:" -------------> catalog actions (B3.1)
   +- line context: after "meta:" / inside with: -> visibleMetaSteps (B3.5)
   +- inside ${ ... }: cursorContext(text, offset) (B3.2)
          |  { kind: 'root' | 'path' | 'function', segments, prefix }
          v
        scopeAt(index, file, stepIndex) (B3.3) --> candidates
          |  captures: earlier steps in this case's phase order + exports
          |  params: suite + imports + case; vars: earlier; row: table/examples
          v
        path into a capture: CaptureShape walk (B3.4)
```

`scopeAt` follows the phase order of `yml_suite_design.md` 5.2 and 5.3: suite
`setup` captures, then `beforeEach`, case `setup`, then the case's `steps` up
to but not including the current one. Inside a hook, only what precedes it.
Inside a meta step definition, `param.*` is the meta step's own parameters and
captures are only those of earlier steps in the definition.

**Step order and why.** Action completion (B3.1) needs only the catalog and is
also E-B2's last assertion. The cursor tokenizer (B3.2) is pure and comes before
anything that uses it. Scope (B3.3) is the core logic. Shape paths (B3.4) build
on scope. Meta (B3.5) is independent of expressions and last.

**Checklist.**

- [ ] B3.1 Action name completion with binding support
- [ ] B3.2 Expression cursor context
- [ ] B3.3 Scope at a step, and completion of namespaces, captures, parameters, variables, rows and functions
- [ ] B3.4 Capture-shape paths: completion and hover
- [ ] B3.5 Meta step names and `with:` parameters

### B3.1 Action name completion with binding support

* **Deliverable.** After `action:`, every catalog action is offered once, with
  its summary and binding badge; actions the target binding implements sort
  first.
* **Why its own step.** It needs only the catalog, closes E-B2, and first checks
  the YAML extension's behaviour (DEC-B09).
* **Implementation.**
  1. Record, in this step, what `redhat.vscode-yaml` offers after `action: ` on
     the current schema (expected: nothing, since `action` has no enum).
  2. `CompletionItemProvider` in `src/features/completion.ts` (*new*), trigger
     characters `:` and space. Context: the line matches
     `/^\s*(-\s+)?action:\s*(\S*)$/` up to the cursor. Items: label = name,
     detail = badge, documentation = the hover markdown of B1.2,
     `sortText` = `0`/`1` (implemented by target or not) + name, range = the
     partial word. Deprecated actions get `CompletionItemTag.Deprecated`.
* **Contracts.**
  - B3.1-1 Exactly one item per catalog action from this provider.
  - B3.1-2 Every target-implemented action sorts before every other.
* **Files.** *new*: `src/features/completion.ts`,
  `test/integration/suite/completion.test.ts`.
* **Unit.** `actionSortKey()` in `src/core/coverage.ts`.
* **E2E.** The completion assertion of
  [E-B2](design.md#e-b2-a-step-the-target-binding-cannot-run-is-marked-and-says-who-can),
  and the `action:` bullet of E-B5.
* **Depends on.** B1.3, B2.3.
* **Status.** [ ] code [ ] unit [ ] scenario

### B3.2 Expression cursor context

* **Deliverable.** A pure function that, given a line of text and a cursor
  inside `${ }`, says what is being typed: a root name, a path after a root and
  its segments so far, or a function argument position.
* **Why its own step.** It is the parsing half of expression completion and is
  easiest to get right with a table of cases before any provider exists. It is
  observable through its unit table alone; its scenario half is B3.3's.
* **Implementation.**
  1. `src/core/exprCursor.ts`: `cursorContext(text: string, offset: number):
     ExprContext | undefined`. Find the innermost `${` before `offset` whose
     closing `}` (by brace depth, skipping `"..."` literals) is at or after
     `offset`. Tokenise from after `${` to `offset`: identifiers, `.`, digits,
     `(`, `)`, `,`, operators, string literals. The last token run decides:
     identifier chars after a `.` chain starting at an identifier is
     `{ kind: 'path', root, segments, prefix }`; a lone identifier at an
     operand position is `{ kind: 'root', prefix }`; inside a string literal is
     `undefined`.
  2. `FUNCTIONS` constant: the 21 names of `yml_suite_design.md` 5.9 with arity
     text for documentation. `CONTEXT_KEYS`: `cluster`, `target`, `timeoutSec`,
     `labId`, `apiUrl`, `defaults`. `NAMESPACES`: `capture`, `param`, `var`,
     `row`.
* **Contracts.**
  - B3.2-1 The table in `exprCursor.test.ts` (at least 40 rows covering nested
    calls, ternaries, string literals containing `.` and `}`, numeric path
    segments `capture.run.0.`, and cursors outside any expression) passes.
* **Files.** *new*: `src/core/exprCursor.ts`, `test/unit/exprCursor.test.ts`.
* **Unit.** As B3.2-1; 100 percent of `exprCursor.ts`.
* **E2E.** Part of [E-B5](design.md#e-b5-completion-offers-what-is-in-scope-and-nothing-the-format-forbids)
  through B3.3.
* **Depends on.** B1.1.
* **Status.** [ ] code [ ] unit [-] scenario, closed by B3.3

### B3.3 Scope at a step, and completion of namespaces, captures, parameters, variables, rows and functions

* **Deliverable.** Inside `${ }`, completion offers the namespaces, context
  keys and functions at a root position, and after `capture.`, `param.`,
  `var.` and `row.` the names in scope at that step.
* **Why its own step.** The scope model is the one piece of format semantics the
  extension approximates (DEC-B08); it has its own unit table and scenario.
* **Implementation.**
  1. `src/core/scope.ts`: `scopeAt(index, file, step: StepInfo): Scope` with
     `captures: Map<string, {step: StepInfo; action?: string}>`, `params`,
     `vars`, `rows`. Rules, in order:
     - suite `setup` captures (in the file and imported libraries' none, since
       libraries have no hooks);
     - if the step is in a case: suite `beforeEach`, then the case's `setup`,
       then its `steps` before this one; for `cleanup` and `asserts` positions,
       all of the case's steps; a step with `meta:` contributes the meta step's
       `exports`, each mapped to the capturing step inside the definition;
     - in a meta step definition: earlier steps of the definition only;
     - `params`: suite, then imported (depth-first), then the case's own;
       inside a meta step definition, its own `params` instead;
     - `vars`: suite `vars`, then the case's, each only if declared before;
     - `rows`: the step's `table` columns, else the case's `examples` columns.
  2. Completion in `completion.ts` for `cursorContext` kinds `root` and
     `path` with root in `NAMESPACES`.
* **Contracts.**
  - B3.3-1 A capture from a later step, or from another case, is never offered.
  - B3.3-2 Suite `setup` captures are offered in every case.
  - B3.3-3 `row` is offered only where a table or `examples` applies.
  - B3.3-4 Meta exports are offered after the `meta:` step that brings them.
* **Constraints.** `META_DEPTH_LIMIT` when following nested meta exports.
* **Files.** *new*: `src/core/scope.ts`, `test/unit/scope.test.ts`; *edit*:
  `src/features/completion.ts`.
* **Unit.** One fixture per rule and per position (step, case `asserts`,
  `cleanup`, each hook, inside a meta step). 100 percent of `scope.ts`.
* **E2E.** [E-B5](design.md#e-b5-completion-offers-what-is-in-scope-and-nothing-the-format-forbids),
  all bullets except the shape-path, `meta:` and `action:` ones.
* **Depends on.** B3.2, B1.6.
* **Status.** [ ] code [ ] unit [ ] scenario

### B3.4 Capture-shape paths: completion and hover

* **Deliverable.** After `${capture.cs.`, the properties of the capturing
  action's declared shape are offered; hover on a capture path names the step
  that produced it and its declared type, or says the shape is open.
* **Why its own step.** It joins scope to the catalog's capture shapes, with its
  own edge cases (lists from a step `table`, numeric indexes, open shapes).
* **Implementation.**
  1. `shapeAt(action: CatalogAction, segments: string[], fromTable: boolean):
     CaptureShape | 'open' | undefined` in `src/core/scope.ts`. A capture from
     a step with a `table:` is a list of the action's shape (DEC-Y23), so the
     first segment must be numeric. A numeric segment on an `items` shape steps
     into `items`. An open shape returns `'open'`.
  2. Completion: `path` with root `capture` and at least one segment.
  3. Hover in `hover.ts` for a position inside a recorded expression whose path
     starts with `capture.`: producing step's file and line (as a link), its
     action, and the shape at the path.
* **Contracts.**
  - B3.4-1 For `cluster.state`, the offered names equal the catalog's
    `captures.properties` keys.
  - B3.4-2 A table capture requires an index first.
  - B3.4-3 An open shape offers nothing and says *open* in hover.
* **Files.** *edit*: `src/core/scope.ts`, `src/features/completion.ts`,
  `src/features/hover.ts`.
* **Unit.** Closed, open, nested, list, table-list shapes. 100 percent.
* **E2E.** The `${capture.cs.` bullet of
  [E-B5](design.md#e-b5-completion-offers-what-is-in-scope-and-nothing-the-format-forbids),
  and the completion half of
  [E-B8](design.md#e-b8-a-catalog-change-is-picked-up-without-a-reload).
* **Depends on.** B3.3.
* **Status.** [ ] code [ ] unit [ ] scenario

### B3.5 Meta step names and `with:` parameters

* **Deliverable.** After `meta:`, the meta steps visible from this file are
  offered; inside that step's `with:` map, its parameters (required ones
  marked) are offered.
* **Why its own step.** It uses the import join of B1.6 rather than the
  expression machinery.
* **Implementation.**
  1. Context `meta:` by line pattern; items from `visibleMetaSteps(file)`,
     detail = defining file.
  2. Context inside `with:`: the step at the position has `meta`; offer the
     definition's `params` not already present in `withKeys`.
* **Contracts.**
  - B3.5-1 Local and imported meta steps are offered; a shadowed import is
    offered once, as the local one.
  - B3.5-2 Parameters already written are not offered again.
* **Files.** *edit*: `src/features/completion.ts`.
* **Unit.** `metaCompletions()` in `src/core/workspaceIndex.ts`.
* **E2E.** The `meta:` bullet of
  [E-B5](design.md#e-b5-completion-offers-what-is-in-scope-and-nothing-the-format-forbids).
* **Depends on.** B1.6.
* **Status.** [ ] code [ ] unit [ ] scenario

---

## Stage B4: the binding table and drift

**Entry state.** After B1.4 the index holds every registration site; after B2.1
the runner can ask each program `actions --json`.

**What it delivers.** The *Suite bindings* view with the binding table from the
design, the per-binding drift list, and a cross-check against the programs.

**How it is built.** `computeCoverage(catalog, sitesByBinding)` is pure and
returns one row per catalog binding: `declared` (actions listing it), `found`
(distinct site names), `declaredNotFound`, `foundNotDeclared`, and
`duplicates` (a name with more than one site from the same recognizer). The
view is a `TreeDataProvider` over those rows, refreshed on `onDidChangeIndex`.
The cross-check adds `program` (the `actions --json` set) per row on demand.

**Step order and why.** The model first (pure, fully testable), then the view,
then the program cross-check, which needs built programs and is slower.

**Checklist.**

- [ ] B4.1 Coverage model: declared, found and drift per binding
- [ ] B4.2 The *Suite bindings* view
- [ ] B4.3 Cross-check with each program's `actions --json`

### B4.1 Coverage model: declared, found and drift per binding

* **Deliverable.** `computeCoverage()` returns the binding table and drift
  lists for the current index, and the command *Suite: Copy binding table*
  puts it on the clipboard as a Markdown table.
* **Why its own step.** The numbers are the claim E-B7 tests; they are proved
  before any UI shows them.
* **Implementation.**
  1. `src/core/coverage.ts`: `computeCoverage(catalog, sites):
     CoverageRow[]`, rows in catalog `bindings` order; `source` column is the
     common directory prefix of the binding's `sources` globs.
  2. `toMarkdownTable(rows)` with columns Binding, Source, Declared, Found,
     Drift.
  3. Command in `commands.ts`.
* **Contracts.**
  - B4.1-1 On the clean tree, Declared equals the catalog count per binding and
    Found equals Declared for every row.
  - B4.1-2 Removing one site moves exactly that name to `declaredNotFound`.
* **Files.** *edit*: `src/core/coverage.ts`, `src/features/commands.ts`;
  *new*: `test/unit/coverage.test.ts`.
* **Unit.** Clean, missing, extra, duplicate, unknown binding in a site. 100
  percent.
* **E2E.** The clean-tree half of
  [E-B7](design.md#e-b7-the-binding-table-matches-the-catalog-and-the-binaries-and-drift-appears-when-introduced),
  read from the model.
* **Depends on.** B1.4.
* **Status.** [ ] code [ ] unit [ ] scenario

### B4.2 The *Suite bindings* view

* **Deliverable.** A tree view in the Explorer showing the table; each row
  expands to its drift items, each of which opens the catalog entry or the
  registration site.
* **Why its own step.** It is the visible form of O6, separate from the model.
* **Implementation.**
  1. `contributes.views.explorer`: `bddSuite.bindings`, name *Suite bindings*,
     `when: bddSuite.active`.
  2. `src/features/coverageView.ts`: `TreeDataProvider`; row label
     `PowerShell  100 declared, 100 found, 0 drift`; children per drift item
     with a `command` that opens the location.
  3. Refresh on `onDidChangeIndex`.
* **Contracts.**
  - B4.2-1 The view's rows equal `computeCoverage()` at all times.
  - B4.2-2 Drift introduced by saving a binding file appears within 2 s.
* **Files.** *new*: `src/features/coverageView.ts`,
  `test/integration/suite/coverage.test.ts`.
* **Unit.** None beyond B4.1.
* **E2E.** The drift half of
  [E-B7](design.md#e-b7-the-binding-table-matches-the-catalog-and-the-binaries-and-drift-appears-when-introduced),
  in a worktree.
* **Depends on.** B4.1, B1.7.
* **Status.** [ ] code [ ] unit [ ] scenario

### B4.3 Cross-check with each program's `actions --json`

* **Deliverable.** A toolbar action on the view runs each binding's program
  `actions` verb and shows, per row, whether the program's set equals the
  catalog's and the source's, listing differences.
* **Why its own step.** It needs built programs and is the authoritative check
  for names a recognizer cannot see.
* **Implementation.**
  1. For each binding: `actionsCommand` through `runTool` with
     `ACTIONS_TIMEOUT_MS`; `parseActionsOutput`.
  2. Row gains `program: Set<string> | ToolFailure`; children list
     `program-only` and `program-missing` names.
* **Contracts.**
  - B4.3-1 On the clean tree each program's set equals the catalog's set for
    that binding.
  - B4.3-2 A program that fails shows its failure on its row and does not
    affect the others.
* **Files.** *edit*: `src/features/coverageView.ts`, `src/core/coverage.ts`.
* **Unit.** `compareProgramSet()`.
* **E2E.** The program half of
  [E-B7](design.md#e-b7-the-binding-table-matches-the-catalog-and-the-binaries-and-drift-appears-when-introduced).
* **Depends on.** B4.2, B2.1.
* **Status.** [ ] code [ ] unit [ ] scenario

---

## Stage B5: declaring and implementing an action

**Entry state.** After B1 and B2.1: the extension knows the catalog's layout
and every registry's location, and can run `Build-Schema.ps1`.

**What it delivers.** The two commands of DEC-B10: declare an action (catalog
entry, PowerShell registration, regenerated schema) and implement it in Go, Rust
or C# (registry entry, stub handler, catalog `bindings` updated, regenerated
schema).

**How it is built.** Each command computes a list of text insertions from the
current documents (pure functions in `src/core/catalogEdit.ts` and
`src/core/stubs.ts`), refuses if any anchor is not found, applies them as one
`WorkspaceEdit`, saves the touched files, and runs the generator.

Anchors, found by exact text in the current file (a refactor that moves them is
a template update, and the command refuses rather than guessing):

| Target | Insert registration | Insert handler |
| --- | --- | --- |
| Catalog | new entry after the last entry of the same family prefix (`demo.` sorts after the last `core.` etc.), else at the end of `actions:` | n/a |
| PowerShell | new file `scripts/e2e/actions/<Pascal>.ps1` | same file |
| Go, `lifecycle.*` | before the closing `}` of `var handlers = map[string]handler{` in `internal/lifecycle/actions.go` | end of file |
| Go, other | before the closing `}` of `return map[string]Handler{` in `Registry()` of `internal/actions/actions.go` | end of file |
| Rust, `lifecycle.*` | in `names()` before the closing `]` of `vec![` and in `dispatch()` before the `_ =>` arm (or the closing `}` of `match name {`) in `src/lifecycle/actions.rs` | end of file, above `#[cfg(test)]` if present |
| Rust, other | after the last `map.insert(` line in `registry()` in `src/actions.rs` | above `#[cfg(test)]` |
| C#, `lifecycle.*` | before the closing `};` of `private static readonly Dictionary<string, Handler> Handlers` in `Actions/Lifecycle/LifecycleActions.cs` | a new `partial class LifecycleContext` method in the same file, before the class's closing brace |
| C#, other | before the closing `};` of `Registry` in `Actions/CoreActions.cs` | before the class's closing brace |

Names: Go `camelCase` of the segments after the family (`demo.echo` ->
`demoEcho`); Rust `snake_case` (`demo_echo`); C# and PowerShell file names
`PascalCase` (`DemoEcho`).

**Step order and why.** Declaring comes first because implementing requires a
declared action. Go, Rust and C# are each their own step because each is one
compile that proves it, independently useful, with its own template.

**Checklist.**

- [ ] B5.1 Declare an action: catalog entry, PowerShell registration, schema
- [ ] B5.2 Implement in Go
- [ ] B5.3 Implement in Rust
- [ ] B5.4 Implement in C#

### B5.1 Declare an action: catalog entry, PowerShell registration, schema

* **Deliverable.** On a step naming an unknown action, the quick fix *Declare
  action <name>* (offered for `E104` from lint or from the YAML extension) adds
  the catalog entry, creates the PowerShell stub file, and regenerates the
  schema; the step's `E104` disappears on the next save.
* **Why its own step.** It is the only command that must touch the PowerShell
  binding (the catalog/registry name-set test), and it is useful alone.
* **Implementation.**
  1. `src/core/catalogEdit.ts`: `renderCatalogEntry(name, params:
     {name, value}[]): string` producing, at the catalog's two-space style:
     `- name`, `summary: TODO describe <name>.`, `bindings: [powershell]`,
     `interruptible: true`, `params` with `type` inferred from the YAML value
     (`string`, `integer`, `number`, `boolean`, `array`, `object`; a
     `${...}` value gives `string` and a `# TODO type` comment), and
     `captures: { type: object, additionalProperties: true }`. Step keys that
     are common to every step are excluded: the property names of
     `$defs.stepEnvelope.properties` in `test/e2e/schema/suite.base.json`, read
     at command time (today `action`, `meta`, `given`, `when`, `then`, `and`,
     `why`, and the rest of that object), so a field the format adds later is
     excluded without a release.
  2. `findCatalogInsertOffset(catalogText, name)` per the anchor table.
  3. `src/core/stubs.ts`: `planStub(binding, action, files): Insertion[] |
     {refused: string}` with templates `templates/powershell.ps1.tmpl` etc.;
     `${templatesDir}` overrides by file name.
  4. `src/features/scaffold.ts`: `CodeActionProvider` for suites, offering the
     fix when a diagnostic with code `E104` (any source) covers an action
     value not in the catalog. Applies the `WorkspaceEdit`, saves, runs
     `schemaGenerator` with `SCHEMA_TIMEOUT_MS`, reports its result.
* **Contracts.**
  - B5.1-1 After the command, `Build-Schema.ps1 -Check` exits 0 and
    `scripts/e2e/SuiteLint.Tests.ps1` passes.
  - B5.1-2 One undo reverts the catalog and stub text.
  - B5.1-3 An action already in the catalog is never declared twice.
  - B5.1-4 Common step fields never become catalog parameters.
* **Constraints.** `SCHEMA_TIMEOUT_MS`; INV-1, INV-8.
* **Files.** *new*: `src/core/catalogEdit.ts`, `src/core/stubs.ts`,
  `templates/powershell.ps1.tmpl`, `src/features/scaffold.ts`,
  `test/unit/catalogEdit.test.ts`, `test/unit/stubs.test.ts`,
  `test/integration/suite/scaffold.test.ts`.
* **Unit.** Type inference table; insertion offsets in a catalog fixture with
  and without the family present; refusal when the anchor is missing; template
  override. 100 percent of both modules.
* **E2E.** Steps 1 and 3 (PowerShell and schema checks) of
  [E-B6](design.md#e-b6-a-new-action-is-declared-and-implemented-in-all-four-bindings-from-the-editor),
  in a worktree.
* **Depends on.** B1.2, B2.1, B2.2.
* **Status.** [ ] code [ ] unit [ ] scenario

### B5.2 Implement in Go

* **Deliverable.** *Suite: Implement action in binding...* with Go chosen adds
  a map entry and a stub handler that compiles and fails with `Failed(...)`,
  adds `go` to the action's catalog `bindings`, and regenerates the schema.
* **Why its own step.** One binding, one template, one compile that proves it.
* **Implementation.**
  1. `templates/go.core.tmpl`:
     `func {{goName}}(request *Request) (any, error) {\n\treturn nil, Failed("{{action}}: not implemented in the Go binding yet")\n}`.
     `templates/go.lifecycle.tmpl`:
     `func {{goName}}(context *Context, request *actions.Request) (any, error) {\n\treturn nil, actions.Failed("{{action}}: not implemented in the Go binding yet")\n}`.
     Registration line `\t\t"{{action}}": {{goName}},` aligned to the
     surrounding entries' column with `gofmt` run afterwards on the file
     (`gofmt -w <file>`, through `runTool`).
  2. Catalog `bindings` edit: rewrite the flow sequence on `bindingsRange`
     appending the binding, keeping the catalog's top-level order.
  3. Refuse if the action already has a Go site.
* **Contracts.**
  - B5.2-1 `go build ./...` and `go vet ./...` succeed after the command.
  - B5.2-2 The program's `actions --json` includes the action.
  - B5.2-3 Running a suite using it under Go fails that step with a message
    containing `not implemented`.
* **Files.** *new*: `templates/go.core.tmpl`, `templates/go.lifecycle.tmpl`;
  *edit*: `src/core/stubs.ts`, `src/features/scaffold.ts`.
* **Unit.** Rendering and anchors on fixture copies of both Go files.
* **E2E.** The Go part of
  [E-B6](design.md#e-b6-a-new-action-is-declared-and-implemented-in-all-four-bindings-from-the-editor).
* **Depends on.** B5.1.
* **Status.** [ ] code [ ] unit [ ] scenario

### B5.3 Implement in Rust

* **Deliverable.** As B5.2 for Rust: `map.insert` (or `names()` plus a
  `dispatch()` arm for `lifecycle.*`) and a stub returning
  `Err(ActionError::action(...))`.
* **Why its own step.** As B5.2.
* **Implementation.**
  1. `templates/rust.core.tmpl`:
     `fn {{rustName}}(_request: &Request) -> Outcome {\n    Err(ActionError::action("{{action}}: not implemented in the Rust binding yet".to_string()))\n}`.
     `templates/rust.lifecycle.tmpl`:
     `pub fn {{rustName}}(_context: &Shared, _step: &Value) -> Result<Value, ActionError> {\n    Err(ActionError::action("{{action}}: not implemented in the Rust binding yet".to_string()))\n}`.
     Before writing, read `ActionError::action`'s signature in
     `src/actions.rs`/`src/lifecycle/actions.rs` at the commit under test and
     record here whether it takes `String` or `impl Into<String>`; the
     template above assumes `String`, as `core_fail` passes one.
  2. Lifecycle: insert the name into `names()` in sorted position (the list is
     sorted) and the arm into `dispatch()`.
  3. `rustfmt` the file through `runTool`.
* **Contracts.**
  - B5.3-1 `cargo build` succeeds with no new warnings.
  - B5.3-2 and B5.3-3 as B5.2-2 and B5.2-3 for Rust.
* **Files.** *new*: `templates/rust.core.tmpl`,
  `templates/rust.lifecycle.tmpl`; *edit*: `src/core/stubs.ts`.
* **Unit.** As B5.2, on fixture copies of both Rust files.
* **E2E.** The Rust part of
  [E-B6](design.md#e-b6-a-new-action-is-declared-and-implemented-in-all-four-bindings-from-the-editor).
* **Depends on.** B5.1.
* **Status.** [ ] code [ ] unit [ ] scenario

### B5.4 Implement in C#

* **Deliverable.** As B5.2 for C#: a dictionary entry and a stub that throws
  `ActionException.Failed(...)`.
* **Why its own step.** As B5.2; C# also treats warnings as errors
  (`Directory.Build.props`), which the template must respect.
* **Implementation.**
  1. `templates/csharp.core.tmpl`:
     `private static object? {{pascalName}}(ActionRequest request) =>\n    throw ActionException.Failed("{{action}}: not implemented in the C# binding yet");`
     and entry `["{{action}}"] = {{pascalName}},`.
     `templates/csharp.lifecycle.tmpl`: entry
     `["{{action}}"] = (context, request) => context.{{pascalName}}(request),`
     and method
     `private object? {{pascalName}}(ActionRequest request) =>\n    throw ActionException.Failed("{{action}}: not implemented in the C# binding yet");`
     inside `LifecycleContext`.
  2. Indentation from the anchor line.
* **Contracts.**
  - B5.4-1 `dotnet build Hci.E2E.Suite.sln` succeeds (warnings are errors).
  - B5.4-2 and B5.4-3 as B5.2-2 and B5.2-3 for C#.
* **Files.** *new*: `templates/csharp.core.tmpl`,
  `templates/csharp.lifecycle.tmpl`; *edit*: `src/core/stubs.ts`.
* **Unit.** As B5.2, on fixture copies of both C# files.
* **E2E.** The C# part of
  [E-B6](design.md#e-b6-a-new-action-is-declared-and-implemented-in-all-four-bindings-from-the-editor);
  E-B6 is complete when B5.1-B5.4 have each passed their part.
* **Depends on.** B5.1.
* **Status.** [ ] code [ ] unit [ ] scenario

---

## Stage B6: running suites from Test Explorer

**Entry state.** After B1.3 the index knows every case and outline; after B2.1
the runner can start any binding's `run` and `list` verbs.

**What it delivers.** Cases (and outline rows) in Test Explorer; run and
dry-run under the target binding; lab parameters; a confirmed lab run; safe
cancellation.

**How it is built.**

```
 index --> TestController 'bddSuite'
             file item -- case item -- row item (examples)
 run(request) -> group items by file -> for each file:
     runCommand(target, rel, {traceFile, resultsFile, dryRun, lab?}) -> runTool (no timeout)
     -> read trace JSON -> mapTrace(trace, caseNames) -> TestRun.passed/failed/errored/skipped
```

`mapTrace` reads entries with `phase: case` (one per case or outline row, with
`status` and `reason`), attaches `step` entries with `status: failed` as the
failure message (keyword, sentence, action), and reports `suite-setup` and
`suite-teardown` failures on the file item. Item ids are
`<rel>::<case name>` and `<rel>::<case name> [<col>=<val>, ...]`, the latter
exactly the name the bindings report (DEC-Y24).

The PowerShell runner's run command:
`pwsh -NoProfile -NonInteractive -File scripts/e2e/Invoke-LabTestSuite.ps1
-Path <rel> -TraceFile <t> -ResultsFile <r>` plus `-TestName <case>` when exactly
one case is requested and `-DryRun` for dry-run; lab values through the
script's existing parameters, read from its param block in B6.4 and recorded
there.

**Step order and why.** Discovery first (visible without running anything).
Offline run next, proved by the corpus. Dry-run is a flag on the same path.
Lab parameters and confirmation are separate because they are the only part
that touches a lab. Cancellation last, because it has to be proved on both
offline and lab paths.

**Checklist.**

- [ ] B6.1 Cases and outline rows as test items
- [ ] B6.2 Offline run under the target binding, mapped from the trace
- [ ] B6.3 Dry-run profile
- [ ] B6.4 Lab run: parameters, list preview and confirmation
- [ ] B6.5 Cancellation that says what it leaves behind

### B6.1 Cases and outline rows as test items

* **Deliverable.** Test Explorer lists every suite file, its cases, and each
  outline's rows, and updates as files change.
* **Why its own step.** Discovery is visible and testable without running
  anything.
* **Implementation.** `src/features/testing.ts`:
  `tests.createTestController('bddSuite', 'Suites')`; items from
  `index.suites` (not libraries); row labels built by `outlineRowName(caseName,
  row)` in `src/core/trace.ts`, which joins `column=value` in the row's key
  order with `, `. Refresh on `onDidChangeIndex`.
* **Contracts.**
  - B6.1-1 Row item names equal the names the bindings report, checked against
    `test/e2e/conformance/execute/gherkin.expected.json`.
* **Files.** *new*: `src/features/testing.ts`, `src/core/trace.ts`,
  `test/unit/trace.test.ts`.
* **Unit.** `outlineRowName` with strings, numbers, booleans; 100 percent of
  what `trace.ts` holds at this step.
* **E2E.** The discovery half of
  [E-B9](design.md#e-b9-an-offline-suite-runs-under-each-binding-and-each-case-shows-the-corpus-result).
* **Depends on.** B1.3.
* **Status.** [ ] code [ ] unit [ ] scenario

### B6.2 Offline run under the target binding, mapped from the trace

* **Deliverable.** *Run* on a file or case item runs the file under the target
  binding and marks each case passed, failed or errored, with the failing step's
  keyword and sentence in the message.
* **Why its own step.** The core of O7, provable entirely offline against the
  corpus.
* **Implementation.**
  1. `runCommand()` per binding: `suiterun run --path <rel> --trace-file <t>
     --results <r> --format nunit3`; PowerShell as in the stage introduction.
     `<t>` and `<r>` under `context.storageUri/runs/<hash of rel>/`.
  2. `mapTrace(trace, items)` in `src/core/trace.ts`.
  3. For Go, Rust and C#, a run of one case runs the file; the run's output
     says so and reports every case it got.
* **Contracts.**
  - B6.2-1 Item results equal the expected trace's `case` entries for the
    corpus files of E-B9, under all four bindings.
  - B6.2-2 A missing or malformed trace marks every item errored "no trace".
* **Files.** *edit*: `src/features/testing.ts`, `src/core/trace.ts`,
  `src/tools/profiles.ts`; *new*: `test/integration/suite/testing.test.ts`.
* **Unit.** `mapTrace` over the real expected traces copied as fixtures at test
  time from `OS_CONTEXT_ROOT`, plus synthetic setup-failure and teardown-failure
  traces. 100 percent of `trace.ts`.
* **E2E.** [E-B9](design.md#e-b9-an-offline-suite-runs-under-each-binding-and-each-case-shows-the-corpus-result).
* **Depends on.** B6.1, B2.1.
* **Status.** [ ] code [ ] unit [ ] scenario

### B6.3 Dry-run profile

* **Deliverable.** A second run profile, *Dry run*, passes `--dry-run`
  (`-DryRun` for PowerShell) and shows the cases that would run.
* **Why its own step.** A separate profile with its own observable output, and
  the cheap way to check a selection before a lab run.
* **Implementation.** `TestRunProfile` of kind `Run` labelled *Dry run*;
  results mapped as B6.2 with skipped items shown as skipped.
* **Contracts.** B6.3-1 A dry run starts no action (checked with a corpus file
  whose steps use `core.record`: no record file appears).
* **Files.** *edit*: `src/features/testing.ts`, `src/tools/profiles.ts`.
* **Unit.** Argument construction.
* **E2E.** Part of
  [E-B9](design.md#e-b9-an-offline-suite-runs-under-each-binding-and-each-case-shows-the-corpus-result)
  (dry-run variant).
* **Depends on.** B6.2.
* **Status.** [ ] code [ ] unit [ ] scenario

### B6.4 Lab run: parameters, list preview and confirmation

* **Deliverable.** A run of a lab suite asks for (or reads) the API URL, lab id
  and connection file, runs `list` with the same filter, shows binding, lab and
  case list in a modal confirmation, and only then runs with `--api-url`,
  `--lab-id` and `--connection-file`.
* **Why its own step.** It is the only step that can change a lab, and the only
  one with a remote scenario.
* **Implementation.**
  1. A suite is a lab suite unless every action it uses is `core.*` or `wait`.
  2. Missing settings are asked with `showInputBox` (connection file with
     `showOpenDialog`) and offered to be saved to workspace settings. No other
     value is stored (INV-7).
  3. `listCommand` with the run's `--tags`; the modal shows its lines.
  4. The run command line, minus nothing (it contains no secret), is written to
     the output channel so the operator can repeat it in a terminal.
  5. PowerShell: read the lab parameters of `Invoke-LabTestSuite.ps1`'s param
     block at the commit under test and record their names here before
     wiring them.
* **Contracts.**
  - B6.4-1 No lab run starts without the confirmation (INV-6).
  - B6.4-2 The confirmation's case list is the `list` output.
  - B6.4-3 Results equal a terminal run of the printed command.
* **Constraints.** No run timeout ([2.6](#26-hard-limits)).
* **Files.** *edit*: `src/features/testing.ts`, `src/tools/profiles.ts`.
* **Unit.** Lab-suite classification; argument construction with and without
  each lab value.
* **E2E.** [E-B10](design.md#e-b10-the-portable-stage-0-cases-run-from-the-editor-against-a-real-lab),
  run in B7.3. In this stage the step closes on code, unit and a recorded
  manual check that the confirmation appears and *Cancel* starts nothing
  (labelled `manual`; it does not tick the scenario box).
* **Depends on.** B6.2.
* **Status.** [ ] code [ ] unit [-] scenario, closed by B7.3

### B6.5 Cancellation that says what it leaves behind

* **Deliverable.** Cancelling an offline run kills it and marks unreported items
  skipped; cancelling a lab run first warns that cleanup and teardown may not
  run and kills only on confirmation.
* **Why its own step.** Killing a runner mid-step is the one way the extension
  could leave lab state behind; it is specified and tested on its own.
* **Implementation.**
  1. `TestRun.token.onCancellationRequested`: offline, cancel the `runTool`
     token; lab, show a modal ("The suite's cleanup and teardown may not run.
     Stop anyway?"), and cancel only on *Stop*. If the operator declines, the
     run continues and the Test Explorer run stays active.
  2. After a kill, read the partial trace if present and map it; remaining items
     are skipped with "cancelled".
* **Contracts.**
  - B6.5-1 No child survives `KILL_GRACE_MS` after an offline cancel.
  - B6.5-2 A lab cancel without confirmation leaves the process running.
* **Files.** *edit*: `src/features/testing.ts`.
* **Unit.** Partial-trace mapping.
* **E2E.** Part of
  [E-B9](design.md#e-b9-an-offline-suite-runs-under-each-binding-and-each-case-shows-the-corpus-result):
  cancel `execute/hung-step.yml` (a 600 s `core.sleep`) and check B6.5-1. The
  lab path is checked as part of B6.4's manual check and not run against a lab.
* **Depends on.** B6.2.
* **Status.** [ ] code [ ] unit [ ] scenario

---

## Stage B7: package and accept

**Entry state.** Every build step done, each with its scenario passed on the
development build.

**What it delivers.** A `.vsix` with a recorded hash, every offline scenario
re-run on that exact package, and the lab scenario run once.

**How it is built.** `runTest.ts` gains `--vsix <path>`: it installs the
package into the fresh `--extensions-dir` with the downloaded VS Code's CLI
(`resolveCliArgsFromVSCodeExecutablePath`, then `--install-extension`) and
points `extensionDevelopmentPath` at an empty stub so the installed package,
not the source tree, is what runs.

**Step order and why.** Package, then offline acceptance on it, then the lab run
last, because it is the only scenario with external lead time and must run on a
package already green locally.

**Checklist.**

- [ ] B7.1 Package and install
- [ ] B7.2 Offline acceptance on the package
- [ ] B7.3 Lab acceptance on the package

### B7.1 Package and install

* **Deliverable.** `npm run package` produces `bdd-suite-<version>.vsix` and its
  SHA-256; `README.md` says how to install it and what it needs.
* **Why its own step.** The artefact that the acceptance runs against.
* **Implementation.** `.vscodeignore` excludes `src/`, `test/`, `out-test/`,
  `docs/`, maps; `README.md` covers install
  (`code --install-extension bdd-suite-<v>.vsix`), the
  `redhat.vscode-yaml` dependency, the settings table, how to build each lint
  tool, and the limits of DEC-B03 (lint on save).
* **Contracts.** B7.1-1 The package contains `dist/extension.js`, `templates/`,
  `package.json`, `README.md` and nothing under `src/` or `test/`
  (checked by listing the archive).
* **Files.** *edit*: `.vscodeignore`, `README.md`; *new*:
  `scripts/package.mjs`.
* **Unit.** None.
* **E2E.** None of its own; B7.2 runs on its output.
* **Depends on.** All of B1-B6.
* **Status.** [ ] code [ ] unit [ ] scenario

### B7.2 Offline acceptance on the package

* **Deliverable.** E-B1 to E-B9 and E-B11 pass on the packaged extension, with a
  recorded result file.
* **Why its own step.** The build stages proved the development build; this
  proves what a user installs.
* **Implementation.** `npm run test:integration -- --vsix <path>`; the harness
  writes `artifacts/acceptance-<date>.json` with the `.vsix` SHA-256, this
  repository's commit, `os-context`'s commit, VS Code version, and per-scenario
  results.
* **Contracts.** B7.2-1 Every listed scenario passes; a skipped or failed one
  leaves this step open.
* **Files.** *edit*: `test/integration/runTest.ts`.
* **Unit.** None.
* **E2E.** E-B1 to E-B9, E-B11.
* **Depends on.** B7.1.
* **Status.** [ ] code [ ] unit [ ] scenario

### B7.3 Lab acceptance on the package

* **Deliverable.** E-B10 passed once on the same package as B7.2, with its
  evidence recorded.
* **Why its own step.** The only lab scenario; it has external prerequisites and
  must not be mixed into an offline batch.
* **Implementation.**
  1. **Target discovery.** The operator names the lab. The API URL, the lab's
     lineage id and the connection file path are supplied at run time through
     `BDD_LAB_API_URL`, `BDD_LAB_ID` and `BDD_LAB_CONNECTION_FILE`; the harness
     writes them to the test workspace's settings and never to this
     repository.
  2. **Transport.** The controller (the developer's machine) reaches the API
     directly, the way `suiterun run --api-url` does today; the extension adds
     no transport or jump path.
  3. **Preflight.** The harness runs `suiterun list --path
     test/e2e/suites/lifecycle-stage0.yml --tags portable` (tags are an *or*
     filter: `TagsMatch` in `internal/suite/suite.go`) and stops without
     running unless (a) the listed case names equal the cases the extension's
     index finds carrying `portable`, and (b) every action those cases use,
     including through `beforeEach` and imported meta steps, lists `go` in the
     catalog. It then prints E-B10's footprint statement (one bootstrap run
     record per execution, from `S0-48-ready-host-bootstrap-is-verified`) and
     requires `BDD_LAB_ACCEPT_FOOTPRINT=1` to continue.
  4. **Run.** `npm run test:lab -- --vsix <path>`: the harness drives Test
     Explorer with the tag filter, auto-confirms the modal only after asserting
     its contents (binding, lab id, API URL, and the preflight's case list),
     waits without a timeout of its own (the suite's limits apply), then runs the
     printed command in a terminal with a different `--results` path.
  5. **Assert** per E-B10's Then, canonicalising both reports with the corpus's
     comparer (`test/e2e/conformance/report/canonicalise.md`, `-IgnoreOutput`).
  6. **Record** in `artifacts/lab-acceptance-<date>.json`: `.vsix` SHA-256,
     both commits, lab id, API URL, start and end, both NUnit reports, and the
     two bootstrap run ids read from the reports' captured output.
* **Contracts.** B7.3-1 E-B10 passes; a skip, block or failure leaves this step
  and B6.4's scenario box open.
* **Constraints.** No run timeout; the suite's own limits apply.
* **Files.** *new*: `test/integration/suite/lab.test.ts`.
* **Unit.** None.
* **E2E.** [E-B10](design.md#e-b10-the-portable-stage-0-cases-run-from-the-editor-against-a-real-lab).
* **Depends on.** B7.2.
* **Status.** [ ] code [ ] unit [ ] scenario

---

## 5. Open questions

1. **A case-name filter on `suiterun run`.** DEC-B11 runs a whole file under Go,
   Rust and C# because the shared command line has no case filter. Adding
   `--case <name>` to DEC-Y14 in `os-context` (four bindings and a corpus entry)
   would let the extension run one case everywhere. Not part of this plan; the
   extension would adopt it by adding the flag in `runCommand()`.
2. **Do the binding programs run cleanup on an interrupt?** B6.5 assumes a kill
   skips cleanup and warns accordingly. If the programs handle Ctrl+C by
   running `cleanup`, `afterEach` and `teardown`, the extension could send that
   first and kill only after a grace period. Needs a check in each binding.
3. **Live dataflow while typing.** DEC-B03 lints on save. If a binding gains a
   `lint --stdin --as <path>` mode that reads the buffer but resolves imports
   from the given path, the extension could lint unsaved buffers with no
   approximation. That is a change to the shared contract, not to this
   extension.
4. **The meta-used-twice defect in `os-context`** (its plan, open question 4).
   The scope model of B3.3 records exports at the first use, which is what the
   bindings will do once fixed; until then lint may report an `E303` that
   completion did not predict. Nothing to do here but keep B3.3's rule.
5. **Non-Windows hosts.** `killTree`'s POSIX path is unit-tested only. If the
   extension is used on Linux or macOS, E-B11 needs a run there.

---

## 6. Index

| Step | Outcome | Decisions | Scenario | Invariants |
| --- | --- | --- | --- | --- |
| B1.1 | all | DEC-B13, DEC-B14 | (activation test) | INV-9 |
| B1.2 | O2, O8 | DEC-B07 | E-B2, E-B8 | INV-2 |
| B1.3 | O3 | DEC-B01, DEC-B07 | E-B3 | INV-9 |
| B1.4 | O3, O6 | DEC-B05, DEC-B06 | E-B3, E-B7 | INV-2 |
| B1.5 | O3 | DEC-B01 | E-B4 | |
| B1.6 | O3 | DEC-B07 | E-B3 | |
| B1.7 | O8 | DEC-B07 | E-B8, E-B7 | |
| B2.1 | O1 | DEC-B02 | E-B1 | INV-5, INV-10 |
| B2.2 | O1 | DEC-B02, DEC-B03 | E-B1 | INV-3, INV-4 |
| B2.3 | O2 | DEC-B04 | E-B2 | |
| B2.4 | O1 | DEC-B02 | E-B11 | INV-4, INV-5 |
| B2.5 | O1 | DEC-B04 | E-B1 | |
| B3.1 | O2, O4 | DEC-B09 | E-B2, E-B5 | |
| B3.2 | O4 | DEC-B08 | E-B5 | INV-9 |
| B3.3 | O4 | DEC-B08 | E-B5 | |
| B3.4 | O4, O8 | DEC-B08 | E-B5, E-B8 | |
| B3.5 | O4 | DEC-B08 | E-B5 | |
| B4.1 | O6 | DEC-B05 | E-B7 | |
| B4.2 | O6 | DEC-B05 | E-B7 | |
| B4.3 | O6 | DEC-B05 | E-B7 | INV-5 |
| B5.1 | O5 | DEC-B10 | E-B6 | INV-1, INV-8 |
| B5.2 | O5 | DEC-B10 | E-B6 | INV-1, INV-8 |
| B5.3 | O5 | DEC-B10 | E-B6 | INV-1, INV-8 |
| B5.4 | O5 | DEC-B10 | E-B6 | INV-1, INV-8 |
| B6.1 | O7 | DEC-B11 | E-B9 | |
| B6.2 | O7 | DEC-B11 | E-B9 | INV-5, INV-10 |
| B6.3 | O7 | DEC-B11 | E-B9 | INV-6 |
| B6.4 | O7 | DEC-B11, DEC-B12 | E-B10 | INV-6, INV-7 |
| B6.5 | O7 | DEC-B12 | E-B9 | INV-5 |
| B7.1 | all | DEC-B14 | (all, via B7.2) | |
| B7.2 | all | DEC-B14 | E-B1-E-B9, E-B11 | |
| B7.3 | O7 | DEC-B12, DEC-B14 | E-B10 | INV-6, INV-7 |
