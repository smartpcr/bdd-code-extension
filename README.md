# Suite Authoring

A VS Code extension for writing the os-context YAML test suites
(`test/e2e/suites/*.yml`). It knows the action catalog
(`test/e2e/schema/actions.catalog.yaml`) and the five bindings that run the
suites (PowerShell, C#, Go, Rust and TypeScript), and gives you:

* **Navigation and hover.** Go to Definition on an action opens its catalog
  entry and every binding's registration; hover lists which bindings implement
  it; a meta step opens its definition.
* **Lint.** The findings `suiterun lint` reports (`E1xx` to `E3xx`, `W3xx`),
  in the editor, at the right line and column. Lint uses one binding's own code,
  so what you see is what CI sees.
* **Completion** of actions, parameters, `meta:` names and `${...}` references,
  limited to what is in scope. An action shows which bindings implement it and
  which do not, and choosing one inserts its required parameters.
* **Assistance** above each step whose action some language lacks: a CodeLens
  naming where it is missing, with *Implement in C#*, *Go* or *Rust* to generate
  the registration and method stub, or *Declare action* when the catalog does
  not have it.
* **Scaffolding.** Declare a new action in the catalog from a step that uses it,
  and add a stub registration to a binding.
* **A binding table** (the *Suite bindings* view): what each binding declares
  and registers, and any drift between them.
* **Test Explorer.** Every suite, case and outline row is a test item; run or
  dry-run them under a binding. Lab suites ask for confirmation first.

The extension activates in a folder that contains
`test/e2e/schema/actions.catalog.yaml`, and does nothing elsewhere.

## Install

From the Visual Studio Marketplace: search for **Suite Authoring** in the
Extensions view, or

```powershell
code --install-extension asz.bdd-suite
```

Or from a GitHub release
(https://github.com/smartpcr/bdd-code-extension/releases): download
`bdd-suite-<version>.vsix`, check it against the SHA-256 in
`bdd-suite-<version>.vsix.sha256` beside it, and install it with
`code --install-extension bdd-suite-<version>.vsix`.

A window that is already open keeps running the version it loaded until it
reloads; VS Code never swaps a running extension's code. When a newer copy is
installed, the extension says so: a **Reload for Suite Authoring &lt;version&gt;**
button in the status bar, and a notification, reload the window to load it.

It needs:

* **VS Code 1.95 or later.**
* **No other extension.** The extension checks suites against the schema
  itself, in the BDD Suite language mode and in plain YAML mode. (Before 0.3.0
  it required a YAML extension, and disabling that disabled this one too. If
  one is installed and enabled, it is left to check plain-YAML files, so
  nothing is reported twice.)
* **An os-context checkout** with the binding you lint with built (below).
* **A trusted workspace.** In an untrusted folder, navigation, hover and
  completion work, but lint, runs, builds and schema generation are disabled,
  because each of them runs code from the folder.

To build it from source, see [Build, test and release](#build-test-and-release).

## The BDD Suite language mode

A suite is YAML, and a `.yml` file can be opened as plain YAML or as a **BDD
Suite** (Change Language Mode, or the language name in the status bar).

* A `.yml`/`.yaml` file whose **name contains `suite`, `feature` or `test`**
  opens as a BDD Suite. To make a folder's files open that way too, map it in
  your settings, e.g. `"files.associations": { "**/test/e2e/suites/**/*.yml": "bdd-suite" }`.
* In BDD Suite mode the extension **enforces the suite schema** (the
  workspace's generated `suite.schema.json`, beside the catalog) while you
  type: a missing required parameter, a parameter the action does not take, a
  wrong type, an unknown action. Findings are marked `bdd-suite schema`
  (`BDD060`). It also completes a step's keys from the schema, the action's
  required parameters first.
* **Highlighting** adds what a YAML grammar cannot know: Gherkin keys and
  `${...}` expressions are coloured by the grammar, and the extension colours
  each action by where it is implemented (italic when the target binding lacks
  it, underlined when no binding has it, red when the catalog does not declare
  it), each parameter by its action (bold when required, red and struck out
  when the action does not take it), schema keys apart from parameters, and
  meta steps. The styles are defaults under
  `editor.semanticTokenColorCustomizations`, which you can override.
* In plain YAML mode a suite (a file with a top-level `suite:` key, or one a
  suite imports) gets the same schema check and key completion, without the
  highlighting. Every other feature (navigation, hover, lint, completion, the
  CodeLens, code generation) works in both modes.

## Lint tools and how to build them

`bddSuite.lintTool` chooses whose code lints; `bddSuite.targetBinding` chooses
which binding the suites are meant to run with, so `E201` reports the actions
*that* binding does not implement. They are separate on purpose: you can lint
with the fastest tool while targeting PowerShell.

| Lint tool | How it lints | Build it (from the os-context checkout) | Needs |
| --- | --- | --- | --- |
| `typescript` (default) | In-process, in a worker thread, on open, on save **and on every pause in typing**, including unsaved text | `cd test/e2e/bindings/typescript; npm ci; npm run build` | Node.js 24 and npm |
| `go` | `suiterun lint` on the saved file | `cd test/e2e/bindings/go; go build -o <storage>/go/suiterun.exe ./cmd/suiterun` | Go 1.24 |
| `rust` | as Go | `cd test/e2e/bindings/rust; cargo build` | Rust (stable) |
| `csharp` | as Go | `cd test/e2e/bindings/dotnet; dotnet build Hci.E2E.Suite.sln` | .NET 10 SDK |
| `powershell` | `Invoke-SuiteLint` on the saved file | nothing | PowerShell 7 with `powershell-yaml` |

The command **Suite: Build lint tool** runs the build for the current lint tool
and shows its output. When the lint tool is not built, the status bar says so
and offers that command; the extension never switches tools by itself.

**When lint runs (DEC-B03).** A program tool (Go, Rust, C#, PowerShell) lints
the file on disk when it is opened and each time it is saved. Between saves,
`E2xx` and `E3xx` findings describe the saved file and may sit on lines that
have since moved; the next save replaces them. While you type, the schema
check still covers the structure. The TypeScript tool has no such
gap: it lints the editor's text about 0.4 s after you stop typing, with imports
resolved from the file's real location, and never writes the unsaved text to
disk.

When a lint fails (the tool is missing, slow, broken or prints something that
is not diagnostics), the status bar names the failure, the output channel
*Suite Authoring* has the details, and the previous findings stay, marked
`[stale]`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `bddSuite.lintTool` | `typescript` | The binding whose code lints suites |
| `bddSuite.targetBinding` | `powershell` | The binding suites are meant to run with; lint reports the actions it does not implement (`E201`) |
| `bddSuite.catalogPath` | `test/e2e/schema/actions.catalog.yaml` | The action catalog, relative to the workspace folder |
| `bddSuite.suiteGlobs` | `["test/e2e/**/*.yml"]` | Candidate suite files; a file is a suite when it has a top-level `suite:` key or is imported by one |
| `bddSuite.exclude` | `**/{node_modules,bin,obj,target,artifacts,.git}/**` | Files never indexed |
| `bddSuite.bindings` | the five bindings | Per binding: source globs, the patterns that find registrations, the program, its build command and (TypeScript) its library |
| `bddSuite.schemaGenerator` | `pwsh ... Build-Schema.ps1` | Regenerates `suite.schema.json` after a catalog edit |
| `bddSuite.inlayHints.bindings` | `true` | Show which bindings implement each step's action |
| `bddSuite.codeLens.implement` | `true` | Above a step whose action is missing in a language: where, with *Implement in C#/Go/Rust* (or *Declare action* when the catalog lacks it) one click away |
| `bddSuite.templatesDir` | empty | A workspace directory whose files override the stub templates |
| `bddSuite.lab.apiUrl` | empty | The lifecycle API URL for lab runs; asked for when empty |
| `bddSuite.lab.labId` | empty | The lab's lineage id (32 hex characters) for lab runs; asked for when empty |
| `bddSuite.lab.connectionFile` | empty | The lab connection file for lab runs; asked for when empty |
| `bddSuite.offlineActions` | `["core.*", "wait"]` | Actions that run without a lab, as names or `prefix.*`; a suite using any other action is a lab suite |

`bindings`, `lintTool` and `schemaGenerator` choose code that runs, so VS Code
ignores their workspace values in an untrusted folder. The extension stores no
credential: a lab run reads the connection file you name, each time.

## Commands

*Suite: Build lint tool*, *Choose lint tool...*, *Choose target binding...*,
*Configure lint...*, *Show actions implemented by binding...*, *Declare action*,
*Implement action in binding...*, *Verify with binding programs*, *Copy binding
table*.

## Running suites

In Test Explorer, *Run* runs a suite under the target binding and shows each
case's result from the run's trace; *Dry run* lists what would run without
starting an action. A suite that uses any action outside
`bddSuite.offlineActions` (os-context's `core.*` and `wait` by default) is a
lab suite: the extension asks for any missing lab setting and shows the binding, lab, API and
the cases that will run before anything starts. *Stop* works at every point:
while a run waits on a question or the confirmation it ends at once and starts
nothing; once a lab suite has started, it asks whether to stop the run, because
stopping may leave lab state half done. A run has no timeout
of its own; the suite's limits apply. A run whose runner is missing (the
PowerShell runner `scripts/e2e/Invoke-LabTestSuite.ps1`, or the target
binding's program) fails at once with that path, before asking anything; the
*Suite Authoring* output channel logs each step a run waits on.

## A self-contained demo

`npm run test:demo` (in the source repository) installs the `.vsix` into a fresh
VS Code profile, opens a small workspace of its own, and walks through it. The
workspace has two suites (`demo.yml`, and `orders.yml`, which imports the
library `_lib/orders-steps.yml`), an action catalog, and actions implemented in
PowerShell, C#, Go, Rust and TypeScript. The demo shows:

* **YAML to code:** Go to Definition (F12, or Ctrl+click) on a step's action
  opens its catalog entry and each language's handler: the C# method, the Go
  `func`, the Rust `fn`, the TypeScript `function` (PowerShell's handler is the
  inline script block of its registration). Go to Implementations (Ctrl+F12)
  lists the registration lines. Hover lists who implements it.
* **Code to YAML:** Find References (Shift+F12) on a registration, or on the
  handler's own declaration (the C# method name), lists the steps that use the
  action, and a CodeLens above each says how many there are.
* **Validation and IntelliSense while typing:** the demo's generator writes a
  per-action schema, so `demo.greet` without its required `name` is underlined
  ("Missing property "name""), as are a parameter the action does not take and
  a wrong type; its stand-in lint reports the same as `E102`, `E105` and
  `E103` on open and save. Parameters complete with their descriptions.
* **C# code generation:** the lightbulb on a declared action's step offers
  *Implement ... in C#*, which adds the registration and a method stub; a step
  using an undeclared action gets `E104`, whose quick fix declares it first.
  Navigation then reaches the generated method, and back.
* **Running from Test Explorer:** *Run* on `demo.yml` passes the cases whose
  actions PowerShell implements and fails `says-farewell` at the step whose
  action it lacks. *Run* on one case runs only that case. The workspace's
  runner is a stand-in that touches no lab, and its settings list the demo's
  actions in `bddSuite.offlineActions`, so a run asks nothing.

It needs no os-context checkout and no binding built. `DEMO_KEEP=1` keeps the
workspace so you can open the generated code; `--vsix <path>` tests another
package.

To try it by hand, `npm run demo:workspace` copies the demo workspace to
`%TEMP%\bdd-suite-demo` (or a folder you name; `--open` opens it in VS Code)
and prints what to try.

## Build, test and release

From the source repository, with Node.js 24:

| Command | What it does |
| --- | --- |
| `npm ci` | Installs the build and test tools |
| `npm run compile` | Type-checks and bundles `dist/extension.js` and `dist/lintWorker.js` |
| `npm run test:unit` | Unit tests; fails below 100% coverage of `src/core`, `src/config` and `src/tools` |
| `npm run package` | Writes `bdd-suite-<version>.vsix` and its `.sha256`, and checks that the archive holds only the built extension |
| `npm run test:demo` | Installs that `.vsix` into a fresh VS Code profile and drives the self-contained demo (above) |
| `npm run test:integration` | The integration suite; needs an os-context checkout (`OS_CONTEXT_ROOT`) |
| `npm run install:local` | Packages and installs into your own VS Code; open windows offer the reload |

**Continuous integration** (`.github/workflows/ci.yml`) runs `npm ci`, the
unit tests, `npm run package` and the demo on Windows for every push to `main`
and every pull request, and keeps the `.vsix` and its `.sha256` as the run's
`vsix` artifact. The integration suite is not run there, because it needs an
os-context checkout.

**Releasing is automatic.** Bump the version and push it to `main`:

```powershell
npm version patch --no-git-tag-version   # or minor / major; edits package.json and package-lock.json
git commit -am "release 0.4.3"
git push origin main
```

When that push's build passes and no tag `v<version>` exists yet, the same CI
run releases the very `.vsix` it built and tested: it publishes it to the
Visual Studio Marketplace, then creates the GitHub release `v<version>` (and
with it the tag) with the `.vsix`, its `.sha256` and generated release notes.
A push that keeps the version only builds and tests, and a pull request never
releases.

It needs, once:

* a Marketplace publisher whose ID is `publisher` in `package.json`
  (`asz`), created at https://marketplace.visualstudio.com/manage;
* the repository secret **`VSCE_PAT`**: an Azure DevOps personal access token
  for that publisher, organization *All accessible organizations*, scope
  *Marketplace → Manage*;
* a repository environment named **`marketplace`**. The release job runs in
  it, so required reviewers set there approve each release before anything is
  published.

Without the secret the release job fails with "VSCE_PAT is not set" and
publishes nothing; the build and its `vsix` artifact are unaffected.

Re-running a failed release is safe: a version already on the Marketplace is
skipped, and an existing GitHub release gets its files replaced.

## Design and plan

In the source repository (not in the package): `docs/design.md`,
`docs/implementation.md`, and the evidence for each stage under
`docs/evidence/`.
