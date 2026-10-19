# Suite authoring in Rider and Visual Studio: design

Status: **designed 2026-10-19; nothing built, nothing run.** The plan that
builds it is [implementation.md](implementation.md). Every outcome here links
to the deliverables that produce it and the scenarios that prove it. Two spikes
([D1](implementation.md#d1), [D2](implementation.md#d2)) come first. They test
the assumptions marked **(spike)** below, and their findings may change a
decision before any feature work starts.

Audience: anyone deciding whether to fund this work; whoever builds it
(TypeScript, Kotlin or C#); reviewers; people who write suites in Rider or
Visual Studio and want to know what they will get. You don't need to know the
extension's source. Section 2 says what the extension does today, and the
[Vocabulary](#vocabulary) defines every term the document relies on.

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

The suite words (suite, action, catalog, binding, runtime, target binding,
lint tool, lab run) mean what they mean in [the main design](../design.md) and
[the self-contained design](../self-contained/design.md#vocabulary). The words
below are new here.

| Word | Meaning, and why it matters here |
| --- | --- |
| **IDE** | An editor with project, build and test tooling. Here: VS Code, Visual Studio (Windows) and the JetBrains IDEs. |
| **Visual Studio** | Microsoft's Windows IDE (2022 and 2026), not VS Code. Its extensions are `.vsix` packages written in C#. |
| **JetBrains IDEs** | IDEs built on the IntelliJ Platform: Rider (C#), GoLand, RustRover, IntelliJ IDEA, WebStorm, PyCharm. One plugin, written in Kotlin, can serve them all. **Rider** is the first target because C# bindings are the most common. |
| **Language server** | A separate process that understands one kind of file and answers an editor's questions about it: "what are the errors?", "what can go here?", "where is this defined?". |
| **LSP** (Language Server Protocol) | The standard message format between an editor and a language server (JSON-RPC over standard input and output). Each of the three IDEs has a built-in LSP **client**, so one server can serve all three. Each client supports a different subset of the messages (section 4, [DEC-I03](#dec-i03)). |
| **The server** | The language server this work creates from the extension's existing editor-independent code (`src/core`, `src/lint`, `src/tools`, `src/config`). It runs on Node.js. |
| **Client** | The per-IDE code that starts the server, shows what it returns, and supplies the user interface the protocol cannot: test runs, tool windows, pickers, dialogs. There are three: the VS Code extension, the Visual Studio extension and the JetBrains plugin. |
| **Custom request** | A message outside the LSP standard, named `bddSuite/...`, that this server and its clients agree on. It carries what LSP has no message for, such as a suite's test items or the bindings table. |
| **Semantic tokens** | LSP's way to colour words by meaning rather than by grammar. The extension uses them to colour an action green when the target binding implements it and red when it doesn't. |
| **Inlay hints** | Short grey labels the editor draws inside a line. The extension uses them to show which bindings implement a step's action. |
| **CodeLens** | A clickable line of text drawn above a line of code. The extension draws *Implement in Go* above a step whose action Go lacks, and *3 suite steps* above an action's registration in binding code. |
| **Run bridge** | A small Node.js program, shipped beside the server, that runs one suite file with a binding's `suiterun` and reports each case's result as it happens. It is new: every IDE starts runs through it ([DEC-I05](#dec-i05)). |
| **Test runner tree** | Where an IDE lists tests and their results. VS Code calls it Test Explorer. JetBrains IDEs have a test-runner console fed by **TeamCity service messages** (lines like `##teamcity[testFailed name='...']` that the IDE turns into a tree). Visual Studio's Test Explorer only accepts .NET-style test adapters, so Visual Studio gets its own **Suites tool window** instead ([DEC-I09](#dec-i09)). |
| **Tool window** | A dockable panel in Visual Studio or a JetBrains IDE. It plays the role of VS Code's tree views. |
| **Trust** | Whether the user allowed this folder's code to run. Linting, running and schema generation all execute workspace code, so they wait for trust (the existing INV-11). VS Code and JetBrains IDEs ask for trust themselves. Visual Studio has no such concept, so this design adds one ([DEC-I14](#dec-i14)). |
| **Spike** | A short, throw-away experiment that checks an assumption before features are built on it. Its result is a written finding, not shipped code. |

## 1. What we want to achieve

### 1.1 The problem

Suite authoring exists only in VS Code. Many of the people who write bindings
work in other IDEs: C# authors in Rider or Visual Studio, Go authors in GoLand,
Rust authors in RustRover. They write suites with no findings, no completion,
no navigation from a step to its action's code, and no way to run a case from
the editor. They either switch editors or run `suiterun` by hand and read the
output.

The extension's logic can't simply be copied into another IDE. 2,325 of its
6,068 lines of TypeScript call the VS Code API directly. Neither Visual Studio
nor JetBrains IDEs can load a VS Code extension, and their extensions are
written in other languages (C# and Kotlin). Writing the logic three times
would give three implementations that disagree within months.

### 1.2 Outcomes

| ID | Outcome (observable) | Built by | Proved by |
| --- | --- | --- | --- |
| <a id="o1"></a>**O1** | **One language server serves suite authoring for every IDE, and VS Code behaves as it did before.** Every finding, completion, hover, navigation target, colour, hint, quick fix and command result comes from the server, and VS Code's existing integration suite passes with its assertions unchanged. | [D3](implementation.md#d3)–[D9](implementation.md#d9), [D10](implementation.md#d10) | [E1](#e1), [E2](#e2) |
| <a id="o2"></a>**O2** | **Rider users author suites with the same feedback as in VS Code**: findings as they type, completion, hover, go to definition, references, colouring by implementation state, binding hints, quick fixes, the *Declare*/*Implement* lenses, the scaffolding commands and the bindings view. The plugin also works in the other JetBrains IDEs listed in [DEC-I10](#dec-i10). | [D1](implementation.md#d1), [D11](implementation.md#d11), [D12](implementation.md#d12), [D14](implementation.md#d14) | [E3](#e3), [E5](#e5), [E11](#e11) |
| <a id="o3"></a>**O3** | **Rider users run suites from the IDE**: a run or dry run of a file or a case from the gutter or the run configuration, one result per case in the test-runner tree, rerun of failed cases, and a stop that ends every process the run started. | [D8](implementation.md#d8), [D13](implementation.md#d13) | [E4](#e4), [E9](#e9) |
| <a id="o4"></a>**O4** | **Visual Studio users author suites** with the same feedback as O2, except for the gaps [DEC-I08](#dec-i08) accepts: no lenses (the same actions are offered as quick fixes), and no suite references or lens from binding source files. | [D2](implementation.md#d2), [D16](implementation.md#d16), [D17](implementation.md#d17), [D19](implementation.md#d19) | [E6](#e6), [E11](#e11) |
| <a id="o5"></a>**O5** | **Visual Studio users run suites** from a Suites tool window: run or dry run of a file or case, one result per case with its message and trace, and a stop that ends every process. | [D8](implementation.md#d8), [D18](implementation.md#d18) | [E7](#e7), [E9](#e9) |
| <a id="o6"></a>**O6** | **The extension's safety rules hold in every IDE.** No workspace code runs before trust (INV-11). No child process outlives its request (INV-5). No suite runs without an explicit request, and a lab run needs its confirmation (INV-6). No credential is stored (INV-7). A scaffolding command is undone by one undo (INV-8). | [D3](implementation.md#d3), [D6](implementation.md#d6), [D8](implementation.md#d8), [D11](implementation.md#d11), [D13](implementation.md#d13), [D16](implementation.md#d16), [D18](implementation.md#d18) | [E8](#e8), [E9](#e9), [E10](#e10), [E11](#e11) |
| <a id="o7"></a>**O7** | **One release ships all three**, each installable from its marketplace, with the same version number, built and tested in CI. | [D15](implementation.md#d15), [D20](implementation.md#d20), [D21](implementation.md#d21) | [E12](#e12), [E13](#e13) |

### 1.3 Scope and non-goals

In scope: the language server and run bridge; moving VS Code onto them; a
JetBrains plugin (Rider first); a Visual Studio extension; their CI, packaging
and marketplace releases.

Not in scope:

* **Changing what suites mean or what the extension reports.** Finding codes,
  colours, hint text, stub templates and run results stay the same. The
  server moves code; it does not rewrite behaviour.
* **A Visual Studio Test Explorer adapter** ([DEC-I09](#dec-i09)). Visual Studio
  runs suites from its own tool window.
* **Features in binding source files outside VS Code** (the *N suite steps*
  lens on an action's registration and suite references from C#, Go and other
  source files). These are priority P2 ([DEC-I08](#dec-i08)): planned but not
  required for O2 or O4.
* **Other LSP editors** (Neovim, Zed, Sublime). The server will probably work
  in them, but nobody tests or supports that.
* **Debugging suites** in any IDE. No IDE exposes a debugger for the
  bindings' step runners, and none is planned here.
* **IntelliJ IDEA open-source builds and Android Studio**, which lack the
  JetBrains LSP API ([DEC-I10](#dec-i10)).

## 2. What exists today

Measured on `main` at `48d9355` (version 0.6.10), 2026-10-19.

**Code.** 3,743 lines in `src/core`, `src/lint`, `src/tools`, `src/config`
and `src/limits.ts` never import `vscode` (INV-9 already requires this of
`src/core`). Another 2,325 lines in `src/extension.ts` and `src/features/`
connect that logic to the VS Code API. Tests: 3,456 lines of unit tests with
100% line coverage of the editor-independent code, and 2,454 lines of
integration tests that drive a real VS Code against `samples/workspace` and
the five runtimes.

**What each feature is, and what it becomes.** The last three columns say
how each IDE provides the feature after this work. "LSP" means the IDE's
built-in client shows what the server returns. Facts about Visual Studio and
JetBrains come from their published documentation (sources listed under
[DEC-I03](#dec-i03)).

| Feature today | VS Code code (lines) | Server message | VS Code | Rider / JetBrains | Visual Studio |
| --- | --- | --- | --- | --- | --- |
| Activation per folder with a catalog; settings; rebuild on change | `extension.ts` (223) | `initialize`, settings ([DEC-I12](#dec-i12)) | LSP | LSP | LSP |
| Catalog and index findings (`BDD0xx`) | `features/indexer.ts` (208) | `publishDiagnostics` | LSP | LSP | LSP |
| Lint by the lint tool's program on save; live lint through the TypeScript library while typing | `features/lintController.ts` (317), `lint/*` | `publishDiagnostics` | LSP | LSP | LSP |
| Completion of actions, parameters, captures, context keys | `features/completion.ts` (134), part of `suiteLanguage.ts` | `completion` | LSP | LSP | LSP |
| Hover on an action, parameter or capture | `features/hover.ts` (48) | `hover` | LSP | LSP | LSP |
| Go to definition (catalog entry, meta step) and implementation (binding code) | `features/navigation.ts` (113) | `definition`, `implementation` | LSP | definition: LSP; implementation: merged into definition ([DEC-I08](#dec-i08)) | same as JetBrains |
| References: steps that use an action, from the suite or the catalog | `features/navigation.ts` | `references` | LSP | LSP | LSP |
| References and *N suite steps* lens from binding source files | `features/navigation.ts` | `references`, `codeLens` on source files | LSP | P2 ([DEC-I08](#dec-i08)) | P2 |
| Colour by implementation state (implemented, not in target, unimplemented, undeclared) | `features/suiteLanguage.ts` (224) | `semanticTokens/full` | LSP | LSP; colours mapped by the plugin (**spike**) | LSP or client tagger (**spike**) |
| Binding hints after each step | `features/inlay.ts` (35) | `inlayHint` | LSP | LSP | LSP (**spike**) |
| Quick fixes: declare action, implement in binding | `features/scaffold.ts` (316) | `codeAction` | LSP | LSP | LSP |
| *Declare* / *Implement in X* lenses above steps | `features/scaffold.ts` | `codeLens` | LSP | LSP (2026.1+) | not supported; the quick fixes remain |
| Nine commands (show actions, build/choose lint tool, choose target, configure lint, declare, implement, verify programs, copy table) | `features/commands.ts` (108), `scaffold.ts` | `executeCommand`, `applyEdit`, `bddSuite/choices` | client command → server | plugin actions → server | extension commands → server |
| Bindings tree (which binding implements which action) | `features/coverageView.ts` (134) | `bddSuite/coverage` | tree view | tool window | tool window |
| Suites in Test Explorer: run, dry run, lab run with confirmation, cancel | `features/testing.ts` (356) | `bddSuite/testItems`, `bddSuite/prepareRun`, run bridge | Test Explorer | test-runner tree, gutter icons, run configuration | Suites tool window |
| Status bar (lint tool, target, failures, untrusted) | `features/statusBar.ts` (36) | `bddSuite/status` | status bar | status bar widget | Suites window header and Output pane |
| Offer a reload when a newer copy is installed | `features/selfUpdate.ts` (73) | none | unchanged | not needed: the IDE manages plugin updates | not needed: the IDE manages extension updates |
| Workspace trust gate | `config/trust.ts`, `extension.ts` | `bddSuite/trust` | VS Code trust | platform trusted projects | the extension's own grant ([DEC-I14](#dec-i14)) |
| TextMate grammar and language id `bdd-suite` by file name | `syntaxes/`, `package.json` | none | unchanged | files stay YAML; colouring from semantic tokens ([DEC-I11](#dec-i11)) | same as JetBrains |

**Invariants that carry over.** INV-1 to INV-13 in
[the main plan](../implementation.md#27-invariants) keep their numbers and
meaning. Where an invariant names a VS Code mechanism (such as
`WorkspaceEdit` in INV-8 or Test Explorer in INV-6), it now applies to the
equivalent mechanism in every IDE. [O6](#o6) proves that in each IDE.

## 3. The shape of the result

```text
bdd-code-extension/
  src/core, src/lint, src/tools, src/config   unchanged: the editor-independent logic
  src/server/                                 NEW  the language server: LSP wiring, folder indexers,
                                                   lint controllers, providers, commands (TypeScript)
  src/bridge/                                 NEW  the run bridge: runs one plan, reports per case
  src/extension.ts, src/features/             VS Code client: starts the server; keeps Test Explorer,
                                                   bindings tree and status bar, fed by custom requests
  clients/jetbrains/                          NEW  Kotlin plugin (Gradle): LSP client, run configuration,
                                                   test-runner integration, tool window, settings, actions
  clients/visualstudio/                       NEW  C# extension (VisualStudio.Extensibility): language
                                                   server provider, Suites and Bindings tool windows,
                                                   commands, settings, trust grant
  dist/server.js, dist/bridge.js, dist/lintWorker.js
                                              built once, shipped in all three packages
  spec/, conformance/, runtimes/, samples/    unchanged
```

How one keystroke and one run flow:

```text
 typing in suite.yml                                   Run on a case
        │                                                    │
 IDE's LSP client ──didChange──> server ── index, lint ──> publishDiagnostics, semanticTokens, inlayHint ──> IDE
        │                            │
        │                            └─ lint tool program / TypeScript library worker (only when trusted)
        │
 client UI ──bddSuite/prepareRun──> server ── resolves binding, program, lab need ──> plan (+ lab detail)
        │   (lab? confirm dialog in the client; INV-6)
        └──spawns──> run bridge ──> binding's suiterun ──> trace
                         │
                         └─ per-case events: JSON lines (VS Code, Visual Studio) or TeamCity messages (JetBrains)
```

The server owns every decision (what is a suite, which binding runs, whether
the run touches a lab, what a trace means). Each client owns only how the
result looks in its IDE. As a result, the three IDEs cannot disagree about a
finding or a result.

## 4. Decisions

### <a id="dec-i01"></a>DEC-I01. One Node.js language server, built from the existing editor-independent code

**Choice.** Build `src/server/` as an LSP server on the `vscode-languageserver`
library. It reuses `src/core`, `src/lint`, `src/tools` and `src/config`
unchanged. The 2,325 lines of VS Code wiring become server-side providers
behind LSP messages. The few uses of `vscode` types for positions, ranges and
edits are replaced by the LSP library's equivalents. The server is bundled
with esbuild into `dist/server.js`, as the extension is today.

**Why.** It is the only option where a finding or a run result is computed in
one place. Three IDE-specific implementations of the index, lint, scope and
trace mapping (about 3,700 lines each, in TypeScript, Kotlin and C#) would
drift apart. The 3,456 lines of unit tests would also have to be written three
times.

**Tradeoff.** Every IDE now needs Node.js ([DEC-I13](#dec-i13)). A few VS Code
features have no LSP message and need custom requests ([DEC-I04](#dec-i04)).
Each IDE's LSP client supports a different subset, so some features degrade
per IDE ([DEC-I08](#dec-i08)).

**Serves.** O1, O2, O4. **Verified by.** E1, E2.

### <a id="dec-i02"></a>DEC-I02. VS Code moves onto the server too, with no fallback to the old providers

**Choice.** The VS Code extension starts the server through
`vscode-languageclient` and deletes its in-process providers. The VS Code
features with no LSP message (Test Explorer, bindings tree, status bar, reload
offer) stay in the VS Code client and get their data from custom requests.
There is no setting to switch back. If a released version regresses, the
previous version remains installable from the marketplace.

**Why.** If VS Code kept its own providers, every change would be made twice
and the IDEs would drift, which DEC-I01 exists to prevent. VS Code also has
the strongest test suite. Running it against the server proves the server
before any other IDE uses it.

**Tradeoff.** The largest regression risk lands in the IDE that works today.
It is contained because the 2,454-line integration suite must pass with its
assertions unchanged (E2), including its latency checks. Only its reads of
internal state move to a test-only request. Keeping both paths behind a setting would
halve that risk but double the code for every later change.

**Serves.** O1. **Verified by.** E2.

### <a id="dec-i03"></a>DEC-I03. Editor features use standard LSP messages only; the server adapts its answers to what each client supports

**Choice.** Every editor feature in the section 2 table that has an LSP
message uses that message and nothing else. The server reads the client's
`initialize` capabilities and adapts:

* **`implementation`.** When the client doesn't support it, its targets are
  added to `definition`, so F12 on an action offers both the catalog entry and
  the binding code.
* **`codeLens`.** When the client doesn't support it, nothing is sent; the
  same actions are already quick fixes.
* **`inlayHint`.** When the client doesn't support it, the hint text is added
  to the step's hover.
* **Dynamic registration.** The server registers its capabilities statically
  in `initialize`, because Visual Studio's client doesn't support dynamic
  registration (`client/registerCapability`).

Support as published by each vendor, checked 2026-10-19:

| Message | VS Code | JetBrains LSP API (version added) | Visual Studio LSP client |
| --- | --- | --- | --- |
| diagnostics, completion, hover, definition, code actions | yes | 2023.2–2023.3 | yes |
| `executeCommand`, `applyEdit` | yes | 2024.1 | yes |
| references | yes | 2024.2 | yes |
| semantic tokens | yes | 2024.2.2 | not in the table; a third-party server reports it working on 17.14+ (**spike**) |
| inlay hints | yes | 2025.2.2 | not in the table; reported working on 17.14+ (**spike**) |
| code lens | yes | 2026.1 | **no** |
| implementation | yes | not listed | not listed |
| `workspace/configuration` (pull) | yes | not listed | not listed; `didChangeConfiguration` yes |
| `showMessageRequest` | yes | yes | yes |
| dynamic registration | yes | — | **no** |

Sources: [JetBrains LSP API](https://plugins.jetbrains.com/docs/intellij/language-server-protocol.html),
[Visual Studio LSP extensions](https://learn.microsoft.com/en-us/visualstudio/extensibility/adding-an-lsp-extension),
[VisualStudio.Extensibility language server provider](https://learn.microsoft.com/en-us/visualstudio/extensibility/visualstudio.extensibility/language-server-provider/language-server-provider),
[HLSL-LSP](https://github.com/KStocky/HLSL-LSP) (third-party evidence for Visual Studio 17.14+).

**Why.** Standard messages get the IDE's native look (the Error List,
completion pop-ups, Find Usages) for free and with no per-IDE code. Adapting
on capabilities, rather than per IDE name, keeps the server free of IDE
checks.

**Tradeoff.** Visual Studio's published table predates semantic tokens and
inlay hints. Spike D2 confirms them. If either is missing, [DEC-I08](#dec-i08)
says what replaces it.

**Serves.** O1, O2, O4. **Verified by.** E1, E3, E6.

### <a id="dec-i04"></a>DEC-I04. Features with no LSP message use a small, versioned custom protocol; the server decides, the client displays

**Choice.** Six custom messages, documented with their JSON shapes in the
server's source (`src/server/protocol.ts`) and summarised here:

| Message | Direction | Carries | Used for |
| --- | --- | --- | --- |
| `bddSuite/status` | server → client | per folder: lint tool, target binding, state (`ok`, `failed`, `untrusted`, `paused`) and text | status bar / widget / window header |
| `bddSuite/trust` | client → server | whether the folder is trusted | INV-11 ([DEC-I14](#dec-i14)) |
| `bddSuite/testItems` (+ `.../changed`) | client ↔ server | suite files, cases and outline rows with ranges, tags, and whether each is a lab suite | Test Explorer, gutter icons, Suites window |
| `bddSuite/prepareRun` | client → server | files and cases, mode (run, dry run), lab values if any → a run plan, or the list of lab values still missing and the confirmation text | every run ([DEC-I05](#dec-i05)) |
| `bddSuite/coverage` | client → server | the bindings × actions table, with sources | bindings tree / tool windows, *Copy binding table* |
| `bddSuite/choices` | client → server | options for a pick (target binding, lint tool, binding to implement in) | native pickers before `executeCommand` |

Two more messages are outside this core set:

* `bddSuite/testState` exists only for the integration tests (E2). The
  server answers it only when started with `BDD_TEST_SEAM=1`.
* `bddSuite/stepsUsing` (the steps that use an action) is added with the P2
  source-file features (D22).

The server advertises `experimental.bddSuite.protocol: 1` in its
`initialize` result. A client that expects a different major version shows
"Suite Authoring server speaks protocol N; this client speaks M" and stays
inactive, instead of misreading messages.

**Why.** Pickers, dialogs, test trees and tool windows are IDE UI. The LSP has
only coarse equivalents (`showMessageRequest` renders as a notification with
buttons in all three IDEs). Keeping the decision in the server and only the
display in the client keeps the IDEs consistent.

**Tradeoff.** Each client implements six messages. They ship in the same
release ([DEC-I16](#dec-i16)), so the version check guards against stale
installs rather than independent releases.

**Serves.** O1–O5. **Verified by.** E1, E3, E4, E6, E7.

### <a id="dec-i05"></a>DEC-I05. Every IDE runs suites through one run bridge process

**Choice.** A run has two steps.

1. The client sends `bddSuite/prepareRun`. The server answers with a plan
   file: argv, working folder, environment, the binding, lab values, and the
   mapping from trace entries to cases. Alternatively it answers with the lab
   values still missing and the confirmation text.
2. The client then starts `node dist/bridge.js --plan <file> --format
   jsonl|teamcity [--lab-confirmed]`.

The bridge runs the binding's `suiterun` with the existing `runTool` (bounded
output, timeouts, tree kill). It maps the trace with the existing
`core/trace.ts` and writes one event per case as it finishes: JSON lines for
VS Code and Visual Studio, TeamCity service messages for JetBrains. It then
exits with the run's status.

The bridge refuses a lab plan without `--lab-confirmed` and all three lab
values, so INV-6 is enforced in the one program every IDE uses. It kills its
process tree when its standard input closes, when its parent process exits,
or on a stop request. That keeps INV-5 even when an IDE kills only the
bridge.

VS Code's Test Explorer integration (`features/testing.ts`) is rewritten to
use the same two steps and keeps its UI.

**Why.** JetBrains IDEs expect a test run to be a process whose output feeds
the test-runner tree; their stop button and rerun actions work on that
process. Visual Studio's tool window needs the same. A single bridge means
the trace mapping, timeouts and kill rules are written and tested once.

**Tradeoff.** VS Code's runs change from in-process to a child process (one
more process, about 50 ms to start Node.js). The lab prompts stay in each
client, because only the client can show a modal dialog. The bridge checks
that they were answered.

**Serves.** O3, O5, O6. **Verified by.** E4, E7, E9, E10.

### <a id="dec-i06"></a>DEC-I06. The server reads and watches the workspace itself

**Choice.** The server lists and watches files with Node.js (`fs.watch`,
recursive) under each workspace folder, using the same globs as today
(`suiteGlobs`, `exclude`, `bindingSources`). An open document's text from
`didOpen`/`didChange` wins over the disk, as it does today. The server ignores
`workspace/didChangeWatchedFiles`.

**Why.** Visual Studio's client can't register file watches dynamically, and
each IDE watches differently. The binding source files the index reads
(`.cs`, `.go`, `.rs`, `.ps1`, `.ts`) are not documents the IDE sends to this
server.

**Tradeoff.** A second watcher on the same tree as the IDE's own. The existing
`exclude` setting and the index limits (`src/limits.ts`) bound its cost.

**Serves.** O1. **Verified by.** E1, E3, E6.

### <a id="dec-i07"></a>DEC-I07. Visual Studio: a VisualStudio.Extensibility extension, VS 2022 17.14 or later and VS 2026

**Choice.** `clients/visualstudio` is a VisualStudio.Extensibility extension.
It runs out of process on .NET 8, can be installed without restarting Visual
Studio, and uses no in-process VSSDK packages. It contributes:

* a `LanguageServerProvider` that starts `node dist/server.js --stdio`;
* the commands, placed in the Extensions menu and the editor context menu;
* the Suites and Bindings tool windows (Remote UI);
* settings (the VisualStudio.Extensibility settings API);
* an Output window channel;
* the trust prompt.

The minimum version is 17.14, the earliest with inlay hints in the LSP client
and editor classification in VisualStudio.Extensibility. Visual Studio 2026
loads 17.x extensions.

**Why.** It is Microsoft's current extension model, with an LSP provider,
tool windows, commands and settings in one API. The older in-process VSSDK
would be needed only for a Test Explorer adapter, which DEC-I09 rules out.

**Tradeoff.** Some APIs we need (settings, classification) are marked
experimental and may change between Visual Studio releases. Each Visual
Studio minor release is a re-test (E6). Visual Studio 2022 before 17.14 is
not supported.

**Serves.** O4, O5. **Verified by.** E6, E7, E12.

### <a id="dec-i08"></a>DEC-I08. Gaps accepted per IDE, and what replaces each

| Gap | Where | What the user gets instead | Priority to close |
| --- | --- | --- | --- |
| No *Declare* / *Implement in X* lenses | Visual Studio (no LSP CodeLens; the CodeLens API covers only languages Visual Studio already supports) | The same actions as quick fixes (Ctrl+.) on the step, which exist today | not planned |
| No separate *Go to Implementation* | JetBrains, Visual Studio | Go to Definition lists the catalog entry and every binding's implementation ([DEC-I03](#dec-i03)) | not planned |
| No *N suite steps* lens and no suite references from binding source files | JetBrains, Visual Studio. The server attaches only to suites and catalogs ([DEC-I11](#dec-i11)), and attaching an LSP server to C# conflicts with the IDE's own C# service. | Find usages from the catalog entry or a step; the Bindings window | **P2**: a JetBrains code-vision provider and a Visual Studio C# CodeLens provider, both querying the server ([D22](implementation.md#d22)) |
| Status bar | Visual Studio (no status bar API) | Status in the Suites window header and the Output channel; failures as an info bar | not planned |
| Semantic-token colours | Visual Studio, if spike D2 finds custom token modifiers unsupported | A client-side classification tagger that asks the server for the same tokens and colours them with Visual Studio classifications | decided in D2 |
| Inlay hints | Visual Studio, if spike D2 finds them unsupported | Binding list in the step's hover ([DEC-I03](#dec-i03)) | decided in D2 |

**Why.** Each replacement keeps the information available through a path the
IDE supports. None of them changes a finding or a result.

**Serves.** O2, O4. **Verified by.** E3, E6.

### <a id="dec-i09"></a>DEC-I09. Visual Studio runs suites from a Suites tool window, not Test Explorer

**Choice.** A Suites tool window lists folders, suite files, cases and outline
rows from `bddSuite/testItems`. It offers Run, Dry run and Stop, and shows each
case's state, duration, failure message and trace link. Results come from the
run bridge's JSON lines. Double-clicking a case opens it in the editor.

**Why.** Visual Studio's Test Explorer accepts tests only through the
VSTest adapter model: an in-process MEF component, a discoverer and an
executor running inside the test host process, where no UI can be shown. A
lab run's prompts and confirmation (INV-6) can't be shown from there. The
model is built around compiled test containers, and its non-.NET examples
(Chutzpah, Karma adapters) target Visual Studio 2013–2015.

**Tradeoff.** Suites don't appear beside a solution's .NET tests in Test
Explorer, and Test Explorer's playlists and history don't apply. Building an
adapter later remains possible; the bridge and `prepareRun` would serve it
unchanged.

**Serves.** O5. **Verified by.** E7.

### <a id="dec-i10"></a>DEC-I10. JetBrains: a Kotlin plugin on the platform's own LSP API, 2026.1 or later

**Choice.** `clients/jetbrains` is an IntelliJ Platform plugin (Kotlin,
IntelliJ Platform Gradle Plugin 2.x). It uses JetBrains' built-in LSP API with
a minimum platform of 2026.1, the first with CodeLens. The plugin declares
`com.intellij.modules.lsp` and `com.intellij.modules.ultimate`, so it installs
in Rider, GoLand, RustRover, IntelliJ IDEA Ultimate, WebStorm and PyCharm, but
not in the IDEA open-source build or Android Studio.

The fallback is Red Hat's open-source LSP4IJ client. It works in every
JetBrains IDE and supports `implementation` and `workspace/configuration`,
but users must install it too and its semantic tokens are experimental. The
plugin switches to LSP4IJ only if spike D1 finds a blocker in the native API.

**Why.** Rider is a commercial IDE, so the edition limit costs nothing there.
The native API needs no third-party plugin, and from 2026.1 it covers every
LSP message the server sends except `implementation`, which [DEC-I03](#dec-i03)
handles.

**Tradeoff.** JetBrains says the API is still under active development, so
each yearly release is a re-test (E5). JetBrains published "IntelliJ IDEA goes
LSP" in August 2026; it could not be read when this was designed. Spike D1
reads it, because it may widen the API's availability or change this choice.

**Serves.** O2, O3. **Verified by.** E3, E4, E5.

### <a id="dec-i11"></a>DEC-I11. Outside VS Code, suites stay YAML files; the server attaches by file name

**Choice.** Neither the JetBrains plugin nor the Visual Studio extension
defines a new file type or a TextMate grammar.

* **Which files the server serves.** The server is attached to a file when
  its name matches the same patterns VS Code's `bdd-suite` language uses
  (`*suite*.yml`, `*test*.yaml`, ...) or it is the workspace's catalog. In
  JetBrains this is the LSP client's `isSupportedFile`. In Visual Studio it is
  a `DocumentFilter` glob pattern (**spike**).
* **Colouring.** The IDE's own YAML support keeps syntax colouring, folding
  and structure. The server's semantic tokens colour actions, meta steps,
  parameters and captures on top.
* **Non-suites.** As today, the server answers nothing for a matched file that
  is not a suite (no top-level `suite:` and not imported by one).

**Why.** Both IDEs choose a file type, and Visual Studio a TextMate grammar,
by extension. Claiming `.yaml` would take every YAML file away from the YAML
support users rely on (Kubernetes, pipelines). Matching by name keeps them
untouched.

**Tradeoff.** The colours are a layer over YAML colours rather than the
extension's own grammar, so a suite looks slightly different than in VS Code.
The first frame of an opened file shows YAML colours until the tokens arrive.

**Serves.** O2, O4. **Verified by.** E3, E6.

### <a id="dec-i12"></a>DEC-I12. Settings: the workspace's committed `bddSuite.*` values, overridden by the IDE's own settings

**Choice.** The server builds each folder's settings in three layers. Each
layer below overrides the one above it:

1. the defaults (`config/defaults.ts`, unchanged);
2. the `bddSuite.*` keys in the folder's `.vscode/settings.json` (JSON with
   comments), read by the server when the client is not VS Code;
3. what the client sends in `initializationOptions` and
   `workspace/didChangeConfiguration`.

In VS Code, layer 3 is VS Code's own settings, so nothing changes there. In
JetBrains and Visual Studio, layer 3 is a settings page with the per-user
values: target binding, lint tool, inlay and lens toggles, and the lab API
URL, lab id and connection file.

Settings that run code (`bindings`, `schemaGenerator`, `lintTool`) are read
from the workspace file only once the folder is trusted, as VS Code's
`restrictedConfigurations` does today.

**Why.** A workspace's layout (catalog path, binding programs, sources) is
committed once and must mean the same in every IDE. Teams already commit it in
`.vscode/settings.json`. A new file format would split that source of truth.
`workspace/configuration` can't be the channel, because neither the JetBrains
nor the Visual Studio client lists it.

**Tradeoff.** Reading a file named `.vscode` from Rider is surprising, so the
settings pages say where the workspace values come from. A neutral file can be
added later as a fourth layer without changing the others.

**Serves.** O1, O2, O4. **Verified by.** E1, E3, E6.

### <a id="dec-i13"></a>DEC-I13. Node.js: bundled in Visual Studio; found or fetched in JetBrains IDEs

**Choice.** The server, bridge and lint worker need Node.js 20 or later.

* **Visual Studio** (Windows only): the VSIX bundles Node.js for x64 and
  arm64, pinned to an LTS version and recorded in the release notes. That
  adds about 70 MB, and the pinned version is updated with each release.
* **JetBrains IDEs** (three operating systems and two architectures): the
  plugin uses, in order, the `Node.js path` setting, the IDE's configured
  Node.js interpreter when the JavaScript plugin is present, and `node` on
  `PATH` at version 20 or later. If none is found, it offers to download the
  pinned LTS build into the IDE's system folder. The download is verified
  against a SHA-256 hash shipped in the plugin, and nothing runs if the hash
  differs.

**Why.** Visual Studio users can't be assumed to have Node.js, and one OS
keeps the bundle small. A JetBrains plugin with six Node.js builds would be
over 250 MB, and most JetBrains users of the TypeScript binding already have
Node.js.

**Tradeoff.** The JetBrains download needs network access once. Offline users
set the path. A bundled runtime must be patched by releasing the extension.

**Serves.** O2, O4, O7. **Verified by.** E13.

### <a id="dec-i14"></a>DEC-I14. Trust comes from the IDE where it has a concept of trust; Visual Studio gets an explicit grant

**Choice.** The server starts every folder as untrusted and runs no workspace
code until the client sends `bddSuite/trust { trusted: true }` (INV-11, now
enforced in the server's `runTool` and `LintWorkerHost`).

* **VS Code** sends `workspace.isTrusted` and its grant event.
* **The JetBrains plugin** sends the platform's trusted-project state.
* **The Visual Studio extension** asks once per folder: "Suite Authoring runs
  this folder's lint tool, binding programs and schema generator. Trust
  `<folder>`?" The answer is stored in the extension's user settings, keyed by
  the folder's full path. *Not now* leaves completion, hover, navigation and
  index findings working. A *Trust folder* command grants trust later.

**Why.** INV-11 is a promise to the user, and the server is where code is
spawned. Visual Studio has no workspace-trust concept, so without a grant the
extension would either never lint or always run unknown code.

**Tradeoff.** One more prompt in Visual Studio. The grant is per machine and
user, so it is not shared with teammates.

**Serves.** O6. **Verified by.** E8.

### <a id="dec-i15"></a>DEC-I15. JetBrains runs use the platform's test-runner tree, a run configuration and gutter icons

**Choice.** The plugin adds:

* a *BDD Suite* run configuration type: file, optional case, mode, binding
  override;
* a producer that creates it from the context menu;
* gutter run icons on each case and suite file, placed using
  `bddSuite/testItems` ranges;
* a test-runner console fed by the bridge's TeamCity output, with a test
  locator that maps `bddsuite://<file>#<case>` back to the case;
* *Rerun Failed Tests*.

Before starting a lab plan, the plugin shows the confirmation dialog, with the
binding, lab id, API URL and case list, and asks for missing lab values.
*Stop* asks for confirmation on a lab run, as VS Code does (DEC-B12).

**Why.** It is the platform's standard way to integrate a test framework.
Users get the same tree, history, filters and rerun as for JUnit or NUnit
tests.

**Tradeoff.** The test locator is thinly documented, so D13 budgets time to
get navigation right.

**Serves.** O3, O6. **Verified by.** E4, E9, E10.

### <a id="dec-i16"></a>DEC-I16. One version, one release, three packages

**Choice.** The VS Code VSIX, the Visual Studio VSIX and the JetBrains plugin
ZIP carry the version in `package.json`. They are built from one commit by
one CI workflow and published by the release job: VS Code Marketplace, Visual
Studio Marketplace and JetBrains Marketplace. Each package carries its own
copy of `dist/server.js`, `dist/bridge.js` and `dist/lintWorker.js`. The
JetBrains build runs the Plugin Verifier against each IDE in
[DEC-I10](#dec-i10) for the supported platform range.

**Why.** A server and its client always come from the same commit, so the
protocol check ([DEC-I04](#dec-i04)) is a safety net, not a compatibility
matrix.

**Tradeoff.** A fix to one IDE's client releases all three. Releases are
cheap and the runtimes are versioned the same way (self-contained DEC-S09).

**Serves.** O7. **Verified by.** E12.

### <a id="dec-i17"></a>DEC-I17. Proof is layered: the server headless, then each real IDE, then the lab

**Choice.** Three layers of evidence, kept separate:

1. **Server protocol suite.** A test client talks LSP over standard input and
   output to `dist/server.js` against `samples/workspace` and the five built
   runtimes, and checks every message in the section 2 table. Most
   correctness is proved here, once, for all IDEs.
2. **Real-IDE end-to-end tests.**
   * VS Code: the existing integration suite.
   * JetBrains: the IntelliJ IDE Starter and Driver framework, driving a real
     Rider (and smoke runs of GoLand, RustRover, IDEA Ultimate) on Windows
     and Linux.
   * Visual Studio: the Visual Studio extension testing harness, driving a
     real Visual Studio 2022 17.14 and Visual Studio 2026 on Windows.

   These prove each client's wiring and UI. Mocks or a stubbed IDE do not
   count for this layer.
3. **Remote lab acceptance.** A lab run from Rider and from Visual Studio
   against a real lab (E10). Lab behaviour depends on the lab, so only this
   counts for it.

**Why.** IDE automation is slow and flaky. Putting the logic proof in the
headless suite keeps the IDE tests few and focused on what only they can
show.

**Tradeoff.** CI needs Windows runners with Visual Studio 2022 and 2026
installed. Spike D2 records whether GitHub-hosted images suffice or a
self-hosted runner is needed.

**Serves.** O1–O7. **Verified by.** all scenarios.

### <a id="dec-i18"></a>DEC-I18. Order: shared server and VS Code first, then JetBrains, then Visual Studio

**Choice.** Build in this order, each step depending on the one before it:

1. the spikes;
2. the server, the bridge and their protocol suite;
3. VS Code on the server, released on its own;
4. the JetBrains plugin;
5. the Visual Studio extension.

The two IDE clients don't depend on each other. With two people they can be
built in parallel after step 3.

**Why.** VS Code's release proves the server on real users before a new IDE
depends on it. JetBrains comes before Visual Studio because it fits better:
CodeLens, a test-runner tree and trust all exist there. It reaches more
binding authors (Rider, GoLand, RustRover), and it carries less risk.

**Tradeoff.** Visual Studio users wait longest. If they are the priority, the
order of steps 4 and 5 can swap; nothing in steps 1–3 changes.

**Serves.** O1–O5. **Verified by.** stage exit evidence in the plan.

## 5. Failure, rollback and cleanup

**What the extension owns.** The extension owns only processes and files it
creates:

* the server, bridge, lint worker and `suiterun` children;
* run plan files in the IDE's storage folder for the extension;
* a downloaded Node.js in the JetBrains system folder;
* the Visual Studio trust grants in its settings.

It doesn't own lab resources. Those are created and cleaned up by the
binding's lab actions, which this work doesn't change.

| What fails | What happens | What is left behind |
| --- | --- | --- |
| The server crashes or hangs | The client restarts it, at most three times in three minutes. After that it shows "Suite Authoring server stopped" with a *Restart server* command. Diagnostics from the dead server are cleared, never left stale. | Nothing: the server's children (lint tools, worker) die with it, because `runTool` kills trees and the worker is a thread. |
| A lint tool times out or fails | As today: the newest lint publishes or marks the previous result stale (INV-3, INV-4), and the status says why. | Nothing (INV-5). |
| The user stops a run | The client closes the bridge's input and then kills it. The bridge kills `suiterun`'s tree. A lab run asks *Stop?* first and, once stopped, reports which cases had not finished, as VS Code does (DEC-B12). | Lab state is whatever the binding's actions left. The run's partial trace and output are kept in the result. |
| The IDE closes during a run | The bridge sees its input close or its parent exit and kills its tree. | As above. |
| A scaffolding edit is wrong | One undo reverts it (INV-8). The regenerated schema is regenerated again on the next catalog edit, not undone. | Nothing beyond the edited files. |
| A Node.js download fails or its hash differs | Nothing runs. The plugin says which check failed and offers the path setting. | The partial download is deleted. |
| A release regresses | Users reinstall the previous version from the marketplace. There is no data migration to undo: settings keys are unchanged. | Nothing. |
| Uninstall | The IDE removes the package. | Plan files in the IDE's extension storage folder (deleted by the IDE in VS Code and JetBrains; listed for manual removal in Visual Studio), the downloaded Node.js (the plugin's *Remove downloaded Node.js* action), and the Visual Studio trust grants (removed with the extension's settings). |

## 6. Verification

Every scenario records the source commit, package versions, IDE name and build
number, OS, Node.js version, exact commands, results and cleanup, in
`docs/evidence/ide-ports-<stage>.md`. A skipped, blocked or failed scenario
stays open. Evidence from one layer ([DEC-I17](#dec-i17)) doesn't count for
another: a server protocol pass doesn't prove an IDE scenario, and no local
run proves E10. The guarantee is limited to the tested builds, IDEs,
operating systems and workspace. It doesn't cover untested IDE versions.

### <a id="e1"></a>E1. The server answers every feature correctly over LSP (headless)

* **Given** `dist/server.js` and `dist/bridge.js` built from the tested
  commit, `samples/workspace` with the five runtimes built, and a test
  client that speaks LSP over standard input and output. The client is
  configured three times, with the capabilities VS Code, JetBrains and Visual
  Studio advertise (captured in spikes D1 and D2).
* **When** the test client opens, edits and saves suites and the catalog, sets
  trust false then true, and sends every request in the section 2 table plus
  the six custom messages.
* **Then** each answer equals what VS Code shows today for the same input:
  * the same findings, ranges and codes as the five runtimes report;
  * the same completions, hovers, definition and reference targets;
  * the same token types and modifiers, hints and code actions.

  With a client that lacks `implementation`, `codeLens` or `inlayHint`, the
  answers adapt as [DEC-I03](#dec-i03) says. While untrusted, nothing is
  spawned (checked by a process-spawn log). `prepareRun` refuses to plan a lab
  run without lab values, and the bridge refuses a lab plan without
  `--lab-confirmed`. A client advertising protocol 2 is refused with the
  message of [DEC-I04](#dec-i04).
* **Cleanup.** The suite restores the files it edited; `git status` is clean.

### <a id="e2"></a>E2. VS Code behaves as before, on the server

* **Given** the VS Code VSIX from the tested commit, `samples/workspace`, the
  five runtimes, and the integration suite from the commit before the
  server's introduction. Its assertions are unchanged. What changes is how it
  reads internal state:
  * about 120 reads of `TestApi` fields that move into the server
    (`indexers`, `controllers`, `lintWorker`, `children`) go through a
    test-only request, `bddSuite/testState`;
  * the server answers that request only when started with
    `BDD_TEST_SEAM=1`;
  * the diff of the test folder is recorded in the evidence, and it may touch
    only those reads.
* **When** `npm run test:integration` runs locally and in CI, and the latency
  checks run.
* **Then** every scenario passes, including the following:
  * lint parity across bindings;
  * run, dry run and lab-run confirmation (with the fake lab runner);
  * cancellation that leaves no child process;
  * scaffolding with one undo;
  * the trust seam;
  * live lint while typing.

  Latency stays within the budgets the suite already enforces.
* **Cleanup.** The suite's own restores; `git status` is clean.

### <a id="e3"></a>E3. Rider: authoring

* **Given** Rider 2026.1 or later (latest stable, recorded by build number)
  on Windows and on Linux, with a clean configuration folder and the plugin
  ZIP from the tested commit. `samples/workspace` is opened as a trusted
  project, Node.js is on `PATH`, and the five runtimes are built.
* **When** the IDE Starter/Driver test does the following:
  1. opens a suite;
  2. types a step with an undeclared action;
  3. waits;
  4. opens completion after `action:`;
  5. hovers an action;
  6. presses Go to Definition;
  7. runs Find Usages on a catalog action;
  8. applies *Declare action* from Alt+Enter;
  9. clicks an *Implement in Go* lens;
  10. opens the Bindings tool window;
  11. runs each of the nine actions from Find Action.
* **Then** each step shows the following:
  * the undeclared action is underlined and listed in Problems with the same
    code and range as E1;
  * completion offers the catalog's actions and the core's;
  * hover shows the action's description and bindings;
  * definition offers the catalog entry and each implementing binding's
    registration;
  * Find Usages lists every step that uses it;
  * implemented and unimplemented actions get different colours, and those
    colours are editable under *Color Scheme › BDD Suite*;
  * binding hints are visible after steps;
  * *Declare* and *Implement* edit the catalog and the Go source as in VS
    Code, and the schema generator runs;
  * the Bindings window matches `bddSuite/coverage`;
  * a `.yaml` file that is not a suite keeps plain YAML support with no
    server findings.
* **Cleanup.** The test restores `samples/workspace` (`git checkout`) and
  deletes its Rider configuration and system folders.

### <a id="e4"></a>E4. Rider: runs

* **Given** E3's setup, and a suite with one passing case, one failing case
  and one case that sleeps until killed (the fake tool), for the C# and Go
  bindings.
* **When** the test does the following:
  1. runs the file from the gutter;
  2. reruns the failed cases;
  3. dry-runs one case from its gutter icon;
  4. starts the sleeping case and presses Stop;
  5. opens the case from the test tree.
* **Then** the tree shows one node per case with the same status and failure
  message the bridge's JSON mode reports for the same plan. *Rerun Failed*
  runs only the failing case. The dry run reports without executing actions,
  as VS Code does. After Stop, no `suiterun` or bridge process remains,
  checked by process list within 5 seconds. Navigation opens the case's
  line.
* **Cleanup.** None beyond E3's.

### <a id="e5"></a>E5. The plugin works in the other JetBrains IDEs

* **Given** the latest stable GoLand, RustRover, IntelliJ IDEA Ultimate and
  WebStorm at or above 2026.1, on Linux, with the plugin ZIP from the tested
  commit.
* **When** a short Driver test opens `samples/workspace`, introduces an
  undeclared action, requests completion and runs one case. Separately, the
  Plugin Verifier runs against each IDE's earliest and latest supported
  builds.
* **Then** the finding, completion and the case's result appear as in E3 and
  E4. The verifier reports no compatibility problems. Installing into the
  IDEA open-source build is refused by the IDE because the plugin declares
  the module dependency it lacks.
* **Cleanup.** The test deletes each IDE's configuration and system folders.

### <a id="e6"></a>E6. Visual Studio: authoring

* **Given** Visual Studio 2022 17.14 (latest servicing) and Visual Studio
  2026 (latest), on Windows x64, with the VSIX from the tested commit. Node.js
  is not on `PATH`, to prove the bundled runtime is used. The folder is
  `samples/workspace`, opened two ways: with *Open Folder*, and through a
  `.sln` that includes the C# binding's projects. Trust is granted.
* **When** the extension test harness does E3's steps 1–8 and 10–11, with
  Ctrl+. for quick fixes, F12 for definition, Find All References and the
  commands from the Extensions menu.
* **Then** E3's assertions hold, except the gaps of
  [DEC-I08](#dec-i08):
  * no lenses are shown, and the quick fixes offer the same actions;
  * definition lists implementations.

  Colours and binding hints appear as decided by spike D2 (semantic tokens
  or the client tagger; inlay hints or hover). All of this holds in both
  folder modes and both Visual Studio versions.
* **Cleanup.** The harness resets `samples/workspace` and the experimental
  instance's settings.

### <a id="e7"></a>E7. Visual Studio: runs

* **Given** E6's setup and E4's suite.
* **When** the test runs the file from the Suites window, dry-runs one case,
  starts the sleeping case and presses Stop, and double-clicks a case.
* **Then** the window shows each case's status, message and duration as the
  bridge's JSON mode reports them. After Stop, no `suiterun` or bridge
  process remains within 5 seconds. Double-click opens the case's line.
* **Cleanup.** As E6.

### <a id="e8"></a>E8. Trust gates workspace code in Rider and Visual Studio

* **Given** `samples/workspace` freshly cloned to a new path, not trusted.
  In Rider, opened in safe mode. In Visual Studio, *Not now* is answered to
  the trust prompt.
* **When** a suite is opened and edited, a run is attempted, and *Build lint
  tool* is invoked. Trust is then granted (Rider's *Trust project*; Visual
  Studio's *Trust folder*).
* **Then** before the grant, the following holds:
  * index findings, completion, hover and navigation work;
  * no process is spawned (the server's spawn log is empty) and no worker is
    started;
  * the status says lint and run are disabled;
  * run and build are refused with that reason.

  After the grant, open suites are linted with no reload or restart. In
  Visual Studio, the grant survives a restart and does not apply to another
  folder.
* **Cleanup.** Delete the clone; remove the Visual Studio grant through the
  extension's settings.

### <a id="e9"></a>E9. No process outlives its request (INV-5) in Rider and Visual Studio

* **Given** E4's and E7's setups.
* **When**, in each IDE:
  1. a long-running case is started, then the IDE is closed;
  2. a live lint is in progress when the server process is killed from Task
     Manager or `kill`;
  3. the server is killed four times within three minutes.
* **Then** within 5 seconds of each step, no `suiterun`, bridge or lint tool
  process remains. After the first three server kills, the client restarts
  the server and diagnostics return. After the fourth, the client shows the
  stopped state with *Restart server*, and the old diagnostics are cleared.
* **Cleanup.** Reopen the IDE; nothing else.

### <a id="e10"></a>E10. A lab run from Rider and from Visual Studio (remote, against a real lab)

* **Given** a real lab, reachable through os-context's documented jump path
  from a controller machine. The controller has Rider and Visual Studio with
  the tested packages, and an os-context worktree that consumes this
  repository's runtimes. The lab's API URL and lab id are entered at run time
  and its connection file is supplied at run time, not committed. The suite is
  os-context's portable stage 0 lab suite under one binding. The same suite was
  run from VS Code beforehand as the reference.
* **When**, in each IDE, the lab suite is run with the lab values unset. The
  prompts are answered. The confirmation is first cancelled, then accepted.
  A second run is started and stopped mid-case, with *Stop* confirmed.
* **Then**:
  * the prompts ask for exactly the missing values;
  * the confirmation lists the binding, lab id, API URL and cases;
  * cancelling starts nothing (no bridge process, no lab call in the lab's
    log);
  * the accepted run's per-case results equal the VS Code reference;
  * the stopped run reports which cases had not finished;
  * os-context's cleanup leaves the lab at its baseline (its own evidence);
  * no lab value is written to any file except the settings the user chose
    to save (INV-7).
* **Cleanup.** os-context's teardown. If it fails, the run's evidence and the
  lab state are kept, and the scenario stays open.

### <a id="e11"></a>E11. Scaffolding is one undo in each IDE (INV-8)

* **Given** `samples/workspace` in VS Code, Rider and Visual Studio, trusted.
* **When** *Declare action* and *Implement action* (Go and C#) run from a step,
  and then Undo is pressed once in the IDE.
* **Then** each command's edits (catalog, binding source, new file if any)
  are applied together. One Undo reverts all of them. The schema generator
  ran after the catalog edit. If an IDE applies a multi-file `applyEdit` as
  several undo steps, the scenario fails, and the client wraps the edit in
  one undo unit before the scenario can pass.
* **Cleanup.** `git checkout samples/workspace`.

### <a id="e12"></a>E12. One release installs everywhere, with one version

* **Given** a release built by CI from a tagged commit.
* **When** each package is installed from the file into a clean IDE: the VS
  Code VSIX, the Visual Studio VSIX into 17.14 and 2026, and the plugin ZIP
  into Rider. Each is then upgraded from the previous release, and finally
  uninstalled.
* **Then** all three report the same version and carry byte-identical
  `server.js`, `bridge.js` and `lintWorker.js` (hash compared). Install and
  upgrade need no manual steps beyond the IDE's own. After uninstall, only
  the leftovers listed in section 5 remain. The marketplace uploads pass
  their validators (VS Marketplace, JetBrains Plugin Verifier).
* **Cleanup.** Uninstall; delete the listed leftovers.

### <a id="e13"></a>E13. Node.js is found, fetched or refused correctly

* **Given** Rider on Windows and Linux with no `node` on `PATH` and no
  JavaScript plugin. Visual Studio with no Node.js installed.
* **When**:
  1. Rider opens `samples/workspace`;
  2. the download offer is accepted;
  3. the test repeats with the plugin's expected hash altered;
  4. the test repeats with `Node.js path` set to a Node.js 18 binary.

  Visual Studio opens the same folder.
* **Then**:
  * the offer appears before anything runs;
  * the download is verified and used, and the server starts;
  * the altered hash is refused, nothing runs, and the partial file is
    deleted;
  * Node.js 18 is refused with "needs Node.js 20 or later";
  * Visual Studio uses its bundled Node.js with no prompt.
* **Cleanup.** *Remove downloaded Node.js*; reset the setting.

### <a id="e14"></a>E14. Binding source files show their suite steps (P2, JetBrains and Visual Studio)

* **Given** D22 built. `samples/workspace` is open in Rider and GoLand, with
  the C# and Go bindings' sources, and in Visual Studio with the C# binding's
  sources.
* **When** a registration of an action used by three steps, and one used by
  none, is opened in each IDE. Then the step count is clicked.
* **Then** above the first registration the IDE shows *3 suite steps*; above
  the second, *no suite steps*. The click lists the three steps, as VS Code's
  lens does today. The IDE's own C# and Go features (completion, Roslyn or
  ReSharper findings) are unaffected: their findings for the file are the
  same with and without the plugin.
* **Cleanup.** None.

## 7. Traceability

| Outcome | Decisions | Deliverables | Scenarios |
| --- | --- | --- | --- |
| O1 | DEC-I01, DEC-I02, DEC-I03, DEC-I04, DEC-I06, DEC-I12, DEC-I17, DEC-I18 | D3–D10 | E1, E2 |
| O2 | DEC-I03, DEC-I04, DEC-I08, DEC-I10, DEC-I11, DEC-I12, DEC-I13 | D1, D11, D12, D14 | E3, E5, E11 |
| O3 | DEC-I05, DEC-I10, DEC-I15 | D8, D13 | E4, E9 |
| O4 | DEC-I03, DEC-I04, DEC-I07, DEC-I08, DEC-I11, DEC-I12, DEC-I13 | D2, D16, D17, D19 | E6, E11 |
| O5 | DEC-I05, DEC-I07, DEC-I09 | D8, D18 | E7, E9 |
| O6 | DEC-I05, DEC-I14, DEC-I15 | D3, D6, D8, D11, D13, D16, D18 | E8, E9, E10, E11 |
| O7 | DEC-I13, DEC-I16, DEC-I17 | D15, D20, D21 | E12, E13 |

D22 (source-file lens and references in JetBrains and Visual Studio) is P2.
It closes the gap DEC-I08 records and is proved by [E14](#e14). No outcome
above depends on it: O2 and O4 are complete without it.
