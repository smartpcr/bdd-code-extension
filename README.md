# Suite Authoring

A VS Code extension for writing **BDD-style test suites in YAML** whose steps
call **actions implemented in several languages**. You describe behaviour as
Given/When/Then steps; each step names an action; and the same action can be
implemented by bindings in PowerShell, C#, Go, Rust and TypeScript, so one suite
runs under any of them. The extension keeps the YAML and the code connected
while you write both:

* **Navigation and hover.** Go to Definition on a step's action opens its
  catalog entry and each language's handler; Find References on a handler lists
  the steps that use it; hover lists which bindings implement the action; a
  meta step opens its definition.
* **Validation and IntelliSense while you type.** Missing required parameters,
  parameters an action does not take, wrong types and unknown actions are
  underlined; actions, parameters, `meta:` names, `${...}` references and an
  assertion's `var:` subject (a capture, then its fields) complete, limited to
  what is in scope. Choosing an action inserts its
  required parameters and shows which bindings implement it.
* **Lint.** A binding's own lint (`E1xx` to `E3xx`, `W3xx`) in the editor, at
  the right line and column, so what you see is what CI sees.
* **Assistance and code generation.** Above a step whose action some language
  lacks, a CodeLens says where it is missing and offers *Implement in C#*, *Go*
  or *Rust* (a registration and a method stub), or *Declare action* when the
  catalog does not have it yet.
* **A binding table** (the *Suite bindings* view): what each binding declares
  and registers, and any drift between them.
* **Test Explorer.** Every suite, case and outline row is a test item; run or
  dry-run them under a binding.
* **A BDD Suite language mode** with highlighting that knows the catalog.

## How it fits together

| Term | What it is |
| --- | --- |
| **Suite** | A YAML file with a top-level `suite:` key and a list of `tests:` (cases). Each case is a list of steps. |
| **Step** | One Given/When/Then line: a sentence for the reader (`given: a greeting for the world`), the **action** that does the work (`action: demo.greet`), and the action's parameters (`name: world`). |
| **Action** | A named operation, such as `demo.greet` or `orders.ship`. Suites only name actions; bindings implement them. |
| **Action catalog** | One YAML file (`actions.catalog.yaml`) that declares every action: its parameters with their types, what it returns, and which bindings implement it. It is the shared vocabulary between suite writers and binding authors. |
| **Binding** | The code in one language that implements actions and runs suites: a registration per action (`Register-LabAction -Name 'demo.greet'`, `["demo.greet"] = DemoGreet`, ...) and a program that lints, lists and runs a suite. |
| **Meta step** | A named group of steps, defined in a suite or an imported library (`metaSteps:`), used like one step (`- meta: place-order`). |
| **Suite schema** | `suite.schema.json`, generated from the catalog, which checks each step's parameters against its own action. |

A small example, from the demo workspace in this repository:

```yaml
suite: demo
tests:
  - name: greets-and-counts
    steps:
      - given: a greeting for the world
        action: demo.greet        # declared in the catalog, implemented in 5 languages
        name: world               # a required parameter of demo.greet
        captureAs: greeting
      - when: counting to three
        action: demo.count        # implemented in PowerShell and Go only
        to: 3
```

Two settings choose which bindings matter: **`bddSuite.targetBinding`** is the
binding your suites are meant to run with (lint reports the actions it does not
implement, `E201`), and **`bddSuite.lintTool`** is the binding whose code lints
(you can lint with the fastest one while targeting another).

**No binding of your own needed to lint.** The extension carries the
TypeScript runtime of its own version: while the workspace has no TypeScript
binding library (the default lint tool's), it lints with that, as you type,
and the status bar says *lint bundled runtime*. It checks the format; the
target-binding check (`E201`) needs a binding's own program. It also carries
the core catalog, so a catalog can write `imports: [ bdd-suite:core ]`
instead of copying the spec, and the schema generator, `Build-Schema.ps1`,
which `bddSuite.schemaGenerator` runs by default (also on demand: *Suite:
Regenerate the schema*). When the workspace pins bdd-suite packages of
another release (`Directory.Packages.props`, `go.mod`, `Cargo.toml`,
`package.json`, or a PowerShell `RequiredVersion`), it says so.

## Workspace layout

The extension activates in a workspace folder that contains the action catalog
at `bddSuite.catalogPath`, and does nothing elsewhere. Every path below is a
default you can change in the settings:

| What | Default |
| --- | --- |
| Action catalog | `test/e2e/schema/actions.catalog.yaml` (`bddSuite.catalogPath`) |
| Suite schema | `suite.schema.json` beside the catalog, regenerated by `bddSuite.schemaGenerator` after a catalog edit |
| Suites and libraries | `test/e2e/**/*.yml` (`bddSuite.suiteGlobs`); a file is a suite when it has a top-level `suite:` key, and a library when a suite imports it |

**Your actions, in each language.** A workspace's actions are its own
extension of each runtime (`runtimes/<language>` in this repository): a small
project per language that registers the actions and builds that language's
`suiterun` from the runtime plus the extension. The extension finds the
registrations, and *Implement in ...* adds new ones, in this layout:

| Language | Actions file | A registration | The workspace's `suiterun` |
| --- | --- | --- | --- |
| PowerShell | `scripts/e2e/actions/*.ps1` | `Register-SuiteAction -Name 'shop.order' -Handler { ... }` | `pwsh -File scripts/e2e/suiterun.ps1` |
| Go | `test/e2e/bindings/go/actions/actions.go` | `{Name: "shop.order", Handler: shopOrder},` in `var Registrations = []actions.Registration{` | built by `go build ./cmd/suiterun` into the extension's storage |
| Rust | `test/e2e/bindings/rust/src/actions.rs` | `Action::new("shop.order", shop_order),` in `pub fn actions() -> Vec<Action>` | `test/e2e/bindings/rust/target/debug/suiterun` |
| C# | `test/e2e/bindings/dotnet/Suite.Cli/Actions.cs` | `new ActionRegistration("shop.order", ShopOrder),` in `All { get; } = [ ... ];`, or a dictionary entry `["shop.order"] = ShopOrder,` (also `ShopActions.Order`) | `test/e2e/bindings/dotnet/artifacts/bin/Suite.Cli/Debug/net10.0/suiterun` |
| TypeScript | `test/e2e/bindings/typescript/src/actions.ts` | `action('shop.order', shopOrder),` | `test/e2e/bindings/typescript/dist/cli.js`; the in-editor lint uses `dist/index.js` |

`samples/workspace` in this repository is a complete workspace in exactly this
layout. Each binding's source globs, the patterns that find its
registrations, its program and its build command are in `bddSuite.bindings`;
override any of them for a different layout. The source globs can instead live
in the workspace's catalog, committed with it, and then win over the setting;
a catalog it imports may add its own, relative to itself, and each binding
indexes the union:

```yaml
# test/e2e/schema/actions.catalog.yaml; globs relative to this file
bindingSources:
  csharp: [../bindings/dotnet/Shop.Suite/**/*.cs]
``` Once a binding registers any of
the catalog's own actions, *Implement in ...* adds to the file that holds most
of them instead of the one in the table. In a C# dictionary registry whose
entries are qualified, `["shop.order"] = ShopActions.Order,`, the new entry is
qualified the same way and its method goes into the file that declares
`class ShopActions` (`ShopActions.cs` first), as `internal` so the registry
can call it.

## Install

From a GitHub release
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
  itself, in the BDD Suite language mode and in plain YAML mode. (If a YAML
  extension is installed and enabled, it is left to check plain-YAML files, so
  nothing is reported twice.)
* **A workspace with an action catalog**, and the binding you lint with built
  (below).
* **A trusted workspace.** In an untrusted folder, navigation, hover and
  completion work, but lint, runs, builds and schema generation are disabled,
  because each of them runs code from the folder.

To try it without a workspace of your own, see
[A self-contained demo](#a-self-contained-demo). To build it from source, see
[Build, test and release](#build-test-and-release).

### The runtime packages

Your workspace's actions run on a runtime per language, which it takes as a
package of the same release as the extension (every package carries the
extension's version). Each release carries them; the public registries follow
once they are set up.

| Language | Package | Install |
| --- | --- | --- |
| C# | `Bdd.Suite`, `Bdd.Suite.Testing` | From GitHub Packages, `https://nuget.pkg.github.com/smartpcr/index.json` (a token with `read:packages`), or the release's `.nupkg` files in a folder feed: `<PackageReference Include="Bdd.Suite.Testing" Version="0.7.3" />` ([runtimes/csharp](runtimes/csharp/README.md)) |
| Go | `github.com/smartpcr/bdd-code-extension/runtimes/go` | `go get github.com/smartpcr/bdd-code-extension/runtimes/go@v0.7.3` ([runtimes/go](runtimes/go/README.md)) |
| Rust | `suiterun` | A git dependency on the tag, or the release's `suiterun-<version>.crate` ([runtimes/rust](runtimes/rust/README.md)) |
| TypeScript | `@bdd-suite/runtime` | From GitHub Packages as `@smartpcr/bdd-suite-runtime`, under its own name: `npm install @bdd-suite/runtime@npm:@smartpcr/bdd-suite-runtime@0.7.3` (an `.npmrc` with `@smartpcr:registry=https://npm.pkg.github.com` and a token); or the release's `.tgz` ([runtimes/typescript](runtimes/typescript/README.md)) |
| PowerShell | `BddSuite` | From GitHub Packages, the C# feed: `Register-PSResourceRepository` it, then `Install-PSResource BddSuite` with a token; or the release's `BddSuite.<version>.nupkg` in a folder you register ([runtimes/powershell](runtimes/powershell/README.md)) |

Each language has a working consumer that uses only its package, its own
extension and binding program, and its suites as tests:
[samples/consumers](samples/consumers). Moving a workspace from a copy of a
runtime to its package: [docs/packages/migrating.md](docs/packages/migrating.md).

## The BDD Suite language mode

A suite is YAML, and a `.yml` file can be opened as plain YAML or as a **BDD
Suite** (Change Language Mode, or the language name in the status bar).

* A `.yml`/`.yaml` file whose **name contains `suite`, `feature` or `test`**
  opens as a BDD Suite. To make a folder's files open that way too, map it in
  your settings, e.g. `"files.associations": { "**/test/e2e/suites/**/*.yml": "bdd-suite" }`.
* In BDD Suite mode the extension **enforces the suite schema** while you
  type: a missing required parameter, a parameter the action does not take, a
  wrong type, an unknown action. Findings are marked `bdd-suite schema`
  (`BDD060`). It also completes a step's keys from the schema, the action's
  required parameters first.
* **Highlighting** adds what a YAML grammar cannot know: Gherkin keys, `why`,
  `captureAs`/`ifCapture` and `${...}` expressions are coloured by the grammar,
  and the extension colours each action by where it is implemented (green when
  the target binding implements it, red and italic when only another binding
  does, red, italic and underlined when no binding does, red and underlined
  when the catalog does not declare it), each parameter by its action (purple,
  bold when required, red and struck out when the action does not take it),
  an assertion's `var:` subject (the capture teal, each field purple like a
  parameter, red and
  underlined when not in scope or not in the action's declared captures),
  other schema keys apart from parameters, meta steps, and every other value
  by its type (string, number, boolean) in the theme's own colours; prose such
  as `given:` sentences stays plain. This covers cases, meta step definitions
  and the `setup`, `beforeEach`, `afterEach`, `teardown` and `cleanup` hooks.
  The styles are defaults under `editor.semanticTokenColorCustomizations`,
  which you can override.
* In plain YAML mode a suite (a file with a top-level `suite:` key, or one a
  suite imports) gets the same schema check and key completion, without the
  highlighting. Every other feature (navigation, hover, lint, completion, the
  CodeLens, code generation) works in both modes.

## Bindings and lint tools

A binding's program is what the extension runs to lint, list and run suites.
Any program that speaks this command line can be a binding (set it as the
binding's `tool` in `bddSuite.bindings`):

| Command | Used for | Prints or writes |
| --- | --- | --- |
| `lint --path <suite> --json --binding-check --binding <target>` | Lint | Exit 0 (clean) or 2 (findings) with a JSON array of findings: `code`, `severity`, `file`, one-based `line` and `column`, `message`, optional `suggestion`; anything else is a failed lint |
| `actions --json` | The binding table | A JSON array of the action names it registers |
| `list --path <suite> [--tags a,b]` | A lab run's confirmation | One line per case that would run |
| `run --path <suite> --trace-file <f> --results <f> --format nunit3 [--tags] [--dry-run]` | Test Explorer | A JSON trace of each step and case, and an NUnit 3 report |

The PowerShell binding speaks the same command line through a script,
`pwsh -File scripts/e2e/suiterun.ps1 <verb> ...`, and also takes
`--test-name <case>`, so Test Explorer can run one case.

The built-in bindings and how to build each as a lint tool (from your
workspace, with the default layout):

| Lint tool | How it lints | Build it | Needs |
| --- | --- | --- | --- |
| `typescript` (default) | In-process, in a worker thread, on open, on save **and on every pause in typing**, including unsaved text | `cd test/e2e/bindings/typescript; npm ci; npm run build` | Node.js 24 and npm |
| `go` | Its program on the saved file | `cd test/e2e/bindings/go; go build -o <storage>/go/suiterun.exe ./cmd/suiterun` | Go 1.24 |
| `rust` | as Go | `cd test/e2e/bindings/rust; cargo build` | Rust (stable) |
| `csharp` | as Go | `cd test/e2e/bindings/dotnet; dotnet build` | .NET 10 SDK |
| `powershell` | `scripts/e2e/suiterun.ps1 lint` on the saved file | nothing | PowerShell 7 with `powershell-yaml` |

The command **Suite: Build lint tool** runs the build for the current lint tool
and shows its output. When the lint tool is not built, the status bar says so
and offers that command; the extension never switches tools by itself.

**When lint runs.** A program tool (Go, Rust, C#, PowerShell) lints the file on
disk when it is opened and each time it is saved. Between saves, `E2xx` and
`E3xx` findings describe the saved file and may sit on lines that have since
moved; the next save replaces them. While you type, the schema check still
covers the structure. The TypeScript tool has no such gap: it lints the
editor's text about 0.4 s after you stop typing, with imports resolved from the
file's real location, and never writes the unsaved text to disk.

When a lint fails (the tool is missing, slow, broken or prints something that
is not diagnostics), the status bar names the failure, the output channel
*Suite Authoring* has the details, and the previous findings stay, marked
`[stale]`.

## Running suites

In Test Explorer (the Testing view: Ctrl+Shift+P, *Testing: Focus on Test
Explorer View*), *Run* runs a suite under the target binding and shows each
case's result from the run's trace; *Dry run* lists what would run without
starting an action. *Run* on one case runs only that case where the binding
can (PowerShell); other bindings run the whole file and report every case.

**Suites that need an environment.** Some actions work against a real
environment (the extension calls it a *lab*), others need nothing. The actions
listed in `bddSuite.offlineActions` (by default the built-in `core.*` and
`wait`) run offline; a suite that uses any other action is a **lab suite**.
Before a lab suite runs, the extension asks for any missing lab setting (API
URL, lab id, connection file) and shows the binding, lab, API and the cases
that will run, and starts nothing until you confirm. If your actions need no
environment, list them in `bddSuite.offlineActions` (e.g. `"myapp.*"`) and
runs ask nothing.

*Stop* works at every point: while a run waits on a question or the
confirmation it ends at once and starts nothing; once a lab suite has started,
it asks whether to stop the run, because stopping may leave the environment
half done. A run has no timeout of its own; the suite's limits apply. A run
whose runner is missing fails at once with its path, before asking anything,
and the *Suite Authoring* output channel logs each step a run waits on.

## Running suites with your test framework

Outside the editor, a suite can also run as ordinary tests of the framework a
language's developers already use, so `dotnet test`, `go test`, `cargo test`,
`npm test` or `Invoke-Pester` runs it, with that framework's filters, reports
and test explorer. A `bddsuite.tests.yaml` beside the test project names the
suites; `suiterun generate` (or the build, in C# and Rust) writes one test per
case and examples row, each running through the same session as `suiterun run`
(`spec/session.md`), so both give the same results.

| Language | Frameworks | How it runs |
| --- | --- | --- |
| C# | MSTest 4, NUnit 4, xUnit v3 | the `Bdd.Suite.Testing` package generates at build; [runtimes/csharp](runtimes/csharp/README.md) |
| Go | `go test` | `go generate` writes `*_bdd_test.go`; [runtimes/go](runtimes/go/README.md) |
| Rust | `cargo test` | `build.rs` generates for a `harness = false` target; [runtimes/rust](runtimes/rust/README.md) |
| TypeScript | `node:test`, Vitest, Jest, Mocha | `suiterun generate` writes `*.bdd.test.ts`; [runtimes/typescript](runtimes/typescript/README.md) |
| PowerShell | Pester 5 | `suiterun.ps1 generate` writes `*.Bdd.Tests.ps1`; [runtimes/powershell](runtimes/powershell/README.md) |

A suite that uses an action the config does not list as offline is
**guarded**: its tests skip unless `BDD_SUITE_ALLOW_GUARDED=1`, so a test run
in CI never reaches a lab by accident. Options, parameters, tags and the trace
file come from `BDD_SUITE_*` environment variables. Working projects for every
framework are under `samples/workspace/tests/`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `bddSuite.lintTool` | `typescript` | The binding whose code lints suites |
| `bddSuite.targetBinding` | `powershell` | The binding suites are meant to run with; lint reports the actions it does not implement (`E201`) |
| `bddSuite.catalogPath` | `test/e2e/schema/actions.catalog.yaml` | The action catalog, relative to the workspace folder |
| `bddSuite.suiteGlobs` | `["test/e2e/**/*.yml"]` | Candidate suite files; a file is a suite when it has a top-level `suite:` key or is imported by one |
| `bddSuite.exclude` | `**/{node_modules,bin,obj,target,artifacts,.git}/**` | Files never indexed |
| `bddSuite.bindings` | the five bindings | Per binding: source globs, the patterns that find registrations, the program, its build command and (TypeScript) its library |
| `bddSuite.schemaGenerator` | `pwsh ... ${extension}/spec/Build-Schema.ps1 -Catalog ${catalogPath}` | Regenerates `suite.schema.json` after a catalog edit, with the generator the extension carries; `${extension}` is the extension's folder, `${catalogPath}` the catalog |
| `bddSuite.inlayHints.bindings` | `true` | Show which bindings implement each step's action |
| `bddSuite.codeLens.implement` | `true` | Above a step whose action is missing in a language: where, with *Implement in C#/Go/Rust* (or *Declare action* when the catalog lacks it) one click away |
| `bddSuite.templatesDir` | empty | A workspace directory whose files override the stub templates |
| `bddSuite.offlineActions` | `["core.*", "wait"]` | Actions that run without a lab, as names or `prefix.*`; a suite using any other action is a lab suite |
| `bddSuite.contextKeys` | `[]` | Context keys your runtime extensions add (read as `${key}`); completion offers them beside the core's `timeoutSec` and `defaults` |
| `bddSuite.lab.apiUrl` | empty | The environment's API URL for lab runs; asked for when empty |
| `bddSuite.lab.labId` | empty | The environment's id for lab runs; asked for when empty |
| `bddSuite.lab.connectionFile` | empty | The environment's connection file for lab runs; asked for when empty |

`bindings`, `lintTool` and `schemaGenerator` choose code that runs, so VS Code
ignores their workspace values in an untrusted folder. The extension stores no
credential: a lab run reads the connection file you name, each time.

## Commands

*Suite: Build lint tool*, *Choose lint tool...*, *Choose target binding...*,
*Configure lint...*, *Show actions implemented by binding...*, *Declare action*,
*Implement action in binding...*, *Verify with binding programs*, *Copy binding
table*.

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
  runner is a stand-in that touches no environment, and its settings list the
  demo's actions in `bddSuite.offlineActions`, so a run asks nothing.

It needs no workspace of your own and no binding built. `DEMO_KEEP=1` keeps
the workspace so you can open the generated code; `--vsix <path>` tests
another package.

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
| `npm run package` | Writes `out/bdd-suite-<version>.vsix` and its `.sha256`, and checks that the archive holds only the built extension |
| `npm run test:demo` | Installs that `.vsix` into a fresh VS Code profile and drives the self-contained demo (above) |
| `npm run test:integration` | The integration suite in a real VS Code, against `samples/workspace`; it builds the sample's five bindings from `runtimes/` first (needs Go, Rust, .NET 10, Node.js and PowerShell 7 with `powershell-yaml`) |
| `npm run install:local` | Packages and installs into your own VS Code; open windows offer the reload |

**Continuous integration** (`.github/workflows/ci.yml`) runs on every push to
`main` and every pull request:

* the extension: `npm ci`, the unit tests, `npm run package` and the demo
  (Windows), keeping the `.vsix` and its `.sha256` as the run's `vsix` artifact;
* the integration suite against `samples/workspace` (Windows);
* the core spec's schema tests, and a staleness check of every generated schema;
* each runtime's unit tests and the whole conformance corpus (TypeScript, Go,
  Rust and C# on Linux, PowerShell on Windows);
* the divergence check: a defect injected into the Go and TypeScript runtimes
  must fail their corpus;
* every runtime package packed once and checked, and each consumer sample
  (`samples/consumers`) built and run from those packages alone;
* the publish dry run for each public registry, and actionlint on the workflow.

**Releasing is automatic.** Bump the version and push it to `main`:

```powershell
npm version patch --no-git-tag-version   # or minor / major; edits package.json and package-lock.json
npm run set-version                      # every runtime manifest, lock and consumer pin to the same version
git commit -am "release 0.7.3"
git push origin main
```

When every gate of that push passes and no tag `v<version>` exists yet, the
same CI run releases what it built and tested (docs/packages, D16):

1. the `packages` job has packed every runtime package once
   (`scripts/pack-all.ps1`) and checked each against `packaging/`, and the
   `consumers` matrix has built and run each consumer sample from those very
   files (E2 to E6);
2. `Bdd.Suite`, `Bdd.Suite.Testing`, `BddSuite` and the npm package go to
   this repository's GitHub Packages; and to the public registries the
   repository variable `PUBLIC_REGISTRIES` names (`true` for all of nuget.org,
   npm, crates.io and the PowerShell Gallery, or a list such as
   `nuget,npm,crates`), in the `release` environment (each set up once, as
   [docs/packages/implementation.md](docs/packages/implementation.md#6-operator-setup-before-the-first-release)
   says);
3. the GitHub release `v<version>` (and with it the tag) gets the `.vsix`, its
   `.sha256`, every package file, the runtime versions and generated notes;
4. the Go module is tagged `runtimes/go/v<version>` at the same commit.

Every publish step first asks its registry and skips a version it has, and an
existing GitHub release gets its files replaced, so a release that failed
part-way is finished by running it again. A pull request, or a push that keeps
the version, builds and tests and dry-runs the publishing: each registry says
what it would publish, and nothing reaches one (E10).

## Design and plan

In the source repository (not in the package): `docs/design.md`,
`docs/implementation.md`, and the evidence for each stage under
`docs/evidence/`. The plan to make this repository self-contained (the core
format spec, the conformance corpus and the five language runtimes moving
here, extended by import) is `docs/self-contained/design.md` and
`docs/self-contained/implementation.md`. Running suites with each language's
test framework is `docs/test-providers/design.md` and
`docs/test-providers/implementation.md`. Publishing the runtimes as packages
(NuGet, npm, crates.io, the PowerShell Gallery and the Go module) is
`docs/packages/design.md` and `docs/packages/implementation.md`.
