# Suite authoring in VS Code: implementation plan

The design is [design.md](design.md). It says what the extension does and why;
this plan says how, step by step, with a status that is ticked only against
evidence. Goals, decisions and scenarios are not restated here; they are linked
by ID: outcomes `O1`-`O10`, decisions `DEC-B01`-`DEC-B22`, scenarios
`E-B1`-`E-B15`.

**Revision 2 (2026-10-14).** Adds the TypeScript binding (stage B8, built in
`os-context`) and lint while typing through it (stage B9). It also adds step
B2.6 (workspace trust) and step B5.5 (TypeScript stubs), and the TypeScript
defaults in [2.8](#28-settings). No existing step ID moved. Stages are listed in
delivery order, so B8 and B9 appear before B7, which now depends on them.

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

**Two repositories.** Stages B1-B7 and B9 are built here, in
`bdd-code-extension`. Stage B8 is built in `os-context`, under that
repository's own rules (its `CLAUDE.md`):

* commit only when asked, and never push;
* ASCII only in scripts;
* no `.vscode`-only conventions;
* any version bump that `Build-All.ps1` writes is left unstaged.

B8's steps name `os-context` paths without a prefix, and everything they add
lives under `test/e2e/bindings/typescript/` except the admission edits
(design [2.5](design.md#25-admitting-a-fifth-binding)).

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
| Lint worker host | `src/lint/workerHost.ts` | `LintWorkerHost` (start, `lint()`, terminate, restart) | extension host |
| Lint worker | `src/lint/worker.ts`, bundled to `dist/lintWorker.js` | message loop that `import()`s the TypeScript library and calls `createLinter().lint()` | a `worker_threads` thread in the extension host process |
| Trust gate | `src/config/trust.ts` | `canRunWorkspaceCode()`, `onTrustChanged` | extension host |
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
| Binding sources | `scripts/e2e/actions/*.ps1`; `test/e2e/bindings/go/internal/**/*.go`; `test/e2e/bindings/rust/src/**/*.rs`; `test/e2e/bindings/dotnet/Hci.E2E.Suite/**/*.cs`; `test/e2e/bindings/typescript/src/**/*.ts` | Registrations |
| Binding programs | see [2.4](#24-how-a-tool-call-is-set-up-end-to-end) | Tool runner |
| TypeScript library | `test/e2e/bindings/typescript/dist/index.js` | Lint worker |
| Corpus | `test/e2e/conformance/run-manifest.yaml` and its entries | E-B1, E-B9, E-B14 oracles |

The TypeScript binding's own module map (built in B8, in `os-context`). Each
module has the Go package of the same responsibility beside it, so a reviewer
can compare like with like.

| Module (`test/e2e/bindings/typescript/`) | Mirrors Go | Exports | Built in |
| --- | --- | --- | --- |
| `package.json`, `package-lock.json`, `tsconfig.json` | `go.mod` | `name: "@os-context/suiterun"`, `private: true`, `type: "module"`, `bin: { suiterun: "dist/cli.js" }`, `engines: { node: ">=24" }`, scripts `build` (`tsc -p .`), `test` (`c8 ... node --test`), `lint:types` | B8.1 |
| `src/cli.ts` | `cmd/suiterun`, `internal/cli` | `parse(argv): Options`, `main(argv): Promise<number>`, `EXIT_PASSED`=0, `EXIT_FAILED`=1, `EXIT_REFUSED`=2, `USAGE` | B8.1 |
| `src/run.ts` | `internal/run` | `execute(options): Promise<Report>`, `lintVerb`, `runVerb`, `listVerb`, `actionsVerb` | B8.1, filled by B8.4-B8.6 |
| `src/index.ts` | (none: the library API) | `apiVersion = '1.0.0'`, `createLinter({ root, schemaRoot? }): Linter` with `lint(request)` and `invalidate()`; types `LintRequest`, `Diagnostic` | B8.4 |
| `src/paths.ts` | `internal/paths` | `repositoryRoot(start)`, `schemaRoot(root)`, `corpusRoot(root)`, `matchesGlob()`, `resolveGlob()` | B8.1 |
| `src/schema.ts` | `internal/schema` | `loadSchema(schemaRoot, overlay?)`, `Schema`, `Action` (`name`, `bindings`, `interruptible`, `deprecated`, `params`, `captures`) | B8.2 |
| `src/model.ts`, `src/value.ts` | `internal/model`, `internal/value` | `loadDocument(text): { value, positions }`, `Value` (`null`, `boolean`, `string`, `bigint` = int, `number` = float, `Value[]`, `Map<string, Value>`), `text()`, `asNumber()`, `toJson()` | B8.2 |
| `src/walk.ts` | `internal/walk` | `allSteps()`, `stepLists()`, `hooks()`, `casePhases()` | B8.2 |
| `src/diag.ts`, `src/spelling.ts` | `internal/diag`, `internal/spelling` | `Diagnostic`, `sorted()` (total order and dedup), `fails()`, `toJsonArray()`, `nearest()` | B8.2 |
| `src/validate/structure.ts` | `internal/validate/structure.go` | `checkStructure()` (E100-E105) | B8.2 |
| `src/validate/semantics.ts`, `src/validate/dataflow.ts`, `src/validate/index.ts` | `internal/validate` | `checkSemantics()` (E2xx, W302, W304), `checkDataflow()` (E3xx, W301, W303), `validateFile()` | B8.4 |
| `src/expr.ts`, `src/assertion.ts` | `internal/expr`, `internal/assertion` | `evaluate()`, `expand()`, `Scope`, `FUNCTIONS` (21), `compare()`, `OPERATORS`, `unportable()` | B8.3 |
| `src/suite.ts`, `src/exec.ts`, `src/trace.ts` | `internal/suite`, `internal/exec`, `internal/trace` | `expandSteps()`, `expandOutline()`, `resolveParams()`, `resolveVars()`, `runFile()`, `Trace` | B8.5 |
| `src/actions/registry.ts`, `src/actions/core.ts` | `internal/actions` | `action(name, handler)`, `Request`, `Handler`, `failed()`, `timedOut()`, `coreActions` (the five `core.*` and `wait`) | B8.5 |
| `src/report.ts` | `internal/report` | `nunit3()`, `junit()` | B8.6 |
| `src/lifecycle/context.ts`, `src/lifecycle/actions.ts`, `src/lifecycle/stream.ts` | `internal/lifecycle` | `LifecycleContext` (`request()`, `credentials()`, `redact()`), `lifecycleActions` (18), `Stream`, `readFrame()` | B8.7 |
| `test/conformance/*.test.ts` | `internal/conformance` | manifest, validate, execute, expressions, asserts, report, canonical | B8.1-B8.6 |

### 2.2 Interfaces and who calls whom

```
 VS Code --(provider calls)--> features/* --(queries)--> WorkspaceIndex
 VS Code --(save/open/change events)--> features/indexer glue --(parse*)--> WorkspaceIndex.update*
 features/lintController --> tools/profiles.lintCommand --> tools/runTool --spawn--> suiterun | pwsh
 features/lintController --> lint/workerHost.lint --postMessage--> lint/worker --import()--> os-context typescript dist/index.js
 every spawn and every worker start --> config/trust.canRunWorkspaceCode() first (INV-11)
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

Two exceptions to item 4, for `build` commands only (B2.4, B9.1):

* `npm` on Windows is `npm.cmd`, which Node refuses to spawn without a shell
  (`EINVAL`, since Node 20's fix for CVE-2024-27980).
* A build is a fixed string from settings, never containing a workspace file
  name.

So `buildCommand()` may return `{ command: string, shell: true }`, and
`runTool()` accepts `shell: true` only from `buildCommand()`; a unit test
asserts no other profile function returns it.

### 2.4b How an in-editor lint is set up end to end

Used when `bddSuite.lintTool` is `typescript` (B9). Items 1, 2, 8 and 9 above are
unchanged; items 3 to 7 are replaced by:

3. **Gate.** `canRunWorkspaceCode()` (INV-11). If false, no lint; status bar.
4. **Worker.** `LintWorkerHost` holds at most one `Worker` per window, created
   from `dist/lintWorker.js` with `workerData: { libraryPath }`, where
   `libraryPath` is `<root>/test/e2e/bindings/typescript/dist/index.js`
   (setting `bddSuite.bindings.typescript.library`). On start the worker runs
   `await import(pathToFileURL(libraryPath).href)`. It checks that
   `apiVersion` parses as semver with major `1`, and replies
   `{ type: 'ready', apiVersion }` or `{ type: 'refused', reason }`.
   The library resolves its own dependencies (`yaml`, `ajv`) from its own
   `node_modules`, never from the extension's.
5. **Request.** `host.lint({ id, root, paths: [rel], binding: target,
   bindingCheck: true, strict: false, overlays })` posts one message.
   `overlays` is an object of absolute path to text for every dirty suite or
   library document open in the window. A unique `id` per request; the host
   keeps only the newest `id` per linted file (INV-4). The worker keeps one
   `createLinter({ root })` per root and calls `linter.lint(request)`.
6. **Bound.** A timer of `WORKER_LINT_TIMEOUT_MS`. On expiry, or on a `type:
   'error'` reply, or on the worker's `exit` or `error` event, the host calls
   `worker.terminate()`, drops the worker, and returns
   `failure/timeout|crash`. The next request starts a new worker.
   `WORKER_MAX_CONSECUTIVE_FAILURES` failures in a row pause live lint until
   the next save. Cancellation of a superseded request does not terminate the
   worker, since the library is synchronous and short; the stale reply is
   discarded when it arrives.
7. **Interpret.** The reply `{ type: 'result', id, diagnostics }` carries the
   same objects `lint --json` prints. They go through the same
   `parseLintOutput()` shape check (after `JSON.stringify`) so both paths are
   held to `diagnostic.schema.json` by one function.

When the catalog or `suite.schema.json` changes (index watcher, B1.7), the host
posts `{ type: 'invalidate', root }`, and the worker calls
`linter.invalidate()` so the next lint reloads them.

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
| The lint worker and its newest request id per file | `LintWorkerHost` | start, each request, terminate | `LintController`, `deactivate()` |
| Loaded library and cached linters | the worker thread | `import()` once; `createLinter` once per root; `invalidate()` on catalog or schema change | the worker only |
| Unsaved text sent for lint | nobody: copied into each request and discarded with it | each live lint | the worker, for that one request |
| Workspace trust | VS Code; mirrored by `trust.ts` | `workspace.onDidGrantWorkspaceTrust` | every spawn and worker start |
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
| `LIVE_LINT_DEBOUNCE_MS` | 400 | A pause long enough to be a pause, short enough that O10's one second holds with a lint that B9.3 measures; B9.3 may lower it, never raise it past 600 without changing O10 |
| `WORKER_LINT_TIMEOUT_MS` | 5000 | Five times O10's budget; a lint that takes longer is a defect to report, and terminating it keeps the editor responsive |
| `WORKER_MAX_CONSECUTIVE_FAILURES` | 3 | A library that fails three times running is broken, not unlucky; live lint pauses until a save rather than restarting a worker per keystroke |
| `LIBRARY_API_MAJOR` | 1 | The `apiVersion` major the extension speaks (DEC-B19) |
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
11. **INV-11.** No process is spawned, no worker started, and nothing imported
    from the workspace unless `canRunWorkspaceCode()` returns true
    (DEC-B22). `runTool()` and `LintWorkerHost.start()` check it themselves,
    not only their callers.
12. **INV-12.** The extension never writes unsaved text to disk to lint it.
    Unsaved text reaches a binding only as an overlay in a worker request.
13. **INV-13.** The extension and the TypeScript binding share no code. The
    extension reaches the binding only through `createLinter()` and the
    `suiterun` program; the binding imports nothing from the extension.

The TypeScript binding (B8) has its own invariants, numbered `TS-n`, which its
code and tests cite:

1. **TS-1.** No YAML mapping is a plain object; every one is a `Map`.
2. **TS-2.** An integer is a `bigint` and a float is a `number`, from parse to
   output; no arithmetic mixes them without an explicit conversion.
3. **TS-3.** Every string the binding writes (stdout, stderr, trace, report,
   captured output, error messages) passes through `redact()` once secrets are
   known.
4. **TS-4.** No action runs without an `AbortSignal` that fires at its limit.
5. **TS-5.** Nothing in `src/` reads a file except through the reader the
   current call was given. That reader is the disk for the program and the
   overlay-first reader for `createLinter()`, so an overlay is never bypassed.
6. **TS-6.** The catalog's actions listing `typescript` and the binding's
   `action(...)` registrations are the same set, checked by a test.

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
| `bddSuite.lintTool` | string | `go` (provisional, B2.5); `typescript` from B9.3 if its measurement meets O10 | Binding whose code lints |
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
| `powershell` | `scripts/e2e/actions/*.ps1` | `**/*.Tests.ps1` | `Register-LabAction\s+-Name\s+'(?<name>[^'$]+)'`; `Register-LabAction\s+-Name\s+"(?<name>[^"$]+)"`; `@\{\s*name\s*=\s*'(?<name>[^']+)';\s*verb\s*=\s*'lifecycle\.` with `prefix: lifecycle.` (the five actions `lab-lifecycle.ps1` registers in a loop; B1.4) | `kind: powershell` | none |
| `go` | `test/e2e/bindings/go/internal/**/*.go` | `**/*_test.go` | `^\s*"(?<name>[a-z][\w]*(?:\.[\w]+)+)"\s*:\s*(?<handler>[\w.]+)`; `append\(names,\s*"(?<name>[\w.]+)"\)` | `["${storage}/go/suiterun.exe"]` | `go build -o ${storage}/go/suiterun.exe ./cmd/suiterun` in `test/e2e/bindings/go` |
| `rust` | `test/e2e/bindings/rust/src/**/*.rs` | none | `map\.insert\(\s*"(?<name>[a-z]\w*(?:\.\w+)+)"\s*,\s*(?<handler>\w+)\s*\)`; `^\s*"(?<name>[a-z]\w*(?:\.\w+)+)"\s*=>\s*(?<handler>\w+)\(`; `names\.push\("(?<name>[^"]+)"\.to_string\(\)\)` | `["test/e2e/bindings/rust/target/debug/suiterun.exe"]` | `cargo build` in `test/e2e/bindings/rust` |
| `csharp` | `test/e2e/bindings/dotnet/Hci.E2E.Suite/**/*.cs` | none | `^\s*\[\s*"(?<name>[a-z]\w*(?:\.\w+)+)"\s*\]\s*=\s*(?<handler>.+?),?\s*$`; `names\.Add\("(?<name>[^"]+)"\)` | `["test/e2e/bindings/dotnet/artifacts/bin/Hci.E2E.Suite.Cli/Debug/net10.0/suiterun.exe"]` | `dotnet build Hci.E2E.Suite.sln` in `test/e2e/bindings/dotnet` |
| `typescript` | `test/e2e/bindings/typescript/src/**/*.ts` | `**/*.test.ts` | `\baction\(\s*'(?<name>[^']+)'\s*,\s*(?<handler>[\w.]+)\s*\)` | `["node", "test/e2e/bindings/typescript/dist/cli.js"]`, plus `library: "test/e2e/bindings/typescript/dist/index.js"` | `npm ci && npm run build` (shell, per 2.4) in `test/e2e/bindings/typescript` |

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

The TypeScript binding (B8), from `test/e2e/bindings/typescript/` in
`os-context`:

| Command | What it does |
| --- | --- |
| `npm ci` | install `yaml`, `ajv`, and the dev tools from the committed lock file |
| `npm run build` | `tsc -p .` to `dist/` (ES2023, `module: NodeNext`, `strict`, declarations on) |
| `npm test` | `npm run build`, then `c8 --check-coverage --lines 100 --reporter=text --reporter=json-summary node --test dist-test/`, then `node scripts/check-branches.mjs`, which reads `coverage/coverage-summary.json` and fails unless `dist/expr.js` and `dist/assertion.js` are at 100 percent of branches |
| `node dist/cli.js lint --path 'test/e2e/suites/*.yml' --json` | the shared contract, from the repository root |
| `pwsh -File test/e2e/conformance/Assert-DivergenceIsCaught.ps1 -Binding typescript` | the divergence check against this binding (B8.8) |

Node.js: 24 (the development host has 24.16.0; Node 24 is the current LTS
line). `engines.node: ">=24"`. CI uses `actions/setup-node` pinned by commit
SHA like every other action in `os-context`'s workflows, with
`node-version: 24` and `cache: npm` keyed on the package's lock file.

### 3.2 Preparing `os-context` for the integration suite

Once per `os-context` commit under test, from `OS_CONTEXT_ROOT`:

1. `cargo build` in `test/e2e/bindings/rust` (run from that directory so its
   `.cargo/config.toml`, if any, applies).
2. `go build -o <storage>/go/suiterun.exe ./cmd/suiterun` in
   `test/e2e/bindings/go`, where `<storage>` is the test instance's global
   storage path, which `runTest.ts` prints and fixes with `--user-data-dir`.
3. `dotnet build Hci.E2E.Suite.sln` in `test/e2e/bindings/dotnet`.
4. `npm ci` and `npm run build` in `test/e2e/bindings/typescript` (once B8.1
   exists; before that, scenarios run with four bindings and leave the
   TypeScript half open).
5. Record `git -C $OS_CONTEXT_ROOT rev-parse HEAD`; the harness writes it into
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
* `src/lint`: `workerHost.ts` at 100 percent under unit tests that drive a real
  `Worker` running a test library (`test/fake-library/index.mjs`, which can be
  told to answer, throw, loop or report a different `apiVersion`).
  `worker.ts` runs only inside a worker thread, which `c8` does measure when
  `NODE_V8_COVERAGE` is inherited; B9.1 records whether it reached 100 percent
  that way, or names the lines.
* The TypeScript binding follows `os-context`'s rule for new binding files:
  100 percent of measured lines for every file under
  `test/e2e/bindings/typescript/src/`, and 100 percent of branches for
  `expr.ts` and `assertion.ts` (the two places "where four implementations
  diverge quietly"), with any exclusion listed in `package.json`'s `c8` block
  and justified at the step that adds it.
* A step that cannot reach 100 percent names the exact lines and why in its
  Unit field.

### 3.4 Local verification discipline

Adapted from the repository guideline: stabilise and verify locally, then run
the remote scenario once; rerun only what a change affects.

* Focused unit tests while editing; the whole unit suite and the step's
  integration scenario before ticking the step.
* Never re-run a green suite whose inputs did not change.
* Every mock is listed with what it replaces:
  - the fake tool replaces a binding program in process-handling unit tests;
  - the fake library replaces the TypeScript library in worker-host unit
    tests;
  - in B8.7, a loopback HTTP server stands in for the lifecycle API. It cannot
    prove the real API's behaviour; that is what E-B13 is for.

  Every editor scenario uses real programs, the real library, a real VS Code
  and the real checkout.
* Two scenarios need a lab: E-B13 (the binding, in B8.7) and E-B10 (the
  extension, in B7.3). E-B13 submits a bootstrap, so by the rule for
  mutating scenarios it runs in its build step, B8.7, not in a later batch. It
  runs once, after the binding's whole offline corpus is green on the same
  commit. E-B10 runs once, on the packaged `.vsix`, after all local scenarios
  are green on that same `.vsix`.
* **Start the long pole first.** The lab runs and the `os-context` CI job
  have lead time; local suites do not. Once B8.7's loopback tests are green,
  book the lab and run E-B13 at once, while B8.8 and B9 are built. Once B8.8's workflow edits are
  pushed by the user, the CI job runs while B9 is built.

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
| [B1](#stage-b1-navigation-and-hover-over-one-index) | Navigation and hover over one index | P0 | none | 7 | 7 of 7 | 7 of 7 (B1.4 TypeScript half and B1.7 E-B7 timing half deferred by name) |
| [B2](#stage-b2-lint-diagnostics-from-a-binding-program) | Lint diagnostics from a binding program | P0 | B1.1, B1.3 | 6 | 0 of 6 | 0 of 6 |
| [B3](#stage-b3-completion-that-knows-the-scope) | Completion that knows the scope | P1 | B1.2, B1.3, B1.6 | 5 | 0 of 5 | 0 of 5 |
| [B4](#stage-b4-the-binding-table-and-drift) | The binding table and drift | P1 | B1.4, B2.1 | 3 | 0 of 3 | 0 of 3 |
| [B5](#stage-b5-declaring-and-implementing-an-action) | Declaring and implementing an action | P1 | B1.2, B1.4, B2.1; B5.5 also B8.5 | 5 | 0 of 5 | 0 of 5 |
| [B6](#stage-b6-running-suites-from-test-explorer) | Running suites from Test Explorer | P2 | B1.3, B2.1 | 5 | 0 of 5 | 0 of 5 |
| [B8](#stage-b8-the-typescript-binding-in-os-context) | The TypeScript binding, in `os-context` | P1 | none in this repository; `os-context` at a recorded commit | 8 | 0 of 8 | 0 of 8 |
| [B9](#stage-b9-lint-while-typing-through-the-typescript-binding) | Lint while typing through the TypeScript binding | P1 | B2.2, B2.6, B8.4 | 3 | 0 of 3 | 0 of 3 |
| [B7](#stage-b7-package-and-accept) | Package and accept | P0 | all above | 3 | 0 of 3 | 0 of 3 |

Priority says what ships first, never what may be skipped: P0 is the minimum
useful release (navigate, hover, lint), P1 the authoring features and the
fifth binding, P2 running. A stage at any priority is done only against its
full criteria.

**Delivery order and parallel work.** B8 depends on nothing in this
repository and can be built alongside B1 to B6, by another person if there is
one. Inside B8 the order is strict (8.1 to 8.8). B9 starts when B8.4 has
shipped `createLinter()`; it does not need the binding's executor.
Every scenario that names five bindings runs with four until B8 finishes,
and its TypeScript half stays open until then. B7 is last and needs all of it.

**Scenario to step index.** Read from the step status blocks.

| Scenario | Signs off | Needs a lab | Status |
| --- | --- | --- | --- |
| [E-B1](design.md#e-b1-the-editor-shows-exactly-what-the-corpus-says-lint-must-find) | B2.1, B2.2, B2.5, B9.3 | no | not run |
| [E-B2](design.md#e-b2-a-step-the-target-binding-cannot-run-is-marked-and-says-who-can) | B1.2, B2.3, B3.1 | no | hover half passed 2026-10-14; the rest open (B2.3, B3.1) |
| [E-B3](design.md#e-b3-go-to-definition-on-an-action-lists-the-catalog-entry-and-every-registration) | B1.3, B1.4, B1.6 | no | four-binding half passed 2026-10-14; TypeScript half open (B8.5, B8.7) |
| [E-B4](design.md#e-b4-a-registration-site-shows-and-lists-the-steps-that-use-it) | B1.5 | no | passed 2026-10-14 |
| [E-B5](design.md#e-b5-completion-offers-what-is-in-scope-and-nothing-the-format-forbids) | B3.1-B3.5 | no | not run |
| [E-B6](design.md#e-b6-a-new-action-is-declared-and-implemented-in-every-binding-from-the-editor) | B5.1-B5.5 | no | not run |
| [E-B7](design.md#e-b7-the-binding-table-matches-the-catalog-and-the-binaries-and-drift-appears-when-introduced) | B4.1-B4.3, B1.4 | no | not run |
| [E-B8](design.md#e-b8-a-catalog-change-is-picked-up-without-a-reload) | B1.2, B1.7, B3.4 | no | hover half passed 2026-10-14; completion half open (B3.4) |
| [E-B9](design.md#e-b9-an-offline-suite-runs-under-each-binding-and-each-case-shows-the-corpus-result) | B6.1-B6.3, B6.5 | no | not run |
| [E-B10](design.md#e-b10-the-portable-stage-0-cases-run-from-the-editor-against-a-real-lab) | B6.4 | yes | not run |
| [E-B11](design.md#e-b11-a-missing-slow-or-broken-lint-tool-is-reported-not-hidden) | B2.4, B9.1 | no | not run |
| [E-B12](design.md#e-b12-the-typescript-binding-passes-the-whole-conformance-corpus) | B8.1-B8.6, B8.8 | no | not run |
| [E-B13](design.md#e-b13-the-typescript-binding-runs-the-portable-stage-0-cases-on-a-lab-with-the-same-report-as-go) | B8.7, B8.8 | yes | not run |
| [E-B14](design.md#e-b14-an-unsaved-buffer-gets-the-same-diagnostics-the-saved-file-would) | B9.1-B9.3 | no | not run |
| [E-B15](design.md#e-b15-in-an-untrusted-workspace-no-binding-code-runs) | B2.6 | no | not run |

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
the catalog and every binding's registration site; references and CodeLens go back;
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

- [x] B1.1 Extension skeleton that activates on a catalog and finds the root
- [x] B1.2 Catalog parsed with positions, and hover on an action
- [x] B1.3 Suites indexed with positions, and Go to Definition to the catalog
- [x] B1.4 Registration sites found by recognizers, and Go to Definition to every binding
- [x] B1.5 References and CodeLens from registration sites and catalog entries
- [x] B1.6 Meta step uses resolved to definitions across imports
- [x] B1.7 Watchers and debounced re-index keep everything current

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
* **Status.** Done 2026-10-14.
  - [x] code. `package.json`, `src/extension.ts`, `src/limits.ts`, `src/config/{defaults,layout,packageConfig}.ts`, `scripts/sync-defaults.mjs`, the integration harness.
  - [x] unit tests green at 100 percent of `src/config`: `layout.test.ts`, `boundaries.test.ts` (INV-9), and the package.json/defaults equality test.
  - [x] scenario. `activation.test.ts` (B1.1-1) and `inert.test.ts` (B1.1-2, which also asserts the extension does not activate on its own) in a real VS Code. Evidence: [docs/evidence/stage-b1.md](evidence/stage-b1.md).
  - Departures: `activate()` returns a test API (log, indexers, provider count, `ready`); `fileKey()` lives in `src/core/paths.ts` so core can use it; settings are read with `inspect()` so a wrong-typed value at any level is caught; `packageConfig.ts` is the generator `sync-defaults.mjs` calls, so the equality is a unit test rather than a script run.

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
    list every binding other than PowerShell, with no errors (the numbers read from the file by the
    test, not typed in).
  - B1.2-2 Every action's `nameRange` starts at the action name's text.
  - B1.2-3 A capture shape with `additionalProperties: true` is `open`; one
    without is closed and lists its properties.
  - B1.2-4 Hover on `lifecycle.get` names every binding its catalog entry lists as implementing; on
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
* **Status.** Done 2026-10-14.
  - [x] code. `src/core/{types,text,yamlPositions,catalog,workspaceIndex,hoverText}.ts`, `src/features/hover.ts`.
  - [x] unit tests green at 100 percent: `catalog.test.ts`, including B1.2-1 on the real catalog (100 actions, 24 listing every binding, no errors).
  - [x] scenario. The hover half of E-B2 (`hover.test.ts`: `cluster.state` PowerShell only) and B1.2-4 (`lifecycle.get` names its four bindings with links); the hover half of E-B8 passed with B1.7. Evidence: [docs/evidence/stage-b1.md](evidence/stage-b1.md).
  - Departures: a catalog that is not YAML is `BDD022` (the plan named only BDD020/BDD021) and keeps the previous catalog, marked stale; the hover markdown is built by the pure `src/core/hoverText.ts` so it is unit-tested; hover answers from the index (B1.3 was built in the same pass, so the line-local stopgap was never needed).

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
* **Status.** Done 2026-10-14.
  - [x] code. `src/core/suites.ts`, `src/features/indexer.ts` (initial scan), `src/features/navigation.ts`, `test/integration/harness/oracle.ts`.
  - [x] unit tests green at 100 percent: `suites.test.ts`, including B1.3-1 on the real tree (137 files, 2520 action steps equal to the oracle) and the item 6 measurement: `lifecycle-stage1.yml` parses in p50 9.3 ms, max 10.1 ms, under `INDEX_DEBOUNCE_MS`, so B1.7 debounces per edit as planned.
  - [x] scenario. The catalog half of E-B3 and B1.3-1 inside VS Code (`navigation.test.ts`). Evidence: [docs/evidence/stage-b1.md](evidence/stage-b1.md).
  - Departures: `SuiteFile.hasSuiteKey` replaces `isLibrary`; the index decides "library" from every parsed file's imports (`isSuiteOrLibrary`). A `forStep` mapping is indexed as its own step with its parent's home, because `wait` nests a full step there. `StepHome` hooks include `cleanup`. The indexer was created here, not in B1.7, because the initial scan needs it.

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
  6. The `typescript` recognizer is written now, against the registration shape
     DEC-B16 fixes, and tested on fixtures. On the real tree it finds nothing
     until B8.5, which is correct, because the catalog declares nothing for
     `typescript` until then. B1.4-1 is re-run for `typescript` at B8.5 and B8.7.
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
* **Status.** Done 2026-10-14 for the four existing bindings; the TypeScript half is named below.
  - [x] code. `src/core/registrations.ts`, the default recognizers in `src/config/defaults.ts` (corrected, see item 5), definitions and hover links.
  - [x] unit tests green at 100 percent: `registrations.test.ts`, one fixture per recognizer with near-misses, comments and `wait`; B1.4-1 on the real tree: PowerShell 100/100, C# 24/24, Go 24/24, Rust 24/24, one site each, no other names.
  - [x] scenario, four bindings. E-B3 except its meta half: `lifecycle.get` gives exactly the catalog and four registrations, `cluster.state` the catalog and PowerShell, `wait` the catalog and four `wait` lines. Evidence: [docs/evidence/stage-b1.md](evidence/stage-b1.md).
  - [-] scenario, TypeScript half: the `action('lifecycle.get', get)` location is closed by B8.5 (core and `wait`) and B8.7 (lifecycle), which re-run B1.4-1 and E-B3.
  - Item 5 record. The first run of the defaults against `os-context` `1d0f0e40` found 6 PowerShell, 22 C# and 28 Rust problems, all recognizer defects and no real drift: the PowerShell loop in `lab-lifecycle.ps1` (names built at run time), C# handlers with commas and JSON indexers, Rust assertion-operator arms. Fixed by excluding `$` from PowerShell names, a loop-table recognizer, dotted names for C# and Rust, and a C# handler of `.+?`; the 2.8 table is corrected. The second run found none.
  - Departure: recognizers take an optional `prefix` (prepended to the captured name), and an invalid regular expression is `BDD041` (a missing name group stays `BDD040`).

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
* **Status.** Done 2026-10-14.
  - [x] code. Reference and CodeLens providers in `src/features/navigation.ts`.
  - [x] unit tests green: `workspaceIndex.test.ts` covers `stepsUsing` with meta and library steps, ordering, removal and staleness, at 100 percent.
  - [x] scenario. E-B4 (`references.test.ts`): the Go site, the catalog entry and a step give the same 265 references for `lifecycle.get`, equal to the independent oracle, and the lens reads "265 suite steps"; a site no suite uses reads "no suite steps". Evidence: [docs/evidence/stage-b1.md](evidence/stage-b1.md).

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
* **Status.** Done 2026-10-14.
  - [x] code. `visibleMetaSteps`, `metaTargetOf`, `metaDefinitionAt`, `metaUses` in `src/core/workspaceIndex.ts`; definitions and references in `navigation.ts`.
  - [x] unit tests green at 100 percent: `meta.test.ts` (local, imported, two levels, shadowing, cycle, depth limit, missing).
  - [x] scenario. The meta half of E-B3: `meta: select-lab` in `lifecycle-stage0.yml` resolves to `_lib/lifecycle.yml`; references on the definition list stage 0's uses. Evidence: [docs/evidence/stage-b1.md](evidence/stage-b1.md).

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
* **Status.** Done 2026-10-14 for its own scenarios; the E-B7 timing half is named below.
  - [x] code. Watchers, buffer debounce, close-unsaved re-read and configuration rebuild in `src/features/indexer.ts` and `src/extension.ts`; `src/core/debounce.ts`.
  - [x] unit tests green at 100 percent: `debounce.test.ts` with a clock scoped to each test; B1.7-3 in `workspaceIndex.test.ts` (50 updates, one join rebuild).
  - [x] scenario. In a fresh worktree (`watch.test.ts`): the hover half of E-B8 (a catalog save showed the new parameter in hover after 100 ms, no reload, B1.7-1); a new Go registration was a definition target 72 ms after save (B1.7-2); an unsaved edit is indexed after the debounce; a created suite is indexed and a deleted one leaves; a settings change rebuilds and reports `BDD010`. Evidence: [docs/evidence/stage-b1.md](evidence/stage-b1.md).
  - [-] the timing half of E-B7 is closed by B4.2, and the completion half of E-B8 by B3.4.

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
B2.5 measures latency, which needs all four program tools wired (the TypeScript in-editor tool is measured in B9.3).

**Checklist.**

- [ ] B2.1 Tool runner and per-binding command profiles
- [ ] B2.2 Lint on open and save, mapped to editor ranges
- [ ] B2.3 Target binding: `--binding-check` and per-step binding badges
- [ ] B2.4 Failure states: missing, slow, broken and oversized tools
- [ ] B2.5 Lint latency measured for all four tools, and the default chosen
- [ ] B2.6 Workspace trust gates every process and every library load

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
     abbreviations `PS`, `C#`, `Go`, `Rs`, `TS` for the five defaults (a binding
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

### B2.6 Workspace trust gates every process and every library load

* **Deliverable.** In an untrusted folder the extension navigates, hovers and
  completes, but starts no process and loads no workspace code, and says so in
  the status bar. Trusting the folder turns lint and run on without a reload.
* **Why its own step.** It is a cross-cutting gate. If it lands before the
  in-editor library (B9), no path that loads workspace code ever exists
  without it.
* **Implementation.**
  1. `package.json`: `capabilities.untrustedWorkspaces: { supported:
     "limited", description: "Lint, run, build and schema generation run code
     from the folder and are disabled until it is trusted.",
     restrictedConfigurations: ["bddSuite.bindings", "bddSuite.schemaGenerator",
     "bddSuite.lintTool"] }`. Restricting these settings stops an untrusted
     folder's own `.vscode/settings.json` from choosing what runs once it is
     trusted later.
  2. `src/config/trust.ts`: `canRunWorkspaceCode(): boolean` returns
     `vscode.workspace.isTrusted`; `onTrustChanged` wraps
     `workspace.onDidGrantWorkspaceTrust`.
  3. `runTool()` takes a `gate: () => boolean` parameter, bound to
     `canRunWorkspaceCode` in `extension.ts`, and returns
     `{ kind: 'failure', reason: 'untrusted' }` without spawning when it is
     false. `LintWorkerHost.start()` (B9.1) takes the same gate. Both check it
     themselves (INV-11).
  4. The status bar item shows `Suite: untrusted, lint and run disabled`.
     On trust granted, re-lint open suites.
* **Contracts.**
  - B2.6-1 With the gate false, `runTool()` never calls `spawn` (unit test with
    an injected spawn that fails the test if called).
  - B2.6-2 Navigation, hover and completion answer in an untrusted window.
  - B2.6-3 Granting trust lints open suites without a reload.
* **Files.** *new*: `src/config/trust.ts`,
  `test/integration/suite/trust.test.ts`; *edit*: `package.json`,
  `src/tools/runTool.ts`, `src/features/statusBar.ts`, `src/extension.ts`.
* **Unit.** B2.6-1 in `runTool.test.ts`. 100 percent of `trust.ts`.
* **E2E.** [E-B15](design.md#e-b15-in-an-untrusted-workspace-no-binding-code-runs),
  the program half; its worker half is re-run at B9.1.
* **Depends on.** B2.1.
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
entry, PowerShell registration, regenerated schema) and implement it in Go,
Rust, C# or TypeScript (registry entry, stub handler, catalog `bindings`
updated, regenerated schema).

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
| TypeScript, `lifecycle.*` | before the closing `];` of `export const lifecycleActions: readonly Registration[] = [` in `src/lifecycle/actions.ts` | end of file |
| TypeScript, other | before the closing `];` of `export const coreActions: readonly Registration[] = [` in `src/actions/core.ts` | end of file |

Names: Go and TypeScript `camelCase` of the segments after the family
(`demo.echo` -> `demoEcho`); Rust `snake_case` (`demo_echo`); C# and
PowerShell file names `PascalCase` (`DemoEcho`).

**Step order and why.** Declaring comes first because implementing requires a
declared action. Go, Rust, C# and TypeScript are each their own step because
each is one compile that proves it, independently useful, with its own
template. TypeScript is last because its registries exist only from B8.5.

**Checklist.**

- [ ] B5.1 Declare an action: catalog entry, PowerShell registration, schema
- [ ] B5.2 Implement in Go
- [ ] B5.3 Implement in Rust
- [ ] B5.4 Implement in C#
- [ ] B5.5 Implement in TypeScript

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
  [E-B6](design.md#e-b6-a-new-action-is-declared-and-implemented-in-every-binding-from-the-editor),
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
  [E-B6](design.md#e-b6-a-new-action-is-declared-and-implemented-in-every-binding-from-the-editor).
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
  [E-B6](design.md#e-b6-a-new-action-is-declared-and-implemented-in-every-binding-from-the-editor).
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
  [E-B6](design.md#e-b6-a-new-action-is-declared-and-implemented-in-every-binding-from-the-editor).
* **Depends on.** B5.1.
* **Status.** [ ] code [ ] unit [ ] scenario

### B5.5 Implement in TypeScript

* **Deliverable.** As B5.2 for TypeScript: an `action('<name>', <handler>),`
  entry in `coreActions` or `lifecycleActions`, and a stub handler that throws
  `failed(...)`. The command adds `typescript` to the action's catalog
  `bindings`, so TS-6 still holds.
* **Why its own step.** As B5.2. It is last because the registries it writes
  into exist only from B8.5.
* **Implementation.**
  1. `templates/typescript.core.tmpl`:
     `function {{tsName}}(request: Request): Promise<Value> {\n  throw failed('{{action}}: not implemented in the TypeScript binding yet');\n}`
     and entry `  action('{{action}}', {{tsName}}),`.
     `templates/typescript.lifecycle.tmpl`: the same with the lifecycle
     handler signature `(context: LifecycleContext, request: Request)`, read
     from `src/lifecycle/actions.ts` at the commit under test and recorded
     here before the template is written.
  2. Indentation from the anchor line; the stub function goes at the end of
     the file. The package has no formatter, so the template is written
     already formatted. `tsc` with `noUnusedParameters` is not enabled in the
     package (B8.1 decides that and records it), and the template names
     `request` so it compiles either way.
* **Contracts.**
  - B5.5-1 `npm run build` and `npm test` succeed in the package, including
    TS-6's catalog/registry test.
  - B5.5-2 and B5.5-3 as B5.2-2 and B5.2-3 for TypeScript.
* **Files.** *new*: `templates/typescript.core.tmpl`,
  `templates/typescript.lifecycle.tmpl`; *edit*: `src/core/stubs.ts`.
* **Unit.** As B5.2, on fixture copies of both TypeScript files.
* **E2E.** The TypeScript part of
  [E-B6](design.md#e-b6-a-new-action-is-declared-and-implemented-in-every-binding-from-the-editor);
  E-B6 is complete when B5.1-B5.5 have each passed their part.
* **Depends on.** B5.1, B8.5 (the registries) and B8.7 (for the lifecycle
  template).
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
    corpus files of E-B9, under all five bindings (four until B8.6 lands).
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

## Stage B8: the TypeScript binding, in `os-context`

Built in `os-context`. Paths in this stage are `os-context` paths.

**Entry state.** Measured on 2026-10-14:

* The four bindings exist. Go is the model: 8,620 lines of source and 5,048 of
  tests in 54 files, packages listed in [2.1](#21-components-and-where-they-live).
* The corpus lists 48 validate entries, 11 execute entries, a 276-row
  expression table, a 96-row assertion table and 7 stored reports.
* The catalog has 100 actions; 24 list `[powershell, csharp, go, rust]`.
* Three places refuse a fifth binding name, and others list four names (design
  [2.5](design.md#25-admitting-a-fifth-binding)).
* No workflow sets up Node.js. Node 24.16.0 and npm 11.13.0 are on the
  development host.
* Known defects in the other bindings that TypeScript must not copy are listed
  in design 2.5, DEC-B17 and DEC-B18.

**What it delivers.** O9: a fifth binding that passes the whole corpus, runs
the portable cases on a lab with the same report as Go, and is wired into the
conformance and lab workflows. It also delivers the one extra the extension
needs, `createLinter()` with overlays (DEC-B20). It is worth shipping on its
own: it is a fifth check on the corpus, and the stream-retry window
(DEC-B18) is the first binding outside PowerShell to have it.

**How it is built.**

```
 lint:  cli.parse -> run.lintVerb -> paths.repositoryRoot -> schema.loadSchema (suite.schema.json + catalog, at run time)
          for each file: validate.validateFile(reader)
             model.loadDocument  (yaml parseDocument + LineCounter, intAsBigInt; pointer -> {key, value} positions)
             structure.checkStructure  (ajv/dist/2020 on value.toPlain(); stepEnvelope pass, then one branch per step)
             validate imports  ->  semantics.checkSemantics  ->  dataflow.checkDataflow
          diag.sorted (file, line, column, code, message; adjacent duplicates dropped) -> --json | human
 run:   suite.expand (imports depth-first, meta steps to depth 5, tables, outlines, and-keywords, params, vars)
          exec.runFile: suite setup -> per case [beforeEach, setup, steps (+ own asserts), asserts, cleanup, afterEach] -> teardown
             each action: handler(request) with request.signal = AbortSignal.any([caseSignal, AbortSignal.timeout(stepLimitMs)])
          trace.Trace -> --trace-file ; report.nunit3|junit -> --results
 library: index.createLinter({ root }) -> linter.lint({ paths, binding, bindingCheck, strict, overlays }) = the lint path with an overlay-first reader
```

Construction decisions that hold across the stage:

* **One reader.** Every file access goes through a `Reader` the call was
  given: `diskReader` for the program, `overlayReader(overlays)` for
  `createLinter()` (TS-5). The lint path is synchronous; the run path is
  `async`, because actions are.
* **Typed values from the first byte** (TS-1, TS-2). `loadDocument` uses
  `parseDocument(text, { intAsBigInt: true, keepSourceTokens: true,
  lineCounter })` and converts YAML maps to `Map`. `value.toPlain()` makes the
  JSON-compatible copy Ajv needs (`bigint` to `number`, `Map` to object),
  used only for structural validation, as Go's `model.Plain` is.
* **Positions.** `positions: Map<pointer, { key?: Pos; value: Pos }>` with
  one-based line and column, from `lineCounter.linePos(offset)`. `E100` is
  always 1:1. A container's position follows Go's rule from Y4.2: the earlier
  of its own mark and its first child's, and an empty sequence entry is
  reported at its dash.
* **No binding is copied.** Each module is written from the design, the corpus
  and the catalog, with Go read for comparison, never translated line by
  line. That is how the earlier bindings found each other's defects.
* **Each step closes on its corpus family.** Every step from B8.2 to B8.7 ends
  with a named slice of the corpus green, so the binding is never "mostly
  conformant".

**Step order and why.** The package and the name admission come first
(B8.1): nothing else can be tested or committed without them. Structure
(B8.2) comes next, because it fixes the value model and positions everything
else uses. Expressions and assertions (B8.3) come before semantics and dataflow
(B8.4), because dataflow's `E305`-`E309` parse every `${...}` with B8.3's
parser, and B8.3 is proved by its own two tables without needing a validator.
Each is signable alone. The executor (B8.5) needs evaluation and a validated
document. Reports (B8.6) need the executor. Lifecycle actions (B8.7) need the
executor and are the only step with a lab. CI and documentation (B8.8) come
last, so the workflow job is green on its first run. B9 needs only B8.4.

**Checklist.**

- [ ] B8.1 The package, the command-line contract, and the name admitted
- [ ] B8.2 YAML with positions and structural validation (`E100`-`E105`)
- [ ] B8.3 The expression evaluator and the assertion comparer
- [ ] B8.4 Semantic and dataflow validation, `lint` complete, and `createLinter()`
- [ ] B8.5 Expansion, the execution core, the core actions and `wait`
- [ ] B8.6 NUnit 3 and JUnit reports
- [ ] B8.7 The 18 lifecycle actions over HTTP and SSE
- [ ] B8.8 CI, the lab workflow, the divergence check and the documentation

### B8.1 The package, the command-line contract, and the name admitted

* **Deliverable.** `node test/e2e/bindings/typescript/dist/cli.js` accepts the
  four verbs and their flags exactly as `suiterun` does, refuses anything else
  with exit 2, and `actions --json` prints `[]`. `os-context` accepts the name
  `typescript` everywhere it validates binding names.
* **Why its own step.** The admission edits touch shared files and run
  `os-context`'s gates. Landing them with nothing else makes a failure easy to
  attribute, and every later step needs the package.
* **Implementation.**
  1. `test/e2e/bindings/typescript/package.json` as in
     [2.1](#21-components-and-where-they-live): dependencies `yaml@^2`,
     `ajv@^8`; devDependencies `typescript@~5.9`, `@types/node@^24`, `c8`.
     Run `npm install` once to write `package-lock.json`, and commit it (the
     dashboard commits its lock file; Rust's is ignored, so record which rule
     this follows and why: reproducible CI).
  2. `tsconfig.json`: `target: ES2023`, `module: NodeNext`,
     `moduleResolution: NodeNext`, `strict: true`, `noUncheckedIndexedAccess:
     true`, `declaration: true`, `outDir: dist`, `rootDir: src`;
     `tsconfig.test.json` building `test/` to `dist-test/`.
     `noUnusedParameters` stays off (B5.5 relies on it).
  3. `.gitignore` in the package: `node_modules/`, `dist/`, `dist-test/`,
     `coverage/`. The root `.gitignore` does not ignore `node_modules`.
  4. `src/cli.ts`: `parse(argv)` by hand, as Go's `internal/cli` does, so an
     unknown flag is exit 2 rather than a library's guess. It accepts the flags
     of DEC-Y14 plus `--schema-root`, and defaults `binding` to `typescript`.
     `main()` maps `Report.code` to `process.exitCode`, never calls
     `process.exit()` while output is pending, and writes stdout with one
     `write` per document.
  5. `src/paths.ts`: `repositoryRoot(start)` walks up to `test/e2e/schema`;
     `resolveGlob(pattern, cwd)` supports `*` and `?` only, as Go's
     `paths.Resolve` does.
  6. `src/run.ts`: the four verbs; in this step `lint`, `run` and `list`
     return exit 2 "not implemented yet", and `actions` returns `[]`.
  7. Admission, in `os-context`:
     - `test/e2e/schema/actions.catalog.schema.json` lines 16 and 41: add
       `"typescript"` to both enums, and reword line 12's description, which
       today calls a fifth name a typo.
     - `scripts/e2e/SuiteLint.psm1` line 2118: add `'typescript'` to the
       `ValidateSet`.
     - `test/e2e/conformance/expectation.schema.json` line 39: set the enum to
       `["powershell", "csharp", "go", "rust", "typescript"]`, which also
       fixes the stale `python` and the missing `csharp`.
     - `test/e2e/schema/actions.catalog.yaml` line 22: top-level
       `bindings: [powershell, csharp, go, rust, typescript]`; no action entry
       changes (DEC-B21). Then run `Build-Schema.ps1`.
  8. `test/conformance/manifest.test.ts`: every file the manifest names
     exists, and every file under `validate/` and `execute/` is an entry or
     support. These are the same two checks as Go's
     `TestEveryFileTheManifestNamesIsThere`.
* **Contracts.**
  - B8.1-1 Each of the four verbs with each flag parses; an unknown flag, a
    missing value, a bad `--format` and a `--param` without `=` each exit 2
    with the usage text. These are Go's `cli_test.go` cases, read for
    coverage, not copied.
  - B8.1-2 `actions --json` prints `[]` and exits 0.
  - B8.1-3 `SuiteLint.Tests.ps1`, `Conformance.Tests.ps1`, `Schema.Tests.ps1`
    and `Build-Schema.ps1 -Check` pass after the admission edits.
* **Constraints.** ASCII only in every file (`os-context` rule).
* **Files.** *new*: `test/e2e/bindings/typescript/{package.json,
  package-lock.json, tsconfig.json, tsconfig.test.json, .gitignore,
  src/cli.ts, src/run.ts, src/paths.ts, test/unit/cli.test.ts,
  test/unit/paths.test.ts, test/conformance/manifest.test.ts}`; *edit*:
  `actions.catalog.schema.json`, `SuiteLint.psm1`, `expectation.schema.json`,
  `actions.catalog.yaml`, `suite.schema.json`, `suite.schema.md`
  (regenerated).
* **Unit.** As B8.1-1 and B8.1-2; 100 percent of lines of `cli.ts` and
  `paths.ts`.
* **E2E.** The command-line half of
  [E-B12](design.md#e-b12-the-typescript-binding-passes-the-whole-conformance-corpus).
* **Depends on.** Nothing.
* **Status.** [ ] code [ ] unit [ ] scenario

### B8.2 YAML with positions and structural validation (`E100`-`E105`)

* **Deliverable.** `lint --json` reports every `E100`-`E105` finding at the
  position the corpus expects.
* **Why its own step.** Structural validation is the largest single source of
  position disagreements between bindings (`E100`, containers, false
  schemas). It is closed against its own slice of the corpus before semantics
  adds its own.
* **Implementation.**
  1. `src/value.ts`: the `Value` union; `text(v)` (canonical text: no `.0` on
     a whole float, lowercase booleans, `null` is `""`), `asNumber(v)`,
     `toPlain(v)`, `toJson(v)` (writes `bigint` as a JSON integer).
  2. `src/model.ts`: `loadDocument(text)` per the stage construction
     decisions. A `yaml` parse error, or any exception from the parser, is
     `E100` at 1:1. A root that is not a mapping is `E100` at 1:1. Aliases
     become `null`, as in Go.
  3. `src/schema.ts`: `loadSchema(schemaRoot, overlay?)` reads
     `suite.schema.json` and the catalog through the reader. It replaces
     `$defs.step` with `$defs.stepEnvelope` for the whole-document pass, as
     Go's `schema.Load` does, and merges a corpus `catalogOverlay` by the
     manifest's rule (key replaces key; a `params` entry replaces the same
     name or is appended).
  4. `src/validate/structure.ts`: `checkStructure(doc, schema)`. First pass:
     Ajv 2020 (`allErrors: true`, `strict: false`) on the envelope schema.
     Second pass: one synthetic schema with `prefixItems` of
     `{ $ref: '#/$defs/step.<action>' }` per step (or `step.meta`). An unknown
     action is `E104` with `nearest()` at distance 3. A step with neither
     `action` nor `meta` is `E102`, and a non-mapping step entry is `E103`.
     Error mapping: `required` is `E102` at the key's position;
     `additionalProperties` and `false schema` are `E101`, or `E105` inside a
     step, with `nearest()` at distance 2 over the legal keys; anything else
     is `E103` at the value.
  5. `src/diag.ts`: `sorted()` (file, line, column, code, message; adjacent
     duplicates dropped, because common fields are checked by both passes),
     `fails(found, strict)`, `toJsonArray()`, and `relativePath()` with forward
     slashes.
  6. `test/conformance/validate.test.ts`, run in this step over the
     validate entries whose expectation holds only `E1xx` codes.
* **Contracts.**
  - B8.2-1 Every validate entry whose expectation holds only `E1xx` codes
    matches exactly. The test prints how many that is, and B8.4 raises it to
    all 48.
  - B8.2-2 `6 / 3` in YAML (a string) stays a string; `2` parses as
    `bigint`, `2.0` as `number`; a mapping with keys `"10"` and `"2"` keeps
    that order (TS-1, TS-2).
  - B8.2-3 A YAML file the parser throws on is `E100` at 1:1, never an
    unhandled exception.
* **Constraints.** TS-1, TS-2, TS-5.
* **Files.** *new*: `src/value.ts`, `src/model.ts`, `src/schema.ts`,
  `src/walk.ts`, `src/diag.ts`, `src/spelling.ts`,
  `src/validate/structure.ts`, `test/unit/{value,model,schema,diag,
  spelling,structure}.test.ts`, `test/conformance/validate.test.ts`.
* **Unit.** One test per error mapping, per position rule and per value kind;
  100 percent of lines of every new file.
* **E2E.** The `E1xx` slice of
  [E-B12](design.md#e-b12-the-typescript-binding-passes-the-whole-conformance-corpus).
* **Depends on.** B8.1.
* **Status.** [ ] code [ ] unit [ ] scenario

### B8.3 The expression evaluator and the assertion comparer

* **Deliverable.** Every row of `expressions/cases.yaml` (276) and of
  `asserts/cases.yaml` (96) gives the expected value and type, or result and
  code, with 100 percent branch coverage of both modules.
* **Why its own step.** These are "the two places where four implementations
  diverge quietly". They are proved by their own tables before any suite
  runs.
* **Implementation.**
  1. `src/expr.ts` tokenizer: identifiers, numbers (an integer literal is
     `bigint`, a literal with `.` is `number`), strings with `"` and `'`, the
     operators of `yml_suite_design.md` 5.9.
  2. Pratt parser for the grammar in 5.9 (ternary, `or`, `and`, `not`,
     comparison, sum, product, unary, primary), producing an AST; `E305` with
     the offending token on leftover input.
  3. Evaluator.
     - Integer `+ - * %` stay `bigint`.
     - `/` gives a `bigint` when both are integers and the division is exact
       (`6 / 3` is `2`), and a `number` otherwise (`7 / 2` is `3.5`), which
       is the table's rule.
     - Any `number` operand makes the result a `number`.
     - Division by zero is `E307`.
     - A ternary evaluates only the selected branch, while both are checked.
  4. `FUNCTIONS`: the 21 names (`lower upper trim replace format split join
     startsWith endsWith contains len first last int float str bool default
     env uuid nowIso`), matched case-sensitively, with arity and argument
     types (`E306`, `E307`). `env`, `uuid` and `nowIso` are refused under a
     stable scope (`E309`). `str(true)` is `"true"`.
  5. `expand(template, scope)`: a string that is exactly one `${...}` keeps the
     value's type; otherwise each expression is substituted by `text()`, and
     a failing one reports its own code (design 6.4).
  6. Integer overflow: read what Go (`int64`), Rust and C# do at
     `9223372036854775807 + 1`, and whether a corpus row pins it. If one does,
     follow it. If none does and the three agree, follow them and propose the
     row to `os-context`. If they disagree, record the gap here and in
     `os-context`'s open questions, and make TypeScript refuse with `E307`
     "integer overflow" until the corpus decides. Wrapping silently is never
     the choice.
  7. `src/assertion.ts`: `compare(op, actual, expected, present)` for every
     operator in DEC-Y20 except `script` (`E201` outside PowerShell). Case
     rules as DEC-B16 item 3. `gt`/`gte`/`lt`/`lte` use `asNumber`, and a
     non-number fails with a type message. `isTrue` requires a boolean.
     `matches` runs `unportable(pattern)` first (`E308`), then
     `new RegExp(pattern, 'i')`. `unportable` refuses the same constructs as
     `SuiteLint.psm1`'s `$script:UnportablePatterns`. It also refuses an
     inline flag group (`(?i)`, `(?m)`, ...), which RE2 accepts and
     JavaScript's engine only partly does; record whether any suite in the
     tree uses one (if so, that is a corpus question, not a silent refusal).
  8. `test/conformance/{expressions,asserts}.test.ts`: every row. They fail if
     a function in `FUNCTIONS` is never called by the table, or an operator
     has no row (Go's checks).
* **Contracts.**
  - B8.3-1 All 276 expression rows and all 96 assertion rows match.
  - B8.3-2 `1.5 + 1.5` is type `float`, `6 / 3` is type `int`, `0.0` is type
    `float`.
  - B8.3-3 100 percent of branches of `expr.ts` and `assertion.ts`.
* **Constraints.** TS-2.
* **Files.** *new*: `src/expr.ts`, `src/assertion.ts`,
  `test/unit/{expr,assertion}.test.ts`,
  `test/conformance/{expressions,asserts}.test.ts`,
  `scripts/check-branches.mjs`.
* **Unit.** As above.
* **E2E.** The expression and assertion families of
  [E-B12](design.md#e-b12-the-typescript-binding-passes-the-whole-conformance-corpus).
* **Depends on.** B8.2.
* **Status.** [ ] code [ ] unit [ ] scenario

### B8.4 Semantic and dataflow validation, `lint` complete, and `createLinter()`

* **Deliverable.** `lint` gives exactly the expected diagnostics for all 48
  validate entries, with `--strict` and `--binding-check`. The library exports
  `createLinter()`, which gives the same answer when a file's text is handed
  in as an overlay.
* **Why its own step.** It completes the lint path, the half the extension
  needs first (B9 starts here), and it is the step that makes E-B12's validate
  family complete.
* **Implementation.**
  1. `src/validate/semantics.ts`: `E201` (with `bindingCheck`, against the
     action's catalog `bindings`), `E202`-`E214`, `W302`, `W304`, each written
     from `diagnostics.md` and the design's rules. Go's `semantics.go` is read
     only to compare positions. W304 does not count a `- meta:` use as an
     unlabelled step (design 6.4).
  2. `src/validate/dataflow.ts`: the case plan in run order (suite setup,
     beforeEach, case setup, steps, asserts, cleanup, afterEach), then
     `E301`-`E304`, `E306`, `E308`, `E309`, `W301`, `W303`. The context keys
     are `cluster`, `target`, `timeoutSec`, `labId`, `apiUrl`, `defaults`.
     Every `${...}` is parsed with B8.3's parser (no evaluation at lint time,
     except the `E309` stability check on `vars:`).
  3. Meta step exports used twice in one case: copy the behaviour all four
     bindings have today (`os-context` open question 4: exports recorded at
     the later use). Diverging would fail a corpus entry if one is added, and
     the fix belongs in all five at once. Record it in this step.
  4. `src/validate/index.ts`: `validateFile(path, reader, schema, options)`.
  5. `src/index.ts`: `apiVersion = '1.0.0'`; `createLinter({ root,
     schemaRoot? })` loads the schema once and returns `{ lint(request),
     invalidate() }`. `lint` builds `overlayReader(request.overlays)` and runs
     `validateFile` per path. It returns the sorted diagnostics as plain
     objects with exactly the fields of `diagnostic.schema.json`.
     `invalidate()` drops the cached schema and catalog.
  6. `test/conformance/validate.test.ts` now covers all 48 entries, honouring
     `params`, `binding`, `bindingCheck` and `catalogOverlay` from the
     manifest.
  7. `test/unit/linter.test.ts`: for each validate entry, `createLinter().lint()`
     with the entry's text as an overlay at a different path in the same
     directory gives the same codes and positions as linting the file itself.
* **Contracts.**
  - B8.4-1 All 48 validate entries match exactly (codes, severities, order,
    lines, columns, exit code).
  - B8.4-2 `createLinter().lint()` with an overlay never reads that path from
    disk (asserted with a reader that throws for it) (TS-5).
  - B8.4-3 `apiVersion` is `1.0.0`, and a change to `LintRequest` or
    `Diagnostic` that is not backward compatible changes the major.
* **Constraints.** TS-5.
* **Files.** *new*: `src/validate/semantics.ts`, `src/validate/dataflow.ts`,
  `src/validate/index.ts`, `src/index.ts`, `test/unit/linter.test.ts`,
  `test/unit/{semantics,dataflow}.test.ts`; *edit*: `src/run.ts`,
  `test/conformance/validate.test.ts`.
* **Unit.** As above; 100 percent of lines.
* **E2E.** The validate family of
  [E-B12](design.md#e-b12-the-typescript-binding-passes-the-whole-conformance-corpus).
* **Depends on.** B8.2, B8.3.
* **Status.** [ ] code [ ] unit [ ] scenario

### B8.5 Expansion, the execution core, the core actions and `wait`

* **Deliverable.** `run` executes all 11 execute entries with the expected
  trace and exit code. The five `core.*` actions and `wait` are registered,
  and the catalog lists `typescript` for those six.
* **Why its own step.** The executor is the second half of every binding and
  the part the corpus pins by trace. The six offline actions are what the
  execute corpus calls, so they land with it.
* **Implementation.**
  1. `src/suite.ts`:
     - `readLibraries` reads imports depth-first, a library's own imports
       first, and refuses a cycle by lowercased absolute path.
     - `metaDefinitions` puts local definitions over imported ones.
     - `expandSteps` expands meta uses to depth 5 (`default`s overlaid by
       `with`, passing `ifCapture` down), turns a table into one step per row
       (`__row`, `__rowIndex`, `__rowCount`, `__provenance`), and resolves the
       `and` keyword once.
     - `expandOutline` names each row `name [col=val, ...]`.
     - `resolveParams` applies, lowest first: library, file, case,
       `HCI_SUITE_PARAM_<NAME>`, then `--param`, last one wins.
     - `resolveVars`.
  2. `src/exec.ts`: `runFile(suite, options)` with the phase order and failure
     attribution of `yml_suite_design.md` 5.2. Limits:
     - `defaultCaseSec` 600, `defaultHookSec` 300, `defaultCleanupSec` 120,
       `lifecycleBudgetSec` 900;
     - each hook in its own window;
     - a step limit is `min(own, remaining)`;
     - each action call gets
       `AbortSignal.any([caseSignal, AbortSignal.timeout(ms)])` (TS-4).

     On expiry the step is "cancelled", or "abandoned" when the catalog says
     `interruptible: false`. The executor stops waiting either way, because a
     JavaScript promise cannot be killed.
  3. Scope per case: a clone of the suite capture bag, `param`, `row`,
     defaults flattened and under `defaults`, `timeoutSec`, and `labId` and
     `apiUrl` from the options. A unit test asserts both are readable (the
     Rust defect, design 6.4).
  4. `src/actions/registry.ts`: `type Registration = { name: string; handler:
     Handler }`; `action(name, handler): Registration`; `Request` (`step`,
     `signal`, `recordPath`, `runNested` for `wait`); `failed(message)`,
     `timedOut(message)`.
  5. `src/actions/core.ts`:
     `export const coreActions: readonly Registration[] = [ action('core.noop',
     noop), action('core.set', set), action('core.fail', fail),
     action('core.sleep', sleep), action('core.record', record),
     action('wait', wait), ];`, one entry per line (the recognizer and B5.5
     depend on that).
     - `core.sleep` honours `signal`.
     - `core.record` appends to `HCI_SUITE_RECORD_PATH`.
     - `wait`: `seconds` sleeps through `signal` (unlike Go's
       uncancellable `time.Sleep`; record the difference). `forStep` polls
       through `request.runNested` with `intervalSec` (default 10), its own
       `timeoutSec` (default 300) capped by the case deadline, and `until`.
  6. `src/trace.ts`: entries `{ phase, case?, step?, action?, status, reason? }`
     as in `expectation.schema.json`; `--trace-file` writes them.
  7. `test/conformance/execute.test.ts`: every execute entry with its
     `params`, `tags` and `maxSeconds`.
     `test/conformance/catalog.test.ts`: TS-6, the registered names against
     the catalog's `typescript` set.
  8. Catalog: add `typescript` to the `bindings:` of `core.noop`, `core.set`,
     `core.fail`, `core.sleep`, `core.record` and `wait` (DEC-B21), then run
     `Build-Schema.ps1`. Re-run the extension's B1.4-1 for `typescript`.
* **Contracts.**
  - B8.5-1 All 11 execute entries match their traces and exit codes, and
    `hung-step.yml` finishes inside its `maxSeconds`.
  - B8.5-2 TS-6 holds with six names.
  - B8.5-3 `labId` and `apiUrl` from the options are readable in a case.
* **Constraints.** TS-4; the limit constants above, named in `src/exec.ts`.
* **Files.** *new*: `src/suite.ts`, `src/exec.ts`, `src/trace.ts`,
  `src/actions/registry.ts`, `src/actions/core.ts`,
  `test/unit/{suite,exec,core}.test.ts`,
  `test/conformance/{execute,catalog}.test.ts`; *edit*: `src/run.ts`,
  `actions.catalog.yaml`, `suite.schema.json`, `suite.schema.md`.
* **Unit.** 100 percent of lines.
* **E2E.** The execute family of
  [E-B12](design.md#e-b12-the-typescript-binding-passes-the-whole-conformance-corpus).
* **Depends on.** B8.3, B8.4.
* **Status.** [ ] code [ ] unit [ ] scenario

### B8.6 NUnit 3 and JUnit reports

* **Deliverable.** `--results` writes NUnit 3 (default) or JUnit, and the 7
  stored reports canonicalise equal.
* **Why its own step.** The report is what CI publishes, its comparison has its
  own canonical form, and it is "the most mechanical part of the core"
  (DEC-Y15).
* **Implementation.**
  1. `src/report.ts`: `nunit3(results)` and `junit(results)`. These are
     hand-written XML with attribute and text escaping. They are named by the
     suite's declared `suite:`, carry no absolute paths and no stack traces
     (design 6.4), and pass all text through `redact()` (TS-3).
  2. `test/conformance/report.test.ts`: run each `reports.entries` suite and
     compare with the stored file after canonicalising per
     `report/canonicalise.md`. The canonicaliser lives in the test, as in Go
     and C#. It also checks three runs canonicalise identical.
* **Contracts.** B8.6-1 All 7 stored reports match; three runs are identical
  after canonicalisation.
* **Files.** *new*: `src/report.ts`, `test/unit/report.test.ts`,
  `test/conformance/report.test.ts`, `test/conformance/canonicalise.ts`;
  *edit*: `src/run.ts`.
* **Unit.** Escaping of `<`, `&`, `"`, control characters; 100 percent of lines.
* **E2E.** The report family of
  [E-B12](design.md#e-b12-the-typescript-binding-passes-the-whole-conformance-corpus);
  with B8.1-B8.5 this completes E-B12's local half.
* **Depends on.** B8.5.
* **Status.** [ ] code [ ] unit [ ] scenario

### B8.7 The 18 lifecycle actions over HTTP and SSE

* **Deliverable.** The 18 `lifecycle.*` actions behave as DEC-B17 and DEC-B18
  say, against a loopback server and against a real lab. The catalog lists
  `typescript` for all 24 portable actions.
* **Why its own step.** It is the only part of the binding that talks to a
  network and the only step with a lab scenario. It changes lab state (one
  bootstrap per run), so its scenario runs here, in its build step.
* **Implementation.**
  1. `src/lifecycle/context.ts`: `LifecycleContext`.
     - **Options.** `new LifecycleContext({ apiUrl, labId, connectionFile })`.
       `apiUrl` must start `http://` or `https://`, and one trailing `/` is
       trimmed. `labId` must be 32 lowercase hex characters; otherwise refuse
       with the friendly-name hint (design 6.4).
     - **`request(method, route, body?, expected)`.** The route must start
       `/labs` followed by end, `/` or `?`, with no `..`. It uses `fetch` with
       `signal` = the action's signal plus the remaining case budget (300 s
       fallback).
       - `Content-Type` is sent only with a body; there is no auth header.
       - A byte-order mark is stripped before JSON parsing.
       - The `{success, data}` envelope is required for a status below 400.
       - At 400 or above, when expected, the result is
         `{ statusCode, error }`.
       - `expected` is a number or a list (DEC-B17).
     - **`credentials(hostOnly)`.** Re-reads the connection file on every
       call: `ip`, `username`, `password`, `port` (default 5985), `useSsl`,
       `guestAdminPassword` unless `hostOnly`, and `safeModePassword`. Each
       secret is registered with `redact()` (TS-3).
     - **`unacceptedGuestPassword`.** `"Ug1-"` plus 32 hex characters from
       `crypto.randomBytes`, once per run.
  2. `src/lifecycle/stream.ts`: `Stream` per run id, cached on the context.
     - **Connect.** `GET /labs/{runId}/events/stream?after={cursor}` with
       `Accept: text/event-stream` and `Last-Event-ID` when known.
     - **`readFrame()`.** Buffers until a blank line. `event:` is the name,
       default `message`. `data:` lines are joined by `\n`, one leading space
       dropped. `id:`, `retry:` and comments are ignored, and a frame whose
       data is not JSON is skipped.
     - **Frames.** `labEvent` sets cursor = seq + 1; `complete` ends the
       stream; `error` fails; `lagged` sets cursor = resumeAfter and
       reconnects.
     - **Reconnect (DEC-B18).** Retried only on a transport error, pausing
       `min(30, 5 x attempt)` seconds, for at most 300 s and 5 reconnects.
     - **Waiting.** `waitForRun`, `waitForEvent` and `assertQuiet` have Go's
       semantics, with `trail(8)` in failure messages.
  3. `src/lifecycle/actions.ts`:
     `export const lifecycleActions: readonly Registration[] = [ ... ];` with
     one `action('lifecycle.<x>', <handler>),` per line for `get`, `submit`,
     `preview`, `stream`, `streamWait`, `streamQuiet`, `events`,
     `observations`, `points`, `retry`, `rollback`, `reverify`, `session`,
     `select`, `selectRetry`, `cleanup`, `receipt` and `compareOperation`.
     Parameters and capture shapes are as the catalog declares them. Routes,
     defaults and composites follow Go's `internal/lifecycle/actions.go`,
     read on 2026-10-14:

     | Action | Request | Default `expectedStatus` | Returns |
     | --- | --- | --- | --- |
     | `get` | GET `route` | 200 | `data`, or `{statusCode, error}` |
     | `submit` | `method` (POST) to `route`, body built as below | 202 (number or list, DEC-B17) | `data` |
     | `preview` | as `submit` with `body.dryRun = true` | 200, fixed | `data` |
     | `stream` | SSE on `runId` to `complete`, then GET `/labs/{runId}`; `status` default `succeeded` | 200 | the run |
     | `streamWait` | SSE until an event matches `phase`, `status`, `detail` (a regex, checked by `unportable()` first) | n/a | the event; a failed event fails unless `allowFailure` |
     | `streamQuiet` | SSE for `windowMs` (default 1000, at least 0) | n/a | `{quiet: true, seen}` |
     | `events` | GET `/labs/{runId}/events?after=N&limit=96`, repeated to the end | 200 | `{items, count}` |
     | `observations` | GET `/labs/{runId}/lifecycle` | 200 | `data` |
     | `points` | GET `/labs/{runId}/rollback-points` | 200 | `data` |
     | `retry`, `rollback`, `reverify` | submit to `/labs/{runId}/resume`, `/rollback`, `/reverify` | 202 | `data` |
     | `cleanup` | POST `/labs/receipts/{labId}/cleanup` with `body` as given | 200 | `data` |
     | `receipt` | GET `/labs/receipts/{labId}` | 200, fixed | `data` |
     | `session` | POST `/labs/{source.id}/update` with `connection`, `credentials`, `features` (source plan's merged with the step's), `confirmation: source.name`, `commands` (default `[]`), `rollbackPoint: false` | 202, fixed | `data` |
     | `select` | GET `/labs`; this lab's `provision` runs that `succeeded`, newest `updatedAt` first; its `/lifecycle` phase `initialize`'s `appliedRun`; GET that run; check `cloudSolutionVersion` against `plan.image.solution.version` | 200 | the run |
     | `selectRetry` | GET `/labs`; this lab's `provision` runs `failed` or `interrupted` and not carried to success through `resumedFrom`/`updatedFrom`; newest first, GET each, the first whose canonical plan equals the source's | 200 | the run |
     | `compareOperation` | no HTTP; exactly one `hostState.operations` entry with `id == run.id`, `pid` 0, empty `sessionRunId`, equal `status` and `intentHash`, equal canonical units after `apiSanitized()` | n/a | `{equal, unitCount, sessionClosed}` |

     A missing `runId` fails with "This step needs a captured runId."; a
     run id that is not 32 lowercase hex characters is refused before any
     request. `canonical()` sorts object keys and normalises ISO timestamps to
     UTC `Z`. The submit body starts from `body` and adds `connection`, then
     `credentials` unless `hostOnly`. `wrongGuestPassword` replaces
     `credentials.adminPassword` with the unaccepted guest password. `lcm`
     adds `credentials.lcmPassword`, which falls back to
     `guestAdminPassword`.
  4. `run.ts`: `--api-url`, `--lab-id` and `--connection-file` build one
     context per run, shared by every file, so streams persist across cases
     as in Go.
  5. Loopback tests (`test/unit/lifecycle/*.test.ts`), each against an
     `http.createServer` on port 0:
     - one test per action: route, body and capture;
     - the envelope and the BOM;
     - `expectedStatus` as a number, as a list, and refused;
     - the route guard;
     - redaction of every secret in error text, trace and report;
     - the stream cases Go's `stream_test.go` lists (drop and resume, lagged,
       error frame, unknown frame, quiet window);
     - the retry window with an injected clock scoped to each test: a server
       that refuses connections for 12 s and then accepts is resumed from the
       cursor; one that refuses past 300 s fails with the attempt count; an
       HTTP 500 is not retried.
  6. Catalog: add `typescript` to the 18 lifecycle actions' `bindings:`
     (DEC-B21), run `Build-Schema.ps1`, and re-run TS-6 and the extension's
     B1.4-1.
  7. Defects to file in `os-context` (add each to
     `docs/e2e/yml_suite_implementation.md` open questions, citing this step):
     - Go treats a list `expectedStatus` as 202.
     - Go redacts only request errors.
     - Go, Rust and C# make one stream connect attempt (already open question
       5).
     - Open question 5 states the pauses as "5, 10, 20, 30 s" but the code
       does `min(30, 5 x n)`.
     - Go's `wait` with `seconds` cannot be cancelled.
  8. Run [E-B13](design.md#e-b13-the-typescript-binding-runs-the-portable-stage-0-cases-on-a-lab-with-the-same-report-as-go),
     local half, on a lab.
* **Contracts.**
  - B8.7-1 Every loopback test above passes.
  - B8.7-2 TS-6 holds with 24 names, and `actions --json` prints those 24.
  - B8.7-3 E-B13's local half passes: the TypeScript and Go reports
    canonicalise identical, and no secret appears in either.
* **Constraints.** TS-3, TS-4; `STREAM_RETRY_WINDOW_SEC` = 300,
  `STREAM_MAX_RECONNECTS` = 5, `STREAM_PAUSE_STEP_SEC` = 5,
  `STREAM_PAUSE_MAX_SEC` = 30, `DEFAULT_REQUEST_BUDGET_SEC` = 300,
  `EVENTS_PAGE_LIMIT` = 96, in `src/lifecycle/context.ts`, each with the
  source it was taken from in a comment.
* **Files.** *new*: `src/lifecycle/{context,stream,actions}.ts`,
  `test/unit/lifecycle/{context,stream,actions,redact}.test.ts`; *edit*:
  `src/run.ts`, `actions.catalog.yaml`, `suite.schema.json`,
  `suite.schema.md`, `docs/e2e/yml_suite_implementation.md`.
* **Unit.** 100 percent of lines.
* **E2E.** [E-B13](design.md#e-b13-the-typescript-binding-runs-the-portable-stage-0-cases-on-a-lab-with-the-same-report-as-go),
  local half (the workflow half is B8.8).
* **Depends on.** B8.5, B8.6.
* **Status.** [ ] code [ ] unit [ ] scenario

### B8.8 CI, the lab workflow, the divergence check and the documentation

* **Deliverable.**
  - `suite-conformance.yml` runs a green `typescript` job on every change under
    `test/e2e/**` or `scripts/e2e/**`.
  - The divergence check proves that job would catch a disagreement.
  - `e2e-tests.yml` can run a lab suite with `binding: typescript`.
  - Every list of bindings in design 2.5 names five.
* **Why its own step.** These are shared files that every `os-context` change
  runs through, and they go last, when the job they add is green on its first
  run.
* **Implementation.**
  1. `.github/workflows/suite-conformance.yml`: job `typescript` on
     `ubuntu-latest`, `timeout-minutes: 20`, steps:
     - `actions/checkout` at the same pinned SHA as the other jobs;
     - `actions/setup-node`, pinned by SHA, with `node-version: 24`,
       `cache: npm`, and `cache-dependency-path:
       test/e2e/bindings/typescript/package-lock.json`;
     - `npm ci` and `npm test` with `working-directory:
       test/e2e/bindings/typescript`.
  2. `test/e2e/conformance/Assert-DivergenceIsCaught.ps1`: add
     `-Binding go|typescript` (default `go`, so the existing job is unchanged).
     For `typescript` it patches `src/assertion.ts`'s `equals` comparison to
     be case-sensitive, requires the assertion table test to fail, and
     restores the file in `finally`. The `divergence` job runs it twice.
  3. `.github/workflows/e2e-tests.yml`:
     - add `typescript` to the `binding` options;
     - add a `setup-node` step `if: ${{ inputs.binding == 'typescript' }}`;
     - in the run `switch`, add a `'typescript'` branch: `npm ci`,
       `npm run build`, then `node dist/cli.js @arguments` from the package
       directory with paths made absolute as the other branches do.
  4. `.github/workflows/suite-lint.yml` line 117: add `'typescript'` to the
     informational `E201` loop.
  5. `docs/e2e/Docs.Tests.ps1` lines 143, 160-163, 170-171: five jobs, five
     options, five directories.
  6. `scripts/e2e/LifecycleBudgetSupport.psm1` 215, 218, 407 and
     `LifecycleSetSegment.psm1` 569-576: add `src/exec.ts` to the executor
     lists, and update their tests.
  7. Prose:
     - `CLAUDE.md` line 31;
     - `.claude/context/tests.md`, the binding table, the `actions` commands
       and the conformance commands;
     - `docs/e2e/yml_suite_design.md` 3.1, 6.1 and 6.2 (also correcting 6.2's
       stale "37 declared, 25 portable" to the catalog's 100 and 24);
     - the conformance and schema READMEs.
  8. Tell the user the changes are ready to push; pushing is theirs
     (`os-context` rule). After the push, record the workflow run ids. Then
     dispatch `e2e-tests.yml` with `binding: typescript` for E-B13's workflow
     half.
* **Contracts.**
  - B8.8-1 The `typescript` job is green on the pushed commit.
  - B8.8-2 The divergence check, for `typescript`, reports the mutation caught
    and leaves the file unchanged.
  - B8.8-3 `Docs.Tests.ps1` passes with five of everything.
  - B8.8-4 The `e2e-tests.yml` run with `binding: typescript` passes E-B13's
    workflow half.
* **Files.** *edit*: the workflow, script, test and documentation files named
  above.
* **Unit.** `Docs.Tests.ps1`, `LifecycleBudgetSupport.Tests.ps1`.
* **E2E.** [E-B12](design.md#e-b12-the-typescript-binding-passes-the-whole-conformance-corpus)
  (CI and divergence halves) and
  [E-B13](design.md#e-b13-the-typescript-binding-runs-the-portable-stage-0-cases-on-a-lab-with-the-same-report-as-go)
  (workflow half).
* **Depends on.** B8.7.
* **Status.** [ ] code [ ] unit [ ] scenario

---

## Stage B9: lint while typing through the TypeScript binding

Built in this repository.

**Entry state.** After B2 the extension lints on open and save through a
program, behind the trust gate (B2.6). After B8.4 `os-context` ships
`createLinter()` with overlays.

**What it delivers.** O10: with `bddSuite.lintTool` set to `typescript`, every
finding appears within a second of the author pausing, before saving, and is
the binding's own answer.

**How it is built.** The path of [2.4b](#24b-how-an-in-editor-lint-is-set-up-end-to-end).
`LintController` gains a second back end behind one interface:

```
 interface LintBackend { lint(file, target, overlays, token): Promise<LintResult> }
   ProgramBackend  (B2: runTool + lintCommand; ignores overlays; on open and save)
   WorkerBackend   (B9: LintWorkerHost; uses overlays; on open, save and every pause)
```

The controller chooses by `lintTool`, and the triggers follow the back end.
Everything after the result (`mergeLintResults()`, stale marking, publishing)
is shared, so INV-3 and INV-4 hold for both without a second copy.

**Step order and why.** The worker host (B9.1) is observable alone: a lint on
save through the library, the same as B2.2's but in-process. Overlays and live
triggers (B9.2) build on it. Measurement and the default (B9.3) need both.

**Checklist.**

- [ ] B9.1 The lint worker: load the library from the workspace, bounded and restartable
- [ ] B9.2 Live lint of unsaved buffers through overlays
- [ ] B9.3 Live lint measured, and TypeScript made the default lint tool if it meets O10

### B9.1 The lint worker: load the library from the workspace, bounded and restartable

* **Deliverable.** With `lintTool: typescript`, open and save lint through the
  library in a worker thread, with the same diagnostics as the `typescript`
  program. A missing library, a wrong `apiVersion`, a hang or a crash each
  give their own status and stale marks.
* **Why its own step.** Loading workspace code into the extension host is the
  riskiest change in B9, and it is proved without live triggers in the way.
* **Implementation.**
  1. `src/lint/worker.ts` (bundled by `esbuild.mjs` as a second entry,
     `dist/lintWorker.js`, `format: 'cjs'`, `platform: 'node'`):
     - On start, `import()` the library from `workerData.libraryPath`, check
       the `apiVersion` major against `LIBRARY_API_MAJOR`, and post `ready`
       or `refused`.
     - On `{ type: 'lint', id, root, request }`, use the cached
       `createLinter({ root })`, call `lint(request)`, and post `result`, or
       `error` with the message.
     - On `{ type: 'invalidate', root }`, call `invalidate()`.
  2. `src/lint/workerHost.ts`: `LintWorkerHost` per 2.4b items 3-7; `start()`
     checks INV-11. Its `workerCount` is exposed for tests (E-B11, E-B15).
     `deactivate()` terminates the worker.
  3. `WorkerBackend` in `src/features/lintController.ts`; `ProgramBackend`
     extracted from B2.2's code unchanged.
  4. *Build lint tool* for `typescript` runs the shell build command of 2.8.
  5. `test/fake-library/index.mjs`: controlled by `globalThis` flags set
     through `workerData`, it answers, throws, loops, or reports
     `apiVersion: '2.0.0'`.
* **Contracts.**
  - B9.1-1 For every E-B1 validate entry, the worker's diagnostics equal the
    `typescript` program's.
  - B9.1-2 A looping library is terminated within `WORKER_LINT_TIMEOUT_MS`
    plus 1 s, and the next lint starts a new worker.
  - B9.1-3 `apiVersion` `2.0.0` is refused, with both versions in the status.
  - B9.1-4 In an untrusted workspace no worker is created (E-B15).
* **Constraints.** `WORKER_LINT_TIMEOUT_MS`,
  `WORKER_MAX_CONSECUTIVE_FAILURES`, `LIBRARY_API_MAJOR`; INV-11, INV-13.
* **Files.** *new*: `src/lint/worker.ts`, `src/lint/workerHost.ts`,
  `test/fake-library/index.mjs`, `test/unit/workerHost.test.ts`,
  `test/integration/suite/worker.test.ts`; *edit*: `esbuild.mjs`,
  `src/features/lintController.ts`, `src/tools/profiles.ts`,
  `src/config/defaults.ts`.
* **Unit.** `workerHost.test.ts` with a real `Worker` and the fake library:
  every reply kind, timeout, exit, restart, three failures in a row. 100
  percent of `workerHost.ts`; `worker.ts` per [3.3](#33-coverage-gates).
* **E2E.** The `typescript` half of
  [E-B11](design.md#e-b11-a-missing-slow-or-broken-lint-tool-is-reported-not-hidden),
  and the worker half of
  [E-B15](design.md#e-b15-in-an-untrusted-workspace-no-binding-code-runs).
* **Depends on.** B2.2, B2.6, B8.4.
* **Status.** [ ] code [ ] unit [ ] scenario

### B9.2 Live lint of unsaved buffers through overlays

* **Deliverable.** With the TypeScript lint tool, each pause in typing in a
  suite or library lints it with the editor's text, and the result replaces
  the previous one, before any save.
* **Why its own step.** It is the user-visible half of O10 and has its own
  scenario.
* **Implementation.**
  1. `LintController`: with `WorkerBackend`, `onDidChangeTextDocument` for a
     suite or library schedules a lint after `LIVE_LINT_DEBOUNCE_MS`.
  2. Overlays: every open, dirty document the index classifies as a suite or
     library, keyed by `uri.fsPath`. This means an unsaved library edit is
     seen by a suite that imports it.
  3. When a library's text changes, re-lint the open suites that import it
     (from the index's import graph), each debounced.
  4. A result for a superseded request id is discarded (INV-4). Typing does
     not cancel the running lint; its result is simply dropped.
  5. Nothing is written to disk (INV-12). The unit test asserts `fs` is not
     called with any overlay path.
* **Contracts.**
  - B9.2-1 An unsaved edit that introduces `${capture.nosuch}` shows `E301` at
    its position before any save.
  - B9.2-2 An unsaved edit to an imported library re-lints the importing open
    suite.
  - B9.2-3 With `ProgramBackend`, typing triggers nothing (B2 behaviour
    unchanged).
* **Constraints.** `LIVE_LINT_DEBOUNCE_MS`; INV-4, INV-12.
* **Files.** *edit*: `src/features/lintController.ts`,
  `src/core/workspaceIndex.ts` (`importersOf(file)`); *new*:
  `test/integration/suite/liveLint.test.ts`.
* **Unit.** `importersOf()` and overlay selection (`selectOverlays()` in
  `src/core/diagnostics.ts`).
* **E2E.** [E-B14](design.md#e-b14-an-unsaved-buffer-gets-the-same-diagnostics-the-saved-file-would),
  except its timing assertion (B9.3).
* **Depends on.** B9.1.
* **Status.** [ ] code [ ] unit [ ] scenario

### B9.3 Live lint measured, and TypeScript made the default lint tool if it meets O10

* **Deliverable.** A recorded measurement of edit-to-published time for live
  lint, and `lintTool` defaulting to `typescript` if the 95th percentile on
  `lifecycle-stage1.yml` is under 1 s.
* **Why its own step.** DEC-B04 makes the default conditional on this number.
* **Implementation.**
  1. `test/integration/suite/latency.test.ts` gains a live case: open
     `lifecycle-stage1.yml` in a worktree, make 20 one-character edits with a
     pause of `LIVE_LINT_DEBOUNCE_MS` + 50 ms, and record edit-to-published
     p50, p95 and max, with the worker already warm. Separately, record the
     cold first lint, which includes `import()` and schema load.
  2. If p95 < 1 s: set the `lintTool` default to `typescript` in `defaults.ts`
     and `package.json`, and record it in DEC-B04. Otherwise: leave the
     default, record the number in DEC-B04 and here, and open a question on
     what to change (debounce, caching, or O10's budget, which only the user
     can change).
  3. Run E-B1 with `typescript` as the lint tool, and E-B14 in full.
* **Contracts.**
  - B9.3-1 The measurement table is here with date, machine, both commits and
    Node version.
  - B9.3-2 E-B1 passes with the `typescript` tool; E-B14 passes, timing
    included.
* **Files.** *edit*: `test/integration/suite/latency.test.ts`,
  `src/config/defaults.ts`, `package.json`, `docs/design.md` (DEC-B04).
* **Unit.** None new.
* **E2E.** [E-B1](design.md#e-b1-the-editor-shows-exactly-what-the-corpus-says-lint-must-find)
  (`typescript` tool) and
  [E-B14](design.md#e-b14-an-unsaved-buffer-gets-the-same-diagnostics-the-saved-file-would).
* **Depends on.** B9.2.
* **Status.** [ ] code [ ] unit [ ] scenario

---

## Stage B7: package and accept

**Entry state.** Every build step done, each with its scenario passed on the
development build.

**What it delivers.** A `.vsix` with a recorded hash, every offline editor
scenario re-run on that exact package, and the extension's lab scenario (E-B10)
run once. The binding's own scenarios (E-B12, E-B13) are closed in B8 against
the binding and are not re-run here; the package does not contain the binding.

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
* **Depends on.** All of B1-B6, B8 and B9.
* **Status.** [ ] code [ ] unit [ ] scenario

### B7.2 Offline acceptance on the package

* **Deliverable.** E-B1 to E-B9, E-B11, E-B14 and E-B15 pass on the packaged extension, with a
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
* **E2E.** E-B1 to E-B9, E-B11, E-B14, E-B15 (E-B12 and E-B13 are the binding's own and closed in B8).
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

1. **A case-name filter on `suiterun run`.** DEC-B11 runs a whole file under
   Go, Rust, C# and TypeScript because the shared command line has no case
   filter. Adding `--case <name>` to DEC-Y14 in `os-context` (five bindings
   and a corpus entry) would let the extension run one case everywhere. Not
   part of this plan; the extension would adopt it by adding the flag in
   `runCommand()`.
2. **Do the binding programs run cleanup on an interrupt?** B6.5 assumes a kill
   skips cleanup and warns accordingly. If the programs handle Ctrl+C by
   running `cleanup`, `afterEach` and `teardown`, the extension could send
   that first and kill only after a grace period. Needs a check in each
   binding. The TypeScript binding could do it from the start (an
   `AbortController` on `SIGINT` that lets cleanup run under its own limit).
   B8.5 does not, so that its behaviour matches the other four until the
   question is answered for all five.
3. **Live dataflow while typing, for the other bindings.** B9 gives it to the
   TypeScript lint tool through its library. A `lint --stdin --as <path>`
   mode on the shared command line would give it to every binding, but it is a
   change to the contract for five programs, and is not needed while the
   TypeScript tool exists.
4. **The meta-used-twice defect in `os-context`** (its plan, open question 4).
   The scope model of B3.3 records exports at the first use. B8.4 copies the
   bindings' current behaviour so the five agree, and the fix lands in all
   five at once with a corpus entry.
5. **Integer overflow in expressions.** Whether `9223372036854775807 + 1` is
   pinned by the corpus, and what the four existing bindings do with it, is
   read in B8.3. If they disagree, it is a corpus question for `os-context`.
6. **Defects in the other bindings found by designing the fifth** (filed in
   `os-context` by B8.7):
   - a list `expectedStatus` read as 202 in Go;
   - redaction only of request errors in Go;
   - one stream connect attempt in Go, Rust and C#;
   - Go's uncancellable `wait` with `seconds`;
   - the stale binding enum in `expectation.schema.json` (fixed in B8.1);
   - open question 5's prose disagreeing with `LifecycleStream.psm1`.

   Each needs a fix in its own binding, and a corpus entry where the behaviour
   is offline.
7. **Non-Windows hosts.** `killTree`'s POSIX path is unit-tested only. If the
   extension is used on Linux or macOS, E-B11 needs a run there. The TypeScript
   binding runs on Linux in CI, for the corpus only.

---

## 6. Index

| Step | Outcome | Decisions | Scenario | Invariants |
| --- | --- | --- | --- | --- |
| B1.1 | all | DEC-B13, DEC-B14 | (activation test) | INV-9 |
| B1.2 | O2, O8 | DEC-B07 | E-B2, E-B8 | INV-2 |
| B1.3 | O3 | DEC-B01, DEC-B07 | E-B3 | INV-9 |
| B1.4 | O3, O6 | DEC-B05, DEC-B06, DEC-B16 | E-B3, E-B7 | INV-2 |
| B1.5 | O3 | DEC-B01 | E-B4 | |
| B1.6 | O3 | DEC-B07 | E-B3 | |
| B1.7 | O8 | DEC-B07 | E-B8, E-B7 | |
| B2.1 | O1 | DEC-B02 | E-B1 | INV-5, INV-10 |
| B2.2 | O1 | DEC-B02, DEC-B03 | E-B1 | INV-3, INV-4 |
| B2.3 | O2 | DEC-B04 | E-B2 | |
| B2.4 | O1 | DEC-B02 | E-B11 | INV-4, INV-5 |
| B2.5 | O1 | DEC-B04 | E-B1 | |
| B2.6 | O1, O7, O10 | DEC-B22 | E-B15 | INV-11 |
| B3.1 | O2, O4 | DEC-B09 | E-B2, E-B5 | |
| B3.2 | O4 | DEC-B08 | E-B5 | INV-9 |
| B3.3 | O4 | DEC-B08 | E-B5 | |
| B3.4 | O4, O8 | DEC-B08 | E-B5, E-B8 | |
| B3.5 | O4 | DEC-B08 | E-B5 | |
| B4.1 | O6 | DEC-B05, DEC-B21 | E-B7 | |
| B4.2 | O6 | DEC-B05 | E-B7 | |
| B4.3 | O6 | DEC-B05 | E-B7 | INV-5, INV-11 |
| B5.1 | O5 | DEC-B10 | E-B6 | INV-1, INV-8 |
| B5.2 | O5 | DEC-B10 | E-B6 | INV-1, INV-8 |
| B5.3 | O5 | DEC-B10 | E-B6 | INV-1, INV-8 |
| B5.4 | O5 | DEC-B10 | E-B6 | INV-1, INV-8 |
| B5.5 | O5 | DEC-B10, DEC-B16 | E-B6 | INV-1, INV-8, TS-6 |
| B6.1 | O7 | DEC-B11 | E-B9 | |
| B6.2 | O7 | DEC-B11 | E-B9 | INV-5, INV-10 |
| B6.3 | O7 | DEC-B11 | E-B9 | INV-6 |
| B6.4 | O7 | DEC-B11, DEC-B12 | E-B10 | INV-6, INV-7 |
| B6.5 | O7 | DEC-B12 | E-B9 | INV-5 |
| B8.1 | O9 | DEC-B15, DEC-B21 | E-B12 | TS-5 |
| B8.2 | O9 | DEC-B16 | E-B12 | TS-1, TS-2, TS-5 |
| B8.3 | O9 | DEC-B16 | E-B12 | TS-2 |
| B8.4 | O9, O10 | DEC-B15, DEC-B20 | E-B12 | TS-5 |
| B8.5 | O9 | DEC-B16, DEC-B21 | E-B12 | TS-4, TS-6 |
| B8.6 | O9 | DEC-B15 | E-B12 | TS-3 |
| B8.7 | O9 | DEC-B17, DEC-B18, DEC-B21 | E-B13 | TS-3, TS-4, TS-6 |
| B8.8 | O9 | DEC-B15 | E-B12, E-B13 | |
| B9.1 | O10 | DEC-B19, DEC-B22 | E-B11, E-B15 | INV-11, INV-13 |
| B9.2 | O10 | DEC-B20 | E-B14 | INV-4, INV-12 |
| B9.3 | O10 | DEC-B04 | E-B1, E-B14 | |
| B7.1 | all | DEC-B14 | (all, via B7.2) | |
| B7.2 | all | DEC-B14 | E-B1-E-B9, E-B11, E-B14, E-B15 | |
| B7.3 | O7 | DEC-B12, DEC-B14 | E-B10 | INV-6, INV-7 |
