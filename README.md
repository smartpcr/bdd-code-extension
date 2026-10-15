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
  limited to what is in scope.
* **Scaffolding.** Declare a new action in the catalog from a step that uses it,
  and add a stub registration to a binding.
* **A binding table** (the *Suite bindings* view): what each binding declares
  and registers, and any drift between them.
* **Test Explorer.** Every suite, case and outline row is a test item; run or
  dry-run them under a binding. Lab suites ask for confirmation first.

The extension activates in a folder that contains
`test/e2e/schema/actions.catalog.yaml`, and does nothing elsewhere.

## Install

The extension is not on the Marketplace. Install the package:

```powershell
code --install-extension bdd-suite-0.1.0.vsix
```

Check the package against the SHA-256 published beside it
(`bdd-suite-0.1.0.vsix.sha256`) before installing it.

It needs:

* **VS Code 1.95 or later.**
* **`redhat.vscode-yaml`**, which VS Code installs with it (it is a declared
  dependency). It checks a suite's structure while you type, from the committed
  `suite.schema.json`.
* **An os-context checkout** with the binding you lint with built (below).
* **A trusted workspace.** In an untrusted folder, navigation, hover and
  completion work, but lint, runs, builds and schema generation are disabled,
  because each of them runs code from the folder.

To build the package from source: `npm ci`, then `npm run package`. That writes
the `.vsix`, its `.sha256`, and checks that the archive holds only the built
extension.

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
have since moved; the next save replaces them. While you type,
`redhat.vscode-yaml` still checks the structure. The TypeScript tool has no such
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
| `bddSuite.templatesDir` | empty | A workspace directory whose files override the stub templates |
| `bddSuite.lab.apiUrl` | empty | The lifecycle API URL for lab runs; asked for when empty |
| `bddSuite.lab.labId` | empty | The lab's lineage id (32 hex characters) for lab runs; asked for when empty |
| `bddSuite.lab.connectionFile` | empty | The lab connection file for lab runs; asked for when empty |

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
starting an action. A suite that uses `lifecycle.*` actions is a lab suite: the
extension asks for any missing lab setting and shows the binding, lab, API and
the cases that will run before anything starts. Cancelling asks whether to stop
the run, because stopping may leave lab state half done. A run has no timeout
of its own; the suite's limits apply.

## Design and plan

In the source repository (not in the package): `docs/design.md`,
`docs/implementation.md`, and the evidence for each stage under
`docs/evidence/`.
