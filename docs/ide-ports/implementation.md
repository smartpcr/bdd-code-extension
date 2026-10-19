# Suite authoring in Rider and Visual Studio: implementation plan

Status: **planned 2026-10-19; nothing built, nothing run.** The design, its
outcomes (O1–O7), decisions (DEC-I01–DEC-I18) and scenarios (E1–E14) are in
[design.md](design.md). This plan says how each outcome is built, in what
order, and what evidence closes each step.

Working rules:

* **Statuses stay separate.** A step goes through *designed*, *built*,
  *unit-tested*, *locally accepted* (headless and real-IDE scenarios) and
  *remotely accepted* (E10, against a real lab). A step is ticked only when
  its evidence is recorded in `docs/evidence/ide-ports-<stage>.md`. A
  skipped, blocked or failed scenario stays open, never a pass.
* **Manual checks are labelled `manual`.** A build stage may close on code,
  unit tests and a recorded manual check per step, with its scenarios written
  and linted, if its paired acceptance stage runs them. A manual check never
  ticks a scenario box. Scenarios whose defect could overwrite or delete
  something (E11 scaffolding and undo; E9 process kills) run in their build
  stage.
* **After every change to the VS Code extension**, run
  `npm run install:local` and reload the window before checking it by hand.
* **No lab is available today.** E10 is written and linted in stage I6 and
  I9 but runs only in stage I12. It stays open until it has run against a real
  lab.
* **Nothing is committed or pushed unless the user asks.**

## Contents

* [1. Deliverables](#1-deliverables)
* [2. Order and dependencies](#2-order-and-dependencies)
* [3. Stages](#3-stages)
* [4. Acceptance index](#4-acceptance-index)
* [5. Effort](#5-effort)

## 1. Deliverables

Priorities:

* **P0:** the shared foundation that any IDE needs: the spikes, the server,
  the bridge, and VS Code on the server (O1).
* **P1:** an IDE client and the release (O2–O7).
* **P2:** planned but not required by any outcome.

Priority orders the work; it never weakens a completion condition.

### <a id="d1"></a>D1. JetBrains spike: confirm the LSP API covers what DEC-I10, DEC-I11 and DEC-I15 assume (P0)

* **Result.** A written finding per question, with a throw-away plugin and
  screenshots, in `docs/evidence/ide-ports-i0.md`. Where the answer
  contradicts the design, a revised decision in design.md before stage I5
  starts.
* **Why.** The design rests on vendor documentation plus one unread
  announcement. A wrong assumption found in stage I5 would cost weeks; found
  here it costs a day.
* **How.** In Rider (latest 2026.x), a minimal plugin starts a stub LSP
  server written for the spike. The stub returns fixed answers. Questions:
  1. What does JetBrains' August 2026 "IntelliJ IDEA goes LSP" post change:
     availability by edition, API names, `implementation` or
     `workspace/configuration` support?
  2. Does `isSupportedFile` attach the server to `*suite*.yaml` while the
     YAML plugin keeps highlighting and structure?
  3. Can custom semantic token types and modifiers (`action` +
     `unimplemented`) map to the plugin's own colour keys?
  4. Do inlay hints and CodeLens render, and does a lens run a command?
  5. Does a definition answer with several targets show a chooser?
  6. Is a multi-file `applyEdit` one undo step?
  7. Record the client's `initialize` capabilities as JSON (the E1 profile).
  8. Can a custom notification (`bddSuite/status`) be received, and a custom
     request sent, from plugin code?
  9. Does the test-runner console show a tree from TeamCity messages printed
     by an external Node.js process, and does a locator navigate?
  10. Can IDE Starter/Driver open Rider and read the Problems view on
      GitHub-hosted Windows and Linux runners?
* **Files.** `spikes/jetbrains/` (deleted after the stage, kept on a branch);
  `docs/evidence/ide-ports-i0.md`.
* **Depends on.** Nothing.
* **Done when.** All ten questions are answered with evidence. Every "no" has
  a decision change recorded in design.md (for example, a switch to LSP4IJ
  under DEC-I10).
* **Proved by.** The stage I0 evidence; it prepares E3–E5 and E1's JetBrains
  profile.

### <a id="d2"></a>D2. Visual Studio spike: confirm what DEC-I07, DEC-I08, DEC-I09 and DEC-I11 assume (P0)

* **Result.** As D1, for Visual Studio 2022 17.14 and Visual Studio 2026.
* **Why.** Visual Studio's published LSP table is the oldest of the three. The
  open questions decide whether colours and hints use LSP or a client fallback
  (DEC-I08).
* **How.** A minimal VisualStudio.Extensibility extension with a
  `LanguageServerProvider` that starts the same stub server. Questions:
  1. Does a `DocumentFilter` glob pattern attach the server to `*suite*.yaml`
     while Visual Studio's YAML editor keeps its colouring?
  2. Are semantic tokens requested and drawn? Can custom types and modifiers
     get their own colours? If not, does a VisualStudio.Extensibility
     classification tagger, fed by a custom request, colour the same ranges?
  3. Are inlay hints requested and drawn?
  4. Does a multi-target definition show a chooser?
  5. Is a multi-file `applyEdit` one undo step?
  6. Record the `initialize` capabilities.
  7. Can the extension send and receive custom messages through the
     provider? If not, can it proxy the server's pipe returned from
     `CreateServerConnectionAsync` and intercept `bddSuite/*` messages?
  8. Does the server start the same way in *Open Folder* and in a `.sln`, and
     what root folder does it get?
  9. Can a Remote UI tool window show a tree with buttons, and can a dialog
     take text input (lab values)?
  10. Can a VSIX bundle Node.js for x64 and arm64? Record the VSIX size and
      whether the Marketplace accepts it.
  11. Can the extension testing harness drive both Visual Studio versions on a
      GitHub-hosted Windows runner? If not, specify the self-hosted runner.
* **Files.** `spikes/visualstudio/`; `docs/evidence/ide-ports-i0.md`.
* **Depends on.** Nothing. Runs in parallel with D1.
* **Done when.** As D1. In particular, DEC-I08's two "decided in D2" rows are
  resolved in design.md.
* **Proved by.** The stage I0 evidence; it prepares E6–E7 and E1's Visual
  Studio profile.

### <a id="d3"></a>D3. The server's foundation: folders, settings, trust, documents (P0)

* **Result.** `dist/server.js` starts over standard input and output and
  answers `initialize` with static capabilities and
  `experimental.bddSuite.protocol: 1`. It creates one folder indexer per
  workspace folder that holds a catalog and stays inert elsewhere, as
  `extension.ts` does today. It layers settings as DEC-I12 says, tracks open
  documents, watches files itself (DEC-I06), and starts every folder
  untrusted (DEC-I14).
* **Why.** Every later server deliverable plugs into this. Trust in the server
  is what makes INV-11 hold in every IDE.
* **How.**
  * **Server entry point.** Add `vscode-languageserver` and `jsonc-parser`
    dependencies. `src/server/main.ts` creates the connection and a
    `ServerHost` interface: read and list files, watch, open-document text,
    log, status. Tests can supply a fake host.
  * **Indexer.** Port `features/indexer.ts` to `src/server/folders.ts` against
    `ServerHost` instead of `vscode.workspace`, keeping its lazy rebuild and
    its open-buffer-wins rule.
  * **Settings.** `src/server/settings.ts` merges defaults, the folder's
    `.vscode/settings.json` (only when `initializationOptions.client !==
    'vscode'`) and the client's values. It ignores the restricted keys from
    the workspace file until the folder is trusted.
  * **Trust.** `src/server/trust.ts` handles `bddSuite/trust`; `runTool` and
    `LintWorkerHost` keep checking the gate themselves.
  * **Build.** Add the esbuild entries `server` and `bridge`.
* **Files.** `src/server/{main,host,folders,settings,trust}.ts`,
  `esbuild.mjs`, `package.json`, `test/unit/server-*.test.ts`.
* **Depends on.** D1 and D2 findings (capability set, settings channel).
* **Done when.**
  * Unit tests cover settings layering (all three layers, restricted keys
    before and after trust), folder activation and inertness, open-buffer
    precedence and trust gating.
  * Line coverage of `src/server` is 100%, as for `src/core` today.
  * `manual`: the server starts from a shell and answers `initialize`.
* **Proved by.** E1, E8.

### <a id="d4"></a>D4. Diagnostics and lint in the server (P0)

* **Result.** Catalog, index and lint findings are published with
  `textDocument/publishDiagnostics`. Live lint through the TypeScript library
  worker runs on each pause in typing. `bddSuite/status` reports the lint
  tool, target and state per folder.
* **Why.** Findings are the main value of the extension in any IDE.
* **How.**
  * **Lint controllers.** Port `features/lintController.ts` to
    `src/server/lint.ts`, using `ServerHost`. The program and worker back ends,
    debounce, supersede and timeout logic are unchanged.
  * **One set per file.** LSP keeps one set of findings per file and server,
    while VS Code had three diagnostic collections. A `DiagnosticsBook` keeps
    the three sources separately and publishes their union per file. A lint
    result still replaces only its own file's lint findings (INV-3), and only
    the newest lint publishes (INV-4).
  * **Status.** Status texts come from the existing `failureText` and
    `workerFailureText`, sent as `bddSuite/status`.
  * **Not-built prompt.** The "lint tool is not built" prompt becomes
    `window/showMessageRequest` with *Build lint tool* and *Choose another
    tool*. The answer runs the matching command (D6).
* **Files.** `src/server/{lint,diagnostics,status}.ts`, unit tests.
* **Depends on.** D3.
* **Done when.**
  * Unit tests prove the following:
    * the union per file;
    * INV-3 and INV-4 with three sources;
    * status transitions (ok, failed, untrusted, paused);
    * no spawn while untrusted.
  * 100% line coverage.
  * `manual`: a finding appears in VS Code through a scratch client.
* **Proved by.** E1, E2, E3, E6, E8.

### <a id="d5"></a>D5. Language features in the server (P0)

* **Result.** Completion, hover, definition, implementation, references,
  semantic tokens, inlay hints, code actions and code lenses, with the
  capability adaptation of DEC-I03.
* **Why.** O1, O2, O4: the editing features themselves.
* **How.**
  * **Providers.** Port the provider bodies of `completion.ts`, `hover.ts`,
    `navigation.ts`, `inlay.ts`, `suiteLanguage.ts` and `scaffold.ts` (the
    code-action and lens parts) to `src/server/features/*.ts`. They already
    query the index only (INV-9), so the change is in types: `vscode.Range`
    becomes LSP `Range`, `CompletionItem` and `SnippetString` become LSP
    snippet text, `MarkdownString` becomes `MarkupContent`.
  * **Semantic tokens.** The legend keeps the same type and modifier names.
    VS Code still declares the custom types and colours in `package.json`.
  * **Capability adaptation.** `src/server/capabilities.ts` reads the
    client's capabilities once and applies DEC-I03:
    * implementation targets are added to definition answers;
    * code lenses are dropped when the client lacks them;
    * hint text goes into hovers when the client lacks inlay hints;
    * features on binding source files are served only to clients that send
      those documents.
* **Files.** `src/server/features/*.ts`, `src/server/capabilities.ts`, unit
  tests ported from the provider logic.
* **Depends on.** D3.
* **Done when.**
  * Unit tests cover every provider with the three client profiles from D1
    and D2.
  * 100% line coverage.
  * `manual`: each feature is checked once in VS Code through a scratch
    client.
* **Proved by.** E1, E2, E3, E6.

### <a id="d6"></a>D6. Commands and scaffolding in the server (P0)

* **Result.** `workspace/executeCommand` runs the nine commands and the
  declare/implement scaffolding. A pick comes from `bddSuite/choices`. Edits go
  to the client as one `workspace/applyEdit`. The schema generator runs after
  a catalog edit. Tool output goes to `window/logMessage`.
* **Why.** The commands are how users declare, implement, choose and build.
  INV-8 (one undo) must hold in every IDE.
* **How.**
  * **Commands.** Port `features/commands.ts` and the command half of
    `scaffold.ts` to `src/server/commands.ts`. Each command takes its choice
    as an argument. The client shows the picker from `bddSuite/choices`
    first.
  * **Settings changes.** `chooseTargetBinding` and `chooseLintTool` return
    the new setting value, and the client stores it in its own settings
    (layer 3, DEC-I12). The server never writes IDE settings.
  * **Clipboard.** `copyBindingTable` returns the text, and the client copies
    it. LSP has no clipboard.
  * **Edits.** Stub generation keeps `core/stubs.ts` and `templates/`.
* **Files.** `src/server/commands.ts`, unit tests.
* **Depends on.** D4, D5.
* **Done when.**
  * Unit tests cover each command's edit as one `WorkspaceEdit`, the
    generator call gated by trust, and the choice lists.
  * 100% line coverage.
  * E11's VS Code part passes in this stage, because a wrong edit overwrites
    workspace files.
* **Proved by.** E1, E11.

### <a id="d7"></a>D7. The custom protocol, typed once and recorded as fixtures (P0)

* **Result.** `src/server/protocol.ts` holds the TypeScript types of the six
  messages, plus `bddSuite/testState` (test-only), and the protocol version.
  `test/protocol-fixtures/*.json` holds real request and response pairs
  recorded from the server against `samples/workspace`. The Kotlin and C#
  clients' unit tests deserialise them.
* **Why.** Three clients in three languages must read the same shapes. The
  fixtures catch a shape change in a client's own unit tests rather than in a
  slow IDE test.
* **How.**
  * **Handlers.** The server implements the handlers.
  * **Fixtures.** `scripts/record-protocol-fixtures.mjs` starts the server,
    sends each request and writes the pairs. CI fails if they differ from the
    committed ones.
  * **Version check.** A protocol version mismatch is answered as DEC-I04
    says.
* **Files.** `src/server/protocol.ts`, `src/server/custom/*.ts`,
  `scripts/record-protocol-fixtures.mjs`, `test/protocol-fixtures/`.
* **Depends on.** D3; it grows with D4–D6 and D8.
* **Done when.** Every message has a fixture. The version check has a unit
  test. CI checks that the fixtures are current.
* **Proved by.** E1.

### <a id="d8"></a>D8. The run bridge and `bddSuite/prepareRun` (P0)

* **Result.** `dist/bridge.js` runs a plan and writes per-case events as JSON
  lines or TeamCity messages. The server answers `bddSuite/prepareRun` with a
  plan file, or with the missing lab values and the confirmation text.
* **Why.** One run path for every IDE (DEC-I05), with INV-5 and INV-6 enforced
  where every IDE passes.
* **How.**
  * **Planning in the server.** Move the planning half of
    `features/testing.ts` into `src/server/runs.ts`: binding choice,
    `listCommand`/`runCommand` from `tools/profiles.ts`, `isLabSuite` with
    `offlineActions`, missing lab values, tags and test names. The plan is
    written to the client's storage folder (sent in `initializationOptions`).
  * **The bridge.** `src/bridge/main.ts` reads the plan and refuses a lab plan
    without `--lab-confirmed` and all three values. It runs the plan with
    `runTool` and `onOutput`, then maps it with `core/trace.ts`
    (`mapTrace`, `mapDryRun`, `parseNUnit`).
  * **Events.** It writes `suiteStarted`, `testStarted`, `testOutput`,
    `testFinished` (passed, failed, skipped, with message and trace) and
    `suiteFinished`. TeamCity output escapes `|`, `'`, `[`, `]`, newline and
    carriage return.
  * **Ending.** It kills its tree on standard input end, on SIGTERM and
    SIGINT, and when the parent process is gone (checked every second).
  * **Test items.** `bddSuite/testItems` comes from the index (files, cases,
    outline rows, tags, ranges, lab flag).
* **Files.** `src/server/runs.ts`, `src/bridge/*.ts`, unit tests, and
  `test/fake-tool/` reused.
* **Depends on.** D3, D7.
* **Done when.** Unit tests cover the following, at 100% line coverage:
  * plan building, including lab detection and missing values;
  * refusal without confirmation;
  * both output formats, including escaping;
  * every kill path, with the fake tool that sleeps until killed (no
    surviving process in the process list).
* **Proved by.** E1, E4, E7, E9, E10.

### <a id="d9"></a>D9. The server protocol suite (P0)

* **Result.** `npm run test:server` drives `dist/server.js` and
  `dist/bridge.js` over standard input and output with a test LSP client,
  against `samples/workspace` and the five built runtimes. It runs with three
  client profiles (VS Code, JetBrains and Visual Studio capabilities from D1
  and D2), on Windows and Linux in CI.
* **Why.** It is DEC-I17's first layer: the logic is proved once, headless,
  for every IDE.
* **How.**
  * **Test client.** Use `vscode-languageserver-protocol` and
    `vscode-jsonrpc/node` as the test client. Port the integration suite's
    oracles (`test/integration/harness/oracle.ts`, `corpus.ts`) so findings
    are compared against the runtimes' own output.
  * **Spawn log.** A log behind `BDD_TEST_SEAM=1` records every spawn, for the
    untrusted checks.
  * **Profiles.** Each profile is a JSON capabilities file under
    `test/server/profiles/`.
* **Files.** `test/server/**`, `package.json` script, `.github/workflows/ci.yml`
  job `server`.
* **Depends on.** D4–D8.
* **Done when.** E1 passes locally on Windows and in CI on Windows and Linux.
* **Proved by.** E1.

### <a id="d10"></a>D10. VS Code on the server (P0)

* **Result.** The VS Code extension starts the server with
  `vscode-languageclient` and keeps only client UI: Test Explorer (through
  `testItems`, `prepareRun` and the bridge), the bindings tree (`coverage`),
  the status bar (`status`), the reload offer, pickers, clipboard and the trust
  notification. Its in-process providers are deleted. `TestApi` becomes a
  facade over `bddSuite/testState`.
* **Why.** DEC-I02. It also makes the VS Code integration suite a second
  check on the server.
* **How.**
  * **Client start-up.** Rewrite `extension.ts`:
    * the document selector covers the `bdd-suite` language, the catalog and
      the binding source globs;
    * `initializationOptions` carry `client: 'vscode'`, the storage path and
      the trust state;
    * VS Code's own settings travel through `workspace/configuration`.
  * **Test Explorer.** Rewrite `features/testing.ts` on `testItems` plus the
    bridge (JSON lines), keeping `RunUi` and the lab dialogs.
  * **Other UI.** Rewrite `coverageView.ts` and `statusBar.ts` on custom
    messages.
  * **Commands.** Register the command wrappers that show pickers before
    `executeCommand`.
  * **Clean-up.** Delete `completion.ts`, `hover.ts`, `navigation.ts`,
    `inlay.ts`, `indexer.ts`, `lintController.ts` and the provider parts of
    `suiteLanguage.ts` and `scaffold.ts`.
  * **Tests.** Change the integration tests' internal-state reads to the
    facade, and record the diff.
* **Files.** `src/extension.ts`, `src/features/*`, `package.json`
  (dependencies, activation unchanged), `test/integration/**` (reads only).
* **Depends on.** D9.
* **Done when.** E2 passes locally and in CI. The integration test diff
  touches only internal-state reads. `npm run install:local` and a
  `manual` session in the sample workspace are recorded. A VS Code release
  with this change is published (only when the user asks), and its version
  is noted.
* **Proved by.** E2, E11 (VS Code part).

### <a id="d11"></a>D11. JetBrains plugin foundation (P1)

* **Result.** A plugin ZIP that installs in Rider 2026.1+ and does the
  following:
  * finds or fetches Node.js (DEC-I13);
  * starts the bundled server for suites and catalogs (DEC-I11);
  * pushes settings and trust;
  * shows status in a status bar widget;
  * checks the protocol version;
  * restarts the server as section 5 of the design says.
* **Why.** Everything else in JetBrains builds on it. It carries O6's trust
  rule there.
* **How.**
  * **Project.** Gradle project `clients/jetbrains` (IntelliJ Platform Gradle
    Plugin 2.x, Kotlin). `plugin.xml` depends on `com.intellij.modules.lsp`
    and `com.intellij.modules.ultimate`, with an optional dependency on the
    YAML plugin and the JavaScript plugin (Node.js interpreter lookup).
  * **Language server.** An `LspServerSupportProvider` and client descriptor:
    `isSupportedFile` uses the patterns from `package.json`'s `bdd-suite`
    language plus the catalog path, and `createCommandLine` runs
    `node server.js --stdio`.
  * **Custom messages.** The descriptor's LSP4J client override handles
    `bddSuite/status` and sends `bddSuite/trust`.
  * **Node.js.** `NodeResolver`: setting → JavaScript plugin interpreter →
    `PATH` → offered download with SHA-256 check into the IDE system folder.
  * **Settings.** A persistent settings component and a settings page (target
    binding, lint tool, toggles, lab values, Node.js path), pushed with
    `didChangeConfiguration`.
  * **Trust.** Read the platform's trusted-project state and listen for
    grants.
  * **Packaging.** The Gradle build copies `dist/*.js` into the plugin.
* **Files.** `clients/jetbrains/**`.
* **Depends on.** D1, D9 (D10 not required).
* **Done when.**
  * Unit tests cover the Node.js resolution order and hash refusal, settings
    serialisation, the protocol check, and deserialising every D7 fixture.
  * `manual`: findings appear in Rider on `samples/workspace`.
  * E8's and E13's Driver tests are written.
* **Proved by.** E3, E8, E13.

### <a id="d12"></a>D12. JetBrains actions, pickers and colours (P1)

* **Result.** The nine commands as IDE actions (Find Action and a *BDD Suite*
  editor context submenu), native pick lists from `bddSuite/choices`,
  clipboard copy, and colours for each token type and modifier combination,
  editable under *Color Scheme › BDD Suite*. The default colours are the VS
  Code colours from `package.json`.
* **Why.** O2: the same commands and the same visual feedback as VS Code.
* **How.**
  * **Actions.** One action class per command, which calls `executeCommand`
    after its picker.
  * **Colours.** Colour keys with defaults, a colour settings page, and the
    semantic-token mapping hook found in D1.
* **Files.** `clients/jetbrains/src/main/kotlin/.../actions`, `.../colors`.
* **Depends on.** D11.
* **Done when.**
  * Unit tests cover the action-to-command arguments and the colour mapping
    table.
  * E11's JetBrains part passes in this stage.
  * `manual`: each action is checked once.
* **Proved by.** E3, E11.

### <a id="d13"></a>D13. JetBrains runs (P1)

* **Result.** A *BDD Suite* run configuration, a producer from the context
  menu, gutter run icons on suites and cases, and a test-runner console fed
  by the bridge's TeamCity output. It also adds a locator, *Rerun Failed
  Tests*, lab value and confirmation dialogs, and a stop confirmation for lab
  runs.
* **Why.** O3 and the run half of O6 (DEC-I15).
* **How.**
  * **Run configuration.** A configuration type and factory, settings
    editor, and producer.
  * **Gutter icons.** A run line marker contributor that reads a per-file
    cache of `bddSuite/testItems`, refreshed on `testItems/changed`.
  * **Launch.** The run profile state asks `prepareRun`, shows the dialogs,
    then starts `node bridge.js --format teamcity` under a killable process
    handler with tree kill. It uses the test-runner console helpers with
    console properties that supply the `bddsuite://` locator and the
    rerun-failed action.
* **Files.** `clients/jetbrains/src/main/kotlin/.../run`.
* **Depends on.** D8, D11.
* **Done when.**
  * Unit tests cover the locator, the producer and the dialog logic (lab
    detected, values missing, cancel starts nothing).
  * E9's Rider part passes in this stage (process kills).
  * E4 and E10's Rider part are written.
* **Proved by.** E4, E9, E10.

### <a id="d14"></a>D14. JetBrains Bindings tool window (P1)

* **Result.** A *Suite Bindings* tool window. It shows the bindings ×
  actions table from `bddSuite/coverage`, offers *Verify with binding
  programs* and *Copy binding table*, and refreshes when the index changes.
* **Why.** O2: parity with VS Code's bindings tree.
* **How.** A tool window factory with a tree table. Refresh follows
  `bddSuite/status` and `testItems/changed`.
* **Files.** `clients/jetbrains/src/main/kotlin/.../bindings`.
* **Depends on.** D11.
* **Done when.** A unit test renders the D7 coverage fixture; `manual` check
  against VS Code's tree for the same workspace.
* **Proved by.** E3.

### <a id="d15"></a>D15. JetBrains tests, verification and CI (P1)

* **Result.** IDE Starter/Driver tests for E3, E4, E5, E8, E9 and E13; the
  Plugin Verifier over the IDE range of DEC-I10; CI jobs on Windows and Linux;
  plugin signing; publishing to JetBrains Marketplace by the release job.
* **Why.** O7, and DEC-I17's second layer for JetBrains.
* **How.**
  * **Tests.** Gradle tasks for IDE tests and verification.
  * **CI.** Jobs `jetbrains-unit`, `jetbrains-ide (windows, linux)` and
    `jetbrains-verify`.
  * **Signing.** The signing certificate and Marketplace token are kept as
    repository secrets and supplied at run time, never committed.
* **Files.** `clients/jetbrains/src/test/**`, `clients/jetbrains/build.gradle.kts`,
  `.github/workflows/ci.yml`.
* **Depends on.** D11–D14.
* **Done when.** The listed scenarios pass locally and in CI on both operating
  systems, and the verifier reports no problems.
* **Proved by.** E3, E4, E5, E8, E9, E13.

### <a id="d16"></a>D16. Visual Studio extension foundation (P1)

* **Result.** A VSIX that installs in Visual Studio 2022 17.14+ and 2026 and
  does the following:
  * starts the bundled server with the bundled Node.js for suites and
    catalogs;
  * pushes settings;
  * asks for and stores the trust grant (DEC-I14);
  * writes to an Output channel;
  * checks the protocol version and restarts the server as the design's
    section 5 says.
* **Why.** Everything else in Visual Studio builds on it. It carries O6's
  trust rule there.
* **How.**
  * **Project.** `clients/visualstudio` is a .NET 8 VisualStudio.Extensibility
    project.
  * **Language server.** `SuiteLanguageServerProvider` returns
    `DocumentFilter` glob patterns (or what D2 found works) and starts
    `node.exe server.js --stdio` from the extension folder.
  * **Custom messages.** Use the custom-message path found in D2: the
    provider's own API, or a JSON-RPC tap in the duplex pipe.
  * **Node.js.** A build step downloads the pinned Node.js for x64 and arm64,
    verifies its SHA-256, and includes it in the VSIX.
  * **Settings.** Use the VisualStudio.Extensibility settings API.
  * **Trust.** A prompt on first activation per folder, the *Trust folder*
    command, and grant storage keyed by full path.
* **Files.** `clients/visualstudio/**`.
* **Depends on.** D2, D9.
* **Done when.**
  * Unit tests (xUnit) cover trust storage, settings mapping, the protocol
    check and every D7 fixture.
  * `manual`: findings appear in both Visual Studio versions.
  * E8's and E13's Visual Studio tests are written.
* **Proved by.** E6, E8, E13.

### <a id="d17"></a>D17. Visual Studio commands, pickers and colours (P1)

* **Result.** The nine commands under *Extensions › Suite Authoring* and the
  editor context menu, pick dialogs from `bddSuite/choices`, clipboard copy,
  colours as D2 decided, and an info bar for lint failures.
* **Why.** O4: the same commands and visual feedback, within DEC-I08's gaps.
* **How.**
  * **Commands.** One command class per command, with pickers in a Remote UI
    dialog.
  * **Colours.** Classification definitions with the VS Code colours as
    defaults. If D2 chose the tagger, a classification tagger fed by
    `semanticTokens/full` through the custom-message path.
* **Files.** `clients/visualstudio/Commands/**`, `.../Colors/**`.
* **Depends on.** D16.
* **Done when.** Unit tests cover command arguments and the colour mapping;
  E11's Visual Studio part passes in this stage; `manual` check of each
  command.
* **Proved by.** E6, E11.

### <a id="d18"></a>D18. Visual Studio Suites tool window (P1)

* **Result.** The Suites tool window of DEC-I09 lists suites, cases and
  outline rows, offers Run, Dry run and Stop, and shows per-case state,
  duration, message and trace link. It asks for lab values and confirmation,
  confirms Stop on a lab run, and opens a case on double-click.
* **Why.** O5 and the run half of O6.
* **How.**
  * **Window.** A Remote UI tool window with a view model over
    `bddSuite/testItems`.
  * **Runs.** A run asks `prepareRun`, shows the dialogs, starts
    `node.exe bridge.js --format jsonl` in a Windows job object (so the tree
    dies with the extension process), and parses events into the view model.
  * **Stop.** Stop closes the bridge's input, then terminates the job.
* **Files.** `clients/visualstudio/Suites/**`.
* **Depends on.** D8, D16.
* **Done when.**
  * Unit tests cover JSON-lines parsing from fixtures and the dialog logic.
  * E9's Visual Studio part passes in this stage.
  * E7 and E10's Visual Studio part are written.
* **Proved by.** E7, E9, E10.

### <a id="d19"></a>D19. Visual Studio Bindings tool window (P1)

* **Result.** As D14, in Visual Studio.
* **Why.** O4: parity with VS Code's bindings tree.
* **How.** A Remote UI tool window over `bddSuite/coverage`, with *Verify*
  and *Copy table*.
* **Files.** `clients/visualstudio/Bindings/**`.
* **Depends on.** D16.
* **Done when.** A unit test over the D7 fixture; `manual` comparison with VS
  Code.
* **Proved by.** E6.

### <a id="d20"></a>D20. Visual Studio tests, packaging and CI (P1)

* **Result.** Extension-harness tests for E6, E7, E8, E9 and E13, on Visual
  Studio 2022 17.14 and 2026. VSIX packaging, a CI job on the runner D2
  chose, and publishing to the Visual Studio Marketplace by the release job.
* **Why.** O7, and DEC-I17's second layer for Visual Studio.
* **How.**
  * **Tests.** An xUnit project using the Visual Studio extension testing
    harness.
  * **CI.** A job `visualstudio (2022, 2026)`.
  * **Publishing.** The publisher token is a repository secret.
* **Files.** `clients/visualstudio/tests/**`, `.github/workflows/ci.yml`.
* **Depends on.** D16–D19.
* **Done when.** The listed scenarios pass locally and in CI for both
  versions.
* **Proved by.** E6, E7, E8, E9, E13.

### <a id="d21"></a>D21. One release for three IDEs, and user documentation (P1)

* **Result.**
  * **Version sync.** `scripts/sync-version.mjs` copies the version from
    `package.json` to `gradle.properties` and the `.vsixmanifest`, and CI
    fails if they differ.
  * **Release job.** It builds the three packages from one commit, checks
    that the three copies of `server.js`, `bridge.js` and `lintWorker.js` are
    byte-identical, attaches the packages to the GitHub release, and publishes
    to the three marketplaces.
  * **Docs.** The README gains a section per IDE (install, Node.js, trust,
    settings, gaps), and the CHANGELOG is updated.
* **Why.** O7 (DEC-I16).
* **How.** Extend the existing release job in `ci.yml`.
* **Files.** `scripts/sync-version.mjs`, `.github/workflows/ci.yml`,
  `README.md`, `CHANGELOG.md`.
* **Depends on.** D10, D15, D20. The release can ship VS Code plus JetBrains
  before D20 if the user chooses (DEC-I18).
* **Done when.** E12 passes on a release candidate tag.
* **Proved by.** E12.

### <a id="d22"></a>D22. Suite steps from binding source files in JetBrains and Visual Studio (P2)

* **Result.** *N suite steps* above action registrations in C#, Go and other
  binding sources, with the list on click, in JetBrains IDEs (code vision)
  and in Visual Studio for C# (the experimental CodeLens API).
* **Why.** It closes DEC-I08's largest gap. It is P2 because O2 and O4 are
  complete without it.
* **How.** A new request `bddSuite/stepsUsing { file }` returns registration
  ranges and steps from the index. The JetBrains plugin adds a code vision
  provider that is not tied to a language and runs on files under
  `bindingSources`. Visual Studio adds a CodeLens provider for C#. Neither
  attaches the language server to source files.
* **Files.** `src/server/custom/stepsUsing.ts`, `clients/jetbrains/.../vision`,
  `clients/visualstudio/CodeLens/**`.
* **Depends on.** D15 or D20 respectively.
* **Done when.** E14 passes.
* **Proved by.** E14.

## 2. Order and dependencies

```text
D1 JetBrains spike ─┐
D2 VS spike ────────┤
                    └─> D3 server foundation ─┬─> D4 diagnostics ─┐
                                              ├─> D5 features ────┼─> D6 commands ─┐
                                              └─> D7 protocol ────┴─> D8 bridge ───┴─> D9 protocol suite
                                                                                          │
                              ┌───────────────────────────────────────────────────────────┤
                              v                                                           v
                     D10 VS Code on server              D11 JB foundation ─┬─> D12 actions/colours ─┐
                              │                                            ├─> D13 runs ────────────┼─> D15 JB CI ─┐
                              │                                            └─> D14 bindings ────────┘              │
                              │                         D16 VS foundation ─┬─> D17 commands/colours ─┐             │
                              │                                            ├─> D18 Suites window ────┼─> D20 VS CI ┤
                              │                                            └─> D19 bindings ─────────┘             │
                              └────────────────────────────────────────────────────────────────────────────> D21 release
                                                                                     D15 / D20 ──> D22 (P2)
```

* **Implementation dependencies.** Each arrow above.
  * D11 and D16 need D9 (a proven server), not D10.
  * The JetBrains branch (D11–D15) and the Visual Studio branch (D16–D20)
    don't depend on each other. With two people they run in parallel.
  * DEC-I18's order (JetBrains first) applies when one person builds both.
* **Runtime prerequisites** (on the user's machine, not for building):
  * Node.js 20+ for JetBrains users, found or downloaded (DEC-I13);
  * Rider or another JetBrains IDE at 2026.1+ (commercial edition);
  * Visual Studio 2022 17.14+ or 2026;
  * the binding toolchains, as today, for linting and running.
* **Build prerequisites.**
  * Node.js 24 (as today).
  * JDK 21 and Gradle (wrapper) for the plugin.
  * .NET 8 SDK and the Visual Studio extension development workload for the
    VSIX.
  * Windows CI runners with Visual Studio 2022 17.14 and 2026 (D2 records
    whether hosted images suffice).
  * IDE Starter's downloadable Rider builds.
* **When each IDE gets the feature.**
  * **VS Code:** at the first release after D10 (no user-visible change
    intended).
  * **JetBrains users:** when D21 publishes with D15 complete.
  * **Visual Studio users:** when D21 publishes with D20 complete.

  Nothing is published to a marketplace before its stage's acceptance passes.
  Lab use from Rider or Visual Studio is documented as supported only after
  E10 passes for that IDE (stage I12).

## 3. Stages

Each stage lists its result, entry dependencies, priority, steps (at most 20),
exit evidence and size in engineer-weeks (section 5 sums them).

### Stage I0: spikes (P0)

Result: D1, D2. Entry: none. Exit evidence: `docs/evidence/ide-ports-i0.md`
answering every question of D1 and D2; design.md revised where an answer is
"no". Size: 1–1.5.

- [ ] I0.1 Read JetBrains' August 2026 LSP post; record what it changes for DEC-I10.
- [ ] I0.2 Stub LSP server (fixed answers for every message the design uses).
- [ ] I0.3 JetBrains spike plugin: attach by file name beside the YAML plugin (D1 q2).
- [ ] I0.4 JetBrains: semantic token colour mapping, inlay hints, CodeLens, multi-target definition (q3–q5).
- [ ] I0.5 JetBrains: multi-file `applyEdit` undo; custom messages; capture capabilities (q6–q8).
- [ ] I0.6 JetBrains: test-runner tree from an external process's TeamCity output, with a locator (q9).
- [ ] I0.7 JetBrains: IDE Starter/Driver on hosted Windows and Linux runners (q10).
- [ ] I0.8 Visual Studio spike extension: glob `DocumentFilter` beside the YAML editor (D2 q1).
- [ ] I0.9 Visual Studio: semantic tokens or tagger fallback; inlay hints; multi-target definition (q2–q4).
- [ ] I0.10 Visual Studio: `applyEdit` undo; capabilities; custom messages or pipe tap (q5–q7).
- [ ] I0.11 Visual Studio: Open Folder vs `.sln` root; Remote UI tree and text-input dialog (q8–q9).
- [ ] I0.12 Visual Studio: VSIX with bundled Node.js (size, Marketplace check) (q10).
- [ ] I0.13 Visual Studio: extension test harness on hosted runner, or the self-hosted runner spec (q11).
- [ ] I0.14 Record findings; revise DEC-I03, DEC-I08, DEC-I10, DEC-I11, DEC-I17 as the answers require.

### Stage I1: server foundation and diagnostics (P0)

Result: D3, D4, the D7 skeleton. Entry: I0. Exit evidence: unit tests at
100% line coverage of `src/server`; `manual` start-up and one finding through
a scratch client. Size: 2.

- [ ] I1.1 Dependencies and esbuild entries `server`, `bridge`; `npm run compile` builds them.
- [ ] I1.2 `ServerHost` interface and its Node.js implementation; a fake for tests.
- [ ] I1.3 `initialize`: static capabilities, protocol version, `initializationOptions` (client, storage, trust).
- [ ] I1.4 Port the folder indexer onto `ServerHost`; activation per folder with a catalog; inert otherwise.
- [ ] I1.5 Open documents: `didOpen`/`didChange`/`didClose`; open text wins over disk.
- [ ] I1.6 File watching with recursive `fs.watch` and the existing globs and limits (DEC-I06).
- [ ] I1.7 Settings layering with `.vscode/settings.json` (JSONC) and client values (DEC-I12).
- [ ] I1.8 Restricted settings ignored from the workspace file until trusted.
- [ ] I1.9 `bddSuite/trust`; the gate wired into `runTool` and `LintWorkerHost` (INV-11).
- [ ] I1.10 Catalog and index findings published through the `DiagnosticsBook`.
- [ ] I1.11 Port the lint controllers (program and worker back ends) onto `ServerHost`.
- [ ] I1.12 The union per file; INV-3 and INV-4 tests with three sources.
- [ ] I1.13 `bddSuite/status` with the existing failure texts.
- [ ] I1.14 Lint-tool-not-built prompt as `showMessageRequest`.
- [ ] I1.15 `protocol.ts` skeleton and the fixture recorder.
- [ ] I1.16 Unit tests to 100% line coverage of `src/server`; `manual` start-up check.

### Stage I2: language features and commands in the server (P0)

Result: D5, D6, D7 complete. Entry: I1. Exit evidence: unit tests for every
provider under three client profiles; E11's VS Code part with a scratch
client (it overwrites files); fixtures recorded. Size: 1.5–2.

- [ ] I2.1 Capability reader and adaptation rules (DEC-I03).
- [ ] I2.2 Completion (actions, parameters, captures, context keys, meta steps).
- [ ] I2.3 Hover, including the hint fallback.
- [ ] I2.4 Definition with implementation merge; implementation; references.
- [ ] I2.5 Semantic tokens with the existing legend.
- [ ] I2.6 Inlay hints.
- [ ] I2.7 Code actions (declare, implement) and code lenses (suite and source).
- [ ] I2.8 `bddSuite/choices` for every pick.
- [ ] I2.9 Commands: show actions, choose target, choose lint tool, configure lint.
- [ ] I2.10 Commands: build lint tool and verify binding programs, output through `logMessage`.
- [ ] I2.11 Declare and implement as one `WorkspaceEdit`; schema generator gated by trust.
- [ ] I2.12 Copy binding table returns text; `bddSuite/coverage`.
- [ ] I2.13 Record fixtures for every message; CI check that they are current.
- [ ] I2.14 Unit tests at 100% line coverage; E11 (VS Code part) through a scratch client.

### Stage I3: run bridge and the protocol suite (P0)

Result: D8, D9. Entry: I2. Exit evidence: E1 passes locally on Windows and in
CI on Windows and Linux. Size: 1–1.5.

- [ ] I3.1 `bddSuite/testItems` and `testItems/changed`.
- [ ] I3.2 `prepareRun`: plan building, lab detection, missing values, confirmation text.
- [ ] I3.3 Bridge: plan reading and lab refusal without confirmation.
- [ ] I3.4 Bridge: run through `runTool`, trace mapping, JSON-lines events.
- [ ] I3.5 Bridge: TeamCity output with escaping.
- [ ] I3.6 Bridge: kill on input end, signal and parent exit; tests with the fake tool.
- [ ] I3.7 Test LSP client and the three capability profiles.
- [ ] I3.8 Port the oracles; findings compared against the five runtimes.
- [ ] I3.9 Spawn log behind `BDD_TEST_SEAM`; untrusted and lab-refusal checks.
- [ ] I3.10 E1 locally; CI job `server` on Windows and Linux.

### Stage I4: VS Code on the server (P0)

Result: D10. Entry: I3. Exit evidence: E2 locally and in CI; the integration
test diff (reads only); `npm run install:local` and a `manual` session.
Size: 2–3.

- [ ] I4.1 Language client start-up, document selector, `initializationOptions`.
- [ ] I4.2 `workspace/configuration` from VS Code settings; rebuild on change.
- [ ] I4.3 Trust notification and grant event.
- [ ] I4.4 Status bar on `bddSuite/status`.
- [ ] I4.5 Bindings tree on `bddSuite/coverage`.
- [ ] I4.6 Command wrappers: pickers, clipboard, settings writes for choose commands.
- [ ] I4.7 Test Explorer on `testItems`, `prepareRun` and the bridge (JSON lines); lab dialogs kept.
- [ ] I4.8 Stop and cancellation through the bridge; `children` reported from the server.
- [ ] I4.9 `bddSuite/testState` and the `TestApi` facade.
- [ ] I4.10 Delete the in-process providers; `src/features` holds only client UI.
- [ ] I4.11 Integration tests: change internal-state reads only; record the diff.
- [ ] I4.12 E2 locally (latency included), then in CI.
- [ ] I4.13 `npm run install:local`; `manual` session in `samples/workspace`.
- [ ] I4.14 VS Code release, only when the user asks; record the version.

### Stage I5: JetBrains authoring (P1)

Result: D11, D12, D14. Entry: I3 (I4 recommended, not required). Exit
evidence:
* unit tests;
* E11's JetBrains part (run in this stage);
* E3, E8 and E13 written and linted;
* a `manual` check per step.

Size: 2–3.

- [ ] I5.1 Gradle project, `plugin.xml`, build copying `dist/*.js`.
- [ ] I5.2 Node.js resolution order; download with SHA-256 check; version check (20+).
- [ ] I5.3 LSP provider and descriptor: `isSupportedFile` by file name and catalog path.
- [ ] I5.4 Custom message handling: status widget, trust from trusted-project state.
- [ ] I5.5 Settings component and page; push with `didChangeConfiguration`.
- [ ] I5.6 Protocol version check; restart policy and *Restart server* action.
- [ ] I5.7 Deserialise every D7 fixture in unit tests.
- [ ] I5.8 Actions for the nine commands; pick lists; clipboard.
- [ ] I5.9 Colour keys, colour settings page, semantic token mapping.
- [ ] I5.10 Bindings tool window.
- [ ] I5.11 E11 JetBrains part (one undo) run and recorded.
- [ ] I5.12 E3, E8, E13 Driver tests written and linted; `manual` checks recorded.

### Stage I6: JetBrains runs (P1)

Result: D13. Entry: I5. Exit evidence: unit tests; E9's Rider part run in
this stage; E4 and E10 (Rider) written and linted. Size: 2.

- [ ] I6.1 Run configuration type, factory, settings editor.
- [ ] I6.2 Producer from the context menu.
- [ ] I6.3 Gutter run icons from the `testItems` cache.
- [ ] I6.4 Run state: `prepareRun`, then the bridge under a killable handler with tree kill.
- [ ] I6.5 Test-runner console with TeamCity input; `bddsuite://` locator.
- [ ] I6.6 *Rerun Failed Tests*.
- [ ] I6.7 Lab value and confirmation dialogs; stop confirmation for lab runs.
- [ ] I6.8 Unit tests: locator, producer, dialog logic.
- [ ] I6.9 E9 Rider part run and recorded.
- [ ] I6.10 E4 and E10 (Rider) written and linted.

### Stage I7: JetBrains acceptance and CI (P1)

Result: D15. Entry: I6. Exit evidence: E3, E4, E5, E8, E9 and E13 pass
locally and in CI (Windows and Linux); the Plugin Verifier is clean. Size: 1.

- [ ] I7.1 Gradle IDE-test and verify tasks.
- [ ] I7.2 E3 on Windows and Linux.
- [ ] I7.3 E4 on Windows and Linux.
- [ ] I7.4 E5 in GoLand, RustRover, IDEA Ultimate, WebStorm; verifier over the range.
- [ ] I7.5 E8, E9 (rerun on CI), E13.
- [ ] I7.6 CI jobs; signing and Marketplace secrets supplied at run time.

### Stage I8: Visual Studio authoring (P1)

Result: D16, D17, D19. Entry: I3 (I4 recommended). Exit evidence:
* unit tests;
* E11's Visual Studio part (run in this stage);
* E6, E8 and E13 written and linted;
* a `manual` check per step.

Size: 2.5–3.

- [ ] I8.1 VisualStudio.Extensibility project; VSIX with `dist/*.js`.
- [ ] I8.2 Bundled Node.js for x64 and arm64, hash-checked at build.
- [ ] I8.3 Language server provider with document filters; server start-up.
- [ ] I8.4 Custom-message path (provider API or pipe tap, per D2).
- [ ] I8.5 Settings through the extensibility settings API; push.
- [ ] I8.6 Trust prompt, grant storage, *Trust folder* command.
- [ ] I8.7 Output channel; protocol check; restart policy and *Restart server*.
- [ ] I8.8 Deserialise every D7 fixture in unit tests.
- [ ] I8.9 Commands in menus; pick dialogs; clipboard.
- [ ] I8.10 Colours: classification definitions, and the tagger if D2 chose it.
- [ ] I8.11 Info bar for lint failures.
- [ ] I8.12 Bindings tool window.
- [ ] I8.13 E11 Visual Studio part run and recorded.
- [ ] I8.14 E6, E8, E13 harness tests written and linted; `manual` checks recorded.

### Stage I9: Visual Studio runs (P1)

Result: D18. Entry: I8. Exit evidence: unit tests; E9's Visual Studio part
run in this stage; E7 and E10 (Visual Studio) written and linted. Size:
1.5–2.

- [ ] I9.1 Suites tool window: tree of folders, files, cases, outline rows.
- [ ] I9.2 Refresh on `testItems/changed`; open a case on double-click.
- [ ] I9.3 Run and dry run: `prepareRun`, the bridge in a job object, JSON-lines parsing.
- [ ] I9.4 Per-case state, duration, message, trace link.
- [ ] I9.5 Lab value and confirmation dialogs; stop confirmation for lab runs.
- [ ] I9.6 Stop: close input, then terminate the job.
- [ ] I9.7 Unit tests: parsing fixtures, dialog logic.
- [ ] I9.8 E9 Visual Studio part run and recorded.
- [ ] I9.9 E7 and E10 (Visual Studio) written and linted.

### Stage I10: Visual Studio acceptance and CI (P1)

Result: D20. Entry: I9. Exit evidence: E6, E7, E8, E9 and E13 pass locally
and in CI on Visual Studio 2022 17.14 and 2026. Size: 1.

- [ ] I10.1 xUnit harness project and CI runner per D2.
- [ ] I10.2 E6 on both versions, Open Folder and `.sln`.
- [ ] I10.3 E7 on both versions.
- [ ] I10.4 E8, E9 (rerun on CI), E13.
- [ ] I10.5 CI job; Marketplace publisher secret supplied at run time.

### Stage I11: release (P1)

Result: D21. Entry: I4 plus I7 and/or I10 (DEC-I18). Exit evidence: E12 on a
release-candidate tag. Size: 0.5–1.

- [ ] I11.1 Version sync script and CI check.
- [ ] I11.2 Release job builds three packages; hash check of the shared files.
- [ ] I11.3 README sections per IDE; CHANGELOG.
- [ ] I11.4 E12: install, upgrade, uninstall in each IDE; marketplace validators.
- [ ] I11.5 Publish, only when the user asks; record versions and listing URLs.

### Stage I12: lab acceptance (P1, remote)

Result: E10 for Rider and Visual Studio. Entry: I7 or I10 for the IDE under
test; a real lab and the os-context jump path available. Exit evidence: E10's
records per IDE (lab id, run ids, per-case comparison with the VS Code
reference, os-context's cleanup evidence). Size: 0.5 plus lab time.

- [ ] I12.1 Controller set up: IDEs with the release-candidate packages; os-context worktree on the pin.
- [ ] I12.2 VS Code reference run of the stage 0 lab suite; results recorded.
- [ ] I12.3 E10 in Rider.
- [ ] I12.4 E10 in Visual Studio.
- [ ] I12.5 Cleanup evidence; any failure kept with its lab state, scenario left open.

### Stage I13: source-file steps (P2)

Result: D22. Entry: I7 (JetBrains part) or I10 (Visual Studio part). Exit
evidence: E14. Size: 1–2.

- [ ] I13.1 `bddSuite/stepsUsing`, with a fixture and unit tests.
- [ ] I13.2 JetBrains code vision provider for files under `bindingSources`.
- [ ] I13.3 Visual Studio C# CodeLens provider.
- [ ] I13.4 E14 in Rider, GoLand and Visual Studio.

## 4. Acceptance index

| Scenario | Proves | Deliverables | Runs in stage | Layer | Status |
| --- | --- | --- | --- | --- | --- |
| [E1](design.md#e1) | O1 | D3–D9 | I3 | headless | not run |
| [E2](design.md#e2) | O1 | D10 | I4 | real IDE (VS Code) | not run |
| [E3](design.md#e3) | O2 | D11, D12, D14, D15 | I7 | real IDE (Rider) | not run |
| [E4](design.md#e4) | O3 | D13, D15 | I7 | real IDE (Rider) | not run |
| [E5](design.md#e5) | O2 | D11, D15 | I7 | real IDEs (JetBrains family) | not run |
| [E6](design.md#e6) | O4 | D16, D17, D19, D20 | I10 | real IDE (Visual Studio) | not run |
| [E7](design.md#e7) | O5 | D18, D20 | I10 | real IDE (Visual Studio) | not run |
| [E8](design.md#e8) | O6 | D3, D11, D16 | I7, I10 | real IDE | not run |
| [E9](design.md#e9) | O3, O5, O6 | D8, D13, D18 | I6, I9 (build); rerun in I7, I10 | real IDE | not run |
| [E10](design.md#e10) | O6 | D8, D13, D18 | I12 | **remote, real lab** | not run; no lab available today |
| [E11](design.md#e11) | O2, O4, O6 | D6, D10, D12, D17 | I2/I4 (VS Code), I5 (JetBrains), I8 (Visual Studio) | real IDE | not run |
| [E12](design.md#e12) | O7 | D21 | I11 | real IDEs, packages | not run |
| [E13](design.md#e13) | O7 | D11, D16 | I7, I10 | real IDE | not run |
| [E14](design.md#e14) | DEC-I08 gap (P2) | D22 | I13 | real IDE | not run |

## 5. Effort

Engineer-weeks for one engineer who knows this codebase, from the stage
sizes above. These are estimates for planning, not commitments. The spikes
may move them.

| Part | Stages | Weeks |
| --- | --- | --- |
| Shared: spikes, server, bridge, protocol suite, VS Code on the server | I0–I4 | 7.5–10 |
| JetBrains plugin | I5–I7 | 5–6 |
| Visual Studio extension | I8–I10 | 5–6 |
| Release | I11 | 0.5–1 |
| Lab acceptance | I12 | 0.5 + lab time |
| **Both IDEs, P0 + P1** | I0–I12 | **18.5–23.5** |
| JetBrains only (skip I8–I10) | | 13.5–17.5 |
| Visual Studio only (skip I5–I7) | | 13.5–17.5 |
| P2 source-file steps | I13 | 1–2 |
