# Suite authoring in VS Code: design

**Status.** Design. Nothing described here is built yet. The companion
implementation plan is [implementation.md](implementation.md); it says *how*,
this document says *what* and *why*.

**What this is.** A Visual Studio Code extension for writing the YAML test
suites defined in the `os-context` repository
(`E:\work\os\os-context`, design `docs/e2e/yml_suite_design.md`). Those suites
are BDD-style: every step carries a Gherkin keyword and a sentence, and names
an *action* that one of four *bindings* (PowerShell, C#, Go, Rust) executes.
The extension helps the person writing a suite, and the person implementing an
action in one of the four languages, see the same vocabulary the bindings
enforce: while typing, on save, and across the language boundary.

**Who should read it.** Suite authors who want to know what the editor will do
for them; binding implementers who will see it from the other side; reviewers
deciding whether the approach is sound; and anyone new to the format, for whom
the vocabulary section is written.

Paths in `code font` that start with `test/`, `scripts/` or `docs/` are paths in
the `os-context` repository. Paths under `src/` are in this repository.

---

## Contents

- [Vocabulary](#vocabulary)
- [1. Goals](#1-goals)
- [2. What exists today](#2-what-exists-today)
- [3. Components](#3-components)
- [4. Decision records](#4-decision-records)
- [5. What the author sees](#5-what-the-author-sees)
- [6. Failure behaviour](#6-failure-behaviour)
- [7. Verification](#7-verification)
- [8. Traceability](#8-traceability)
- [9. Decision index](#9-decision-index)

---

## Vocabulary

Defined once, used throughout. The first eight words belong to the suite format
and keep the meanings `yml_suite_design.md` gives them; the rest are this
extension's.

* **Suite.** One YAML file with a top-level `suite:` key and a list of cases
  under `tests:`. `test/e2e/suites/smoke.yml` is a suite.
* **Library.** A YAML file a suite lists under `imports:`. It declares
  parameters, variables, meta steps and defaults, and never cases or hooks.
  `test/e2e/suites/_lib/lifecycle.yml` is a library.
* **Case, step, hook.** A case is one entry under `tests:` and is what passes
  or fails. A step is one entry in a step list, such as
  `- action: cluster.state`. A hook is a step list that is not a case: suite
  `setup`, `teardown`, `beforeEach`, `afterEach`, and a case's own `setup` and
  `cleanup`.
* **Keyword and sentence.** A step may carry one of `given`, `when`, `then` or
  `and`; its value is a sentence. The sentence is documentation that the report
  prints. It is *not* matched against code. This is the main way the format
  differs from Cucumber, and it matters to this design (DEC-B01).
* **Action.** The named behaviour a step invokes, such as `lifecycle.get`.
  The step's other keys (`route:`, `node:`) are the action's parameters.
* **Action catalog.** `test/e2e/schema/actions.catalog.yaml`. One entry per
  action: summary, parameters with types, the shape of what it captures, and
  the list of bindings that implement it. It is the vocabulary.
* **Binding.** One implementation of the format in one language: a library
  plus a command-line tool that lints, lists, runs, and reports which actions
  it implements. There are four. Three ship a program named `suiterun`; the
  PowerShell one is `scripts/e2e/Invoke-LabTestSuite.ps1` plus the module
  `scripts/e2e/SuiteLint.psm1`.
* **Capture, expression.** A step publishes its result under `captureAs: x`;
  later steps read it as `${capture.x}`. Anything inside `${ }` is an
  expression in a small fixed language (paths, operators, a closed function
  list).
* **Registration site.** The line in a binding's source where an action name is
  tied to the code that runs it. In PowerShell it is
  `Register-LabAction -Name 'cluster.resume' -Handler {`; in Go a map entry
  `"lifecycle.get": get,`; in Rust `map.insert("core.noop", core_noop)` or a
  dispatch arm `"lifecycle.get" => get(context, step)`; in C# a dictionary
  entry `["core.noop"] = Noop,`. It is to this format what a step definition is
  to Cucumber.
* **Recognizer.** A pattern the extension uses to find registration sites in
  one language's source files. Recognizers are configuration, not code
  (DEC-B05).
* **Index.** The extension's in-memory map of where things are: every step and
  the action it names, every registration site, every meta step definition and
  use, every capture. It answers "where", never "is this valid" (DEC-B02).
* **Lint tool, target binding.** The *lint tool* is the binding whose
  command-line program the extension runs to get diagnostics. The *target
  binding* is the binding the author intends to run the suite with; lint checks
  that it implements every action the suite uses. They are separate settings
  because any `suiterun` can answer the question for any binding (DEC-B04).
* **Diagnostic.** One lint finding: a stable code (`E101`, `E301`, `W304`), a
  file, a one-based line and column, a message. The codes are defined in
  `test/e2e/schema/diagnostics.md`.
* **Drift.** A disagreement between what the catalog claims a binding
  implements and what the binding's source actually registers.

How these relate, for one step:

```
  suite file                      catalog                         bindings
  ----------                      -------                         --------
  - when: the run is read   +-->  - name: lifecycle.get    +-->  PowerShell  Register-LabAction -Name 'lifecycle.get'
    action: lifecycle.get --+       params: [route, ...]   |     Go          "lifecycle.get": get,
    route: /labs/x                  captures: {...}        |     Rust        "lifecycle.get" => get(context, step)
    captureAs: run                  bindings: [powershell, +-->  C#          ["lifecycle.get"] = (context, request) => ...
                                      csharp, go, rust]
  sentence: printed in reports    the vocabulary                 the implementations
  action: what runs               (one file)                     (four languages)
```

---

## 1. Goals

### 1.1 The problem

The format is mature: a generated JSON Schema, a 100-action catalog, four
bindings that agree through a conformance corpus, stable diagnostic codes. The
editor has not kept up. Today an author gets exactly what
`redhat.vscode-yaml` can derive from the schema mapped in
`.vscode/settings.json`: an underline on an unknown key (`E101`), a missing key
(`E102`), a wrong type (`E103`), an unknown action (`E104`) and an unknown
parameter (`E105`). Everything else waits for a lint job or a lab run:

* **References and dataflow are invisible.** `${capture.origOwner}` read in a
  case that never captured it (`E303`), a meta step that does not exist
  (`E206`), a Gherkin keyword out of order (`E212`): none of these appears
  until `lint` runs. The schema README says so in its own table.
* **Portability is discovered late.** Of the 100 catalog actions, 24 are
  implemented by all four bindings and 76 by PowerShell only (counted from
  `actions.catalog.yaml` on 2026-10-13). An author who means to run a suite
  under Go learns that `cluster.state` is PowerShell-only from `E201`, and only
  if they remembered `--binding-check`.
* **There is no path from a step to its code.** Reading what `lifecycle.get`
  does means knowing that the PowerShell handler is somewhere under
  `scripts/e2e/actions/`, the Go one in a map in
  `test/e2e/bindings/go/internal/lifecycle/actions.go`, the Rust one in a
  `match` in `test/e2e/bindings/rust/src/lifecycle/actions.rs`, and the C# one
  in a dictionary in `LifecycleActions.cs`. The reverse question, "which suites
  use the action I am about to change", is answered with grep.
* **Expressions get no help.** Inside `${ }` the schema sees only a string. The
  capture names in scope, the paths into a capture's declared shape, the
  parameter names and the 21 functions are all known to the bindings and none
  is offered while typing.
* **Adding an action is a five-place edit by hand.** A new action needs a
  catalog entry, a regenerated schema (`Build-Schema.ps1`), a PowerShell
  registration (a test asserts the catalog's names and the PowerShell
  registry's names are the same set), and a registration with the right
  signature in each other binding that is meant to implement it.
* **The binding table is not visible anywhere.** "How many declared actions
  does each binding implement, and does the source agree with the catalog?" is
  answered by reading YAML and running three programs.

A starting prototype exists (`yml-gherkin`, in
`C:\Users\xiaodoli.REDMOND\Downloads\bdd-ext`). It solves a different problem:
it matches step *sentences* against regular expressions in Reqnroll, Pester,
cucumber-rs and godog step definitions. Section [2.4](#24-the-starting-prototype)
explains what this design keeps from it and why its central mechanism does not
apply.

### 1.2 Who it is for

| Reader | What they do | What they need from the editor |
| --- | --- | --- |
| Suite author | Writes and edits `test/e2e/suites/*.yml` | Every finding while editing; what is in scope inside `${ }`; which bindings can run what they wrote |
| Binding implementer | Adds or changes an action in one language | Which suites use the action; what the catalog says it takes and captures; a correct stub to start from |
| Reviewer | Reads a suite change | Hover that explains an action without opening four files |
| Operator | Runs a suite against a lab | Running a case under a chosen binding with the result shown on the case |

### 1.3 Outcomes

Each outcome is observable in the editor and is proved by the scenarios named
beside it. Section [8](#8-traceability) links each to the implementation steps.

**O1. Every lint finding is shown at its line and column, from the same program
that will run the suite.** On open and on save, the author sees all of `E1xx`
to `W3xx` for that file, with the code and message the lint tool printed, at the
position it printed. Proved by [E-B1](#e-b1-the-editor-shows-exactly-what-the-corpus-says-lint-must-find)
and [E-B11](#e-b11-a-missing-slow-or-broken-lint-tool-is-reported-not-hidden).

**O2. The author sees which bindings can run a step, while writing it.** Each
step shows which of the four bindings implement its action; a step the target
binding cannot run is marked with `E201` after save. Proved by
[E-B2](#e-b2-a-step-the-target-binding-cannot-run-is-marked-and-says-who-can).

**O3. From a step to every implementation, and back, in one gesture.** Go to
Definition on an action name lists the catalog entry and each binding's
registration site. Find All References on a registration site, or on a catalog
entry, lists every step that uses that action, including steps inside meta
steps and libraries. A meta step use goes to its definition, across imports.
Proved by [E-B3](#e-b3-go-to-definition-on-an-action-lists-the-catalog-entry-and-every-registration)
and [E-B4](#e-b4-a-registration-site-shows-and-lists-the-steps-that-use-it).

**O4. Completion and hover know what the schema cannot.** Action names with
their summaries and binding support; inside `${ }` the namespaces, the captures
produced earlier in the case, the paths into a capture's declared shape, the
parameters, the variables, the table columns and the closed function list;
meta step names and their `with:` parameters. Proved by
[E-B5](#e-b5-completion-offers-what-is-in-scope-and-nothing-the-format-forbids).

**O5. A new action goes from the step that names it to a declared, compiling
implementation without copying a signature by hand.** A quick fix on an unknown
action declares it in the catalog with the parameters the step uses, writes the
PowerShell registration the catalog test requires, and regenerates the schema
with the repository's own generator. A command adds a compiling stub to the Go,
Rust or C# binding. Proved by
[E-B6](#e-b6-a-new-action-is-declared-and-implemented-in-all-four-bindings-from-the-editor).

**O6. Drift between the catalog and the source is visible before CI.** A view
shows, per binding, the declared action count, the registrations found in the
source, and every disagreement. Proved by
[E-B7](#e-b7-the-binding-table-matches-the-catalog-and-the-binaries-and-drift-appears-when-introduced).

**O7. A suite runs from the editor under a chosen binding, and each case shows
its result.** Offline suites run locally; lab suites run against a lab the
operator names at run time. Proved by
[E-B9](#e-b9-an-offline-suite-runs-under-each-binding-and-each-case-shows-the-corpus-result)
and [E-B10](#e-b10-the-portable-stage-0-cases-run-from-the-editor-against-a-real-lab).

**O8. A change to the format needs no new extension.** The extension reads the
catalog, the schema and the binding programs from the workspace. A new
parameter, action or binding in the catalog appears in hover and completion as
soon as the file is saved, without reinstalling or reloading. Proved by
[E-B8](#e-b8-a-catalog-change-is-picked-up-without-a-reload).

### 1.4 Non-goals

* **Matching sentences to code.** The format's own design rejects it
  (`yml_suite_design.md` 1.2: "a sentence matched to code by a regular
  expression is a second vocabulary to keep in step with the first"). The
  prototype's regex step matching is therefore not carried forward
  (DEC-B01). Supporting Cucumber-style `.feature` files is a different product.
* **A fifth validator.** The extension does not re-implement lint. Four
  implementations are kept honest by a corpus; a fifth, in TypeScript, would
  need the same corpus to go green and would still be the one nobody runs in CI
  (DEC-B02).
* **Replacing `redhat.vscode-yaml`.** Structural checking while typing stays
  with it and the committed schema mapping. The extension depends on it rather
  than duplicating it (DEC-B03).
* **Following a handler into its body.** The extension takes the author to the
  registration site. From there, Go to Definition on the handler name is the
  job of `gopls`, `rust-analyzer`, the C# extension or the PowerShell extension
  (DEC-B06).
* **Editing the generated schema.** `suite.schema.json` and `suite.schema.md`
  are written by `test/e2e/schema/Build-Schema.ps1` and nothing else
  (INV-1 in the plan).
* **Building or changing a lab.** The extension starts a binding's `run` verb
  when the operator asks; it never cleans up, rolls back or otherwise touches
  lab state itself. What a suite creates, the suite's own cleanup and teardown
  remove.
* **Publishing to the Marketplace.** The deliverable is a `.vsix` installed
  locally. Publishing is a later decision with its own review.

---

## 2. What exists today

### 2.1 The format's moving parts

Measured in `E:\work\os\os-context` on 2026-10-13.

| Thing | Where | Fact that matters here |
| --- | --- | --- |
| Action catalog | `test/e2e/schema/actions.catalog.yaml` | 100 actions; 24 list all four bindings, 76 list `powershell` only; top-level `bindings: [powershell, csharp, go, rust]` |
| Hand-written schema | `test/e2e/schema/suite.base.json` | `stepEnvelope` declares `action` as a plain string: no enum, so nothing completes action names today |
| Generated schema | `test/e2e/schema/suite.schema.json` | 10141 lines; one `step.<action>` definition per action, each closed with `additionalProperties: false` |
| Generator | `test/e2e/schema/Build-Schema.ps1` | Writes the schema and `suite.schema.md`; `-Check` fails on drift |
| Diagnostic contract | `test/e2e/schema/diagnostic.schema.json` | Array of `{ code, severity, file, line, column, message, suggestion? }`; `file` repository-relative with forward slashes; line and column one-based |
| Suites | `test/e2e/suites/*.yml` | 29 files; the largest, `lifecycle-stage1.yml`, is 68 KB |
| Libraries | `test/e2e/suites/_lib/*.yml` | `lifecycle.yml`, `shared-checks.yml`, `wsfc.yml` |
| Conformance corpus | `test/e2e/conformance/` | `validate/<x>.yml` beside `<x>.expected.json` (the exact sorted diagnostics); `execute/<x>.yml` beside its expected trace |
| Editor mapping | `.vscode/settings.json` | `yaml.schemas` maps suites, `_lib`, and both corpus families to the generated schema |

### 2.2 The four bindings, as the extension will meet them

| Binding | Source | Program | Registration shape | Declared actions |
| --- | --- | --- | --- | --- |
| PowerShell | `scripts/e2e/` | `pwsh -File scripts/e2e/Invoke-LabTestSuite.ps1` (`-Lint -Json`); `Invoke-SuiteLint` in `SuiteLint.psm1` for `-BindingCheck -Binding` | `Register-LabAction -Name 'x' -Handler { param([hashtable]$Step, [hashtable]$Ctx) ... }`, one file per action under `scripts/e2e/actions/`, dot-sourced by `ActionRegistry.ps1` | 100 |
| Rust | `test/e2e/bindings/rust/` | `suiterun` (crate name), built at `target/debug/suiterun.exe` | `map.insert("core.noop", core_noop)` in `src/actions.rs`; `"lifecycle.get" => get(context, step)` in `src/lifecycle/actions.rs`; `names.push("wait".to_string())` | 24 |
| Go | `test/e2e/bindings/go/` | `suiterun` (`cmd/suiterun`), not built in the tree | `"core.noop": noop,` in `internal/actions/actions.go`; `"lifecycle.get": get,` in `internal/lifecycle/actions.go`; `names = append(names, "wait")` in `internal/exec/exec.go` | 24 |
| C# | `test/e2e/bindings/dotnet/` | assembly `suiterun` from `Hci.E2E.Suite.Cli` | `["core.noop"] = Noop,` in `Actions/CoreActions.cs`; `["lifecycle.get"] = (context, request) => context.Get(request),` in `Actions/Lifecycle/LifecycleActions.cs`; `names.Add("wait")` in `Execution/Executor.cs` | 24 |

All three `suiterun` programs share one command-line contract
(`yml_suite_design.md` DEC-Y14):

```
suiterun lint    --path <glob> [--json] [--strict] [--binding-check] [--binding <name>]
suiterun run     --path <glob> [--tags a,b] [--results f.xml] [--format nunit3|junit]
                 [--dry-run] [--param name=value] [--trace-file f.json]
                 [--api-url u] [--lab-id id] [--connection-file f.json]
suiterun list    --path <glob> [--tags a,b]
suiterun actions [--json]
```

Exit 0 is clean or all passed, 1 is a failed case, 2 is a validation *or*
harness error. Each program finds the repository root by walking up from its
working directory to the first directory containing `test/e2e/schema`.

### 2.3 What the editor does, and the gap

| Mistake | Editor today | `lint` | With this extension |
| --- | --- | --- | --- |
| Unknown key, missing key, wrong type, unknown action or parameter (`E101`-`E105`) | yes, while typing | yes | unchanged: still the YAML extension, while typing |
| Reference that resolves to nothing (`E301`), capture read too early (`E303`), meta cycle (`E207`), keyword order (`E212`), every other `E2xx`/`E3xx`/`W3xx` | no | yes | on open and on save (O1) |
| Action the target binding does not implement (`E201`) | no | with `--binding-check` | on save, and as a per-step badge while typing (O2) |
| Where an action is implemented, and who uses it | no | no | navigation both ways (O3) |
| What is in scope inside `${ }` | no | no | completion and hover (O4) |

### 2.4 The starting prototype

`yml-gherkin` 0.1.0 (TypeScript, about 650 lines) indexes `*.feature.yml` files
and step definitions in C#, PowerShell, Rust and Go. It finds step definitions
with one configurable regular expression per language, compiles each
definition's pattern into a JavaScript `RegExp`, and matches every step
sentence against all of them. On that index it builds Go to Definition, hover,
references, CodeLens usage counts, completion, "undefined step" and "ambiguous
step" diagnostics, and a "generate step definition" command with a template per
language.

What carries over, and what does not:

| Prototype part | Kept? | Why |
| --- | --- | --- |
| Index of YAML positions (`yaml` package CST, `LineIndex`) | yes | The same need: every provider answers from positions |
| Regex scanners per language, configurable in settings | yes, as recognizers | Registration sites are as regular as step definitions were (DEC-B05) |
| Watchers plus debounced re-index of open buffers | yes | Same need |
| Peek of all languages, CodeLens usage counts, references both ways | yes | The UX is right; the key it joins on changes from sentence to action name |
| Code generation per language | yes, reworked | Templates must match the four bindings' real handler signatures (DEC-B10) |
| Sentence-to-pattern matching (`compilePattern`, `exprToRegex`, `regexToSnippet`) | no | The format does not bind sentences to code (DEC-B01) |
| "Undefined step" and "ambiguous step" diagnostics | no | Their equivalents are `E104` and `E201`, which lint already defines (DEC-B02) |

---

## 3. Components

### 3.1 The picture

```
                     VS Code extension host (this repository)
   +-------------------------------------------------------------------------+
   |                                                                         |
   |  Workspace layout --> Catalog loader --+                                |
   |  (settings, roots)    (catalog YAML)   |                                |
   |                                        v                                |
   |  Suite indexer ---------------> Workspace index <--- Registration       |
   |  (suite + library YAML,           (in memory,          scanner          |
   |   positions)                       one owner)         (recognizers over |
   |                                        |               binding source)  |
   |          +-------------+---------------+-----------+------------+        |
   |          v             v               v           v            v        |
   |     Navigation     Completion,     Coverage     Scaffolding   Test       |
   |     (definition,   hover,          view         (catalog      Explorer   |
   |     references,    inlay hints)    (table,      entry, stubs) (run)      |
   |     CodeLens)                      drift)            |            |       |
   |                                        |             |            |       |
   |                Tool runner (spawn, timeout, cancel, JSON) <------+       |
   |                    |        ^                        |                    |
   +--------------------|--------|------------------------|--------------------+
                        |        |                        |
             lint/actions/list/run                  Build-Schema.ps1
                        v        | JSON, trace            v
             suiterun (Go | Rust | C#)            suite.schema.json
             or pwsh Invoke-LabTestSuite.ps1      suite.schema.md
                        |
                        v (run against a lab only)
             deployed lifecycle API on the lab

   Alongside, unchanged:  redhat.vscode-yaml + .vscode/settings.json -> live E1xx
```

### 3.2 What each part is for

**Workspace layout.** Finds the repository root (the folder holding
`test/e2e/schema`), reads the settings, and resolves every configured path.
It exists so that no other part hard-codes an `os-context` path; the defaults
match `os-context`, and another repository with the same format sets its own.

**Catalog loader.** Parses `actions.catalog.yaml` with positions, so every
action, parameter and capture property has a location the editor can jump to.
It is the only reader of the catalog.

**Suite indexer.** Parses every suite and library and records, with ranges:
each step and the key it sits under (case `steps`, which hook, which meta step),
its keyword and sentence, its action, its parameters, its `captureAs`, each
`${ }` expression, each `meta:` use and `with:` block, each meta step
definition with its parameters and exports, and each import.

**Registration scanner.** Runs each binding's recognizers over that binding's
source files and records each registration site: binding, action name,
handler name where the pattern names one, file, range.

**Workspace index.** Holds the three results above and answers questions:
which steps use action X, where is X registered, which captures are in scope
at this position, which meta steps are visible from this file. It is the
single owner of positions; every provider reads it and none parses files on
its own.

**Tool runner.** The only part that starts processes. It runs a binding's
program with a fixed working directory, collects its output within a size
limit, kills it on timeout or cancellation, and hands back either parsed JSON
or a tool failure with the program's error output.

**Navigation, completion, hover, inlay hints.** VS Code providers over the
index. They never wait on a process.

**Lint controller.** Runs the lint tool on open and save, maps its diagnostics
to editor ranges, and publishes them. It owns the diagnostics collection.

**Coverage view.** The binding table (the four rows of binding, source and
declared action count), the registration count found in source, and the drift
list. It can also ask each built binding for `actions --json` and compare.

**Scaffolding.** Writes a catalog entry, a PowerShell registration, and stubs in
the other bindings, then runs `Build-Schema.ps1`.

**Test Explorer integration.** Lists cases (and outline rows) as test items, and
runs a suite file under the target binding through `suiterun run --trace-file`,
mapping the trace back to the items.

### 3.3 What each part owns

| Part | Owns | Does not own |
| --- | --- | --- |
| Catalog file (`os-context`) | action names, parameters, capture shapes, which bindings implement what | how the extension shows it |
| Generated schema (`os-context`) | structural rules, live `E1xx` via the YAML extension | anything the extension writes |
| Binding programs (`os-context`) | every diagnostic's code and position, run results, the list of actions they implement | positions of things that are not findings |
| Workspace index (extension) | where things are, as of the last parse | whether anything is valid |
| Lint controller (extension) | the diagnostics shown for each file, as of the last lint | the codes or messages in them |
| Scaffolding (extension) | the text it inserts, in one undoable edit | the generated schema, which the generator writes |
| Suite run (lab) | everything the suite creates and its cleanup | nothing of the extension's |

---

## 4. Decision records

Each decision states the choice, why it is needed, what it costs, the
alternative rejected and why, the outcome it serves, and how it is verified.
Decisions are indexed in [section 9](#9-decision-index).

### DEC-B01. Steps are joined to code by action name through the catalog, not by matching the sentence

**Choice.** The extension's central key is the action name. A step's `action:`
value is looked up in the catalog and in the registration sites found in the
four bindings. The sentence under `given`/`when`/`then`/`and` is shown in hover
and in test names and is never matched against anything.

**Why.** That is what the format means. In `yml_suite_design.md` (1.2, DEC-Y22)
a sentence is documentation and the action is what runs. An extension that
matched sentences would bind steps to code the runner never calls.

**Cost.** The prototype's matching engine (pattern compilation, expression to
regex, regex to snippet) is discarded. Teams using real Gherkin with Reqnroll or
godog are not served by this extension.

**Rejected.** Keeping the prototype's model and adding the catalog beside it.
Two joins for one step would disagree whenever a sentence happened to match a
definition the action does not use, and the format has no definitions to match
against in the first place.

**Serves.** O3, O4. **Verified by.** E-B3, E-B4.

### DEC-B02. Diagnostics come from a binding's own `lint --json`; the extension is not a validator

**Choice.** Every `E`/`W` diagnostic the extension shows is one a binding's lint
program printed, with that program's code, position and message. The extension
computes none of them.

**Why.** The format's whole design (DEC-Y01, DEC-Y11) is that rules live in one
schema and four implementations agree through a corpus. A TypeScript validator
would be a fifth implementation outside that corpus; the first disagreement
would show an author an error that CI does not raise, or hide one it does.
`yml_suite_design.md` 6.4 lists nine defects that a second implementation
exposed in the first; a fifth that is never run in CI would carry such defects
silently.

**Cost.** A process start per lint (latency is measured and bounded in plan
step B2.5), and a lint tool must be built or installed. `E2xx`/`E3xx` findings
appear on save, not per keystroke.

**Rejected.** (a) Re-implementing semantics and dataflow in TypeScript, for
the reason above. (b) Showing only what the schema shows, which is today's gap.
(c) Running lint as a long-lived language server: none of the bindings has a
server mode, and adding one changes four programs to serve one editor.

**Serves.** O1, O8. **Verified by.** E-B1, E-B11.

### DEC-B03. Lint runs on files on disk, on open and on save; live typing stays with the YAML extension

**Choice.** The lint controller lints a suite when it is opened and each time
it is saved, using the file on disk. While the author types, structural
checking (`E101`-`E105`) comes from `redhat.vscode-yaml` through the committed
schema mapping, which the extension declares as a dependency and does not
duplicate.

**Why.** A suite's meaning depends on files beside it: `imports:` are resolved
relative to the importing file, and the diagnostic's `file` field is
repository-relative. Linting the saved file gives the same answer CI gives.

**Cost.** After an edit and before the next save, `E2xx`/`E3xx` diagnostics
describe the saved file and can sit on lines that have moved. The extension
does not shift them; the next save replaces them.

**Rejected.** Writing the unsaved buffer to a temporary file and linting that.
Imports would resolve from the temporary directory and fail, and every
diagnostic would name the temporary file. Writing the temporary file *beside*
the real one would make it visible to the bindings' globs, to git and to other
lint runs.

**Serves.** O1. **Verified by.** E-B1.

### DEC-B04. The lint tool and the target binding are separate choices; Go is the default lint tool

**Choice.** Two settings. `bddSuite.lintTool` names whose program lints (default
`go`). `bddSuite.targetBinding` names the binding the author intends to run with
(default `powershell`); lint is invoked with `--binding-check --binding
<target>` so `E201` reports what *that* binding cannot run.

**Why.** Every `suiterun` reads the same catalog, so any of them can answer
"can Rust run this" (the Go program accepts `--binding rust`). Separating the
two lets an author lint with the fastest program while targeting the binding
they will actually use. The default target is PowerShell because it is the
binding CI runs against the WSFC lab and the only one that implements every
action; an author targeting Go changes one setting.

**Cost.** One more setting to understand. If the lint tool's binary is older
than the catalog it reads, its answers are about the current catalog but its
own rules may be older; the coverage view's `actions --json` check (O6) is how
that is noticed.

**Rejected.** (a) Always lint with the target binding's own program: PowerShell
is the default target and its lint path starts `pwsh` and imports a 109 KB
module on every save. (b) Lint with all four and merge: four processes per save
for findings the corpus already guarantees are identical.

The default lint tool is provisional on measurement. Plan step B2.5 measures
lint latency on `lifecycle-stage1.yml` (the largest suite) for all four tools
and makes the fastest the default; if that is not Go, the step records the
change and the reason here.

**Serves.** O1, O2. **Verified by.** E-B1, E-B2.

### DEC-B05. Registration sites are found by per-language recognizers, which are configuration

**Choice.** For each binding, the settings name source globs, exclusion globs
and a list of recognizers: a regular expression with a named group `name` (the
action) and an optional named group `handler`. The defaults match the shapes
listed in [2.2](#22-the-four-bindings-as-the-extension-will-meet-them),
including each binding's special case for `wait`.

**Why.** Registration in all four bindings is a literal string next to a handler
on one line. A regular expression finds it in a 179 KB file in well under a
millisecond and needs no compiler, toolchain or language server. Keeping the
patterns in settings means a fifth binding, or a refactor of an existing
registry, is a settings change, not an extension release.

**Cost.** A pattern can miss an unusual registration (a name built at run time)
or match a string that only looks like one. Both show up as drift in the
coverage view, and the acceptance scenario requires zero drift on a clean tree,
so the defaults are held to precision by a test, not by hope. Names built at
run time cannot be found this way at all; the `actions --json` cross-check is
the authoritative answer and the view shows both.

**Rejected.** (a) Each language's language server (workspace symbols). Four
servers must be installed and running, and none of them knows a dictionary key
is an action name. (b) Asking each binding's `actions --json` for names only: it
gives names without positions, needs four built programs, and cannot navigate.
(c) Requiring an annotation comment at each registration: it changes four
codebases for the editor's benefit and can itself drift.

**Serves.** O3, O6. **Verified by.** E-B3, E-B7.

### DEC-B06. The registration site is the definition; the handler body belongs to the language's own tooling

**Choice.** Go to Definition on an action name returns the catalog entry and the
registration site in each binding. It does not try to locate the handler
function's body.

**Why.** The registration line names the handler (`get`, `core_noop`,
`context.Get(request)`), and from there each language's own extension resolves
it exactly, including closures and helpers such as Go's
`bySuffix("rollback", true)`, which a regular expression cannot follow.

**Cost.** Reaching a handler body is two gestures, not one.

**Rejected.** A second recognizer per language for function definitions: it
would be wrong for closures, generated handlers and methods on a context, which
are all present today.

**Serves.** O3. **Verified by.** E-B3.

### DEC-B07. One in-memory index, parsed with positions, updated per file

**Choice.** The workspace index is built at activation and updated per file:
on save or file-system change, and for open documents on edit after a 250 ms
pause. Suites and libraries are parsed with the `yaml` package's document API
with ranges; source files are scanned as text. Providers answer from the index
and never read files.

**Why.** Every provider needs positions, and a hover or completion that parses
a 68 KB file per keystroke would be visibly slow. Per-file updates keep the
cost proportional to the edit.

**Cost.** Memory for the index of 29 suites, 100 catalog entries and a few
hundred source files: small, and bounded by the file-size limit in the plan.

**Rejected.** Parsing on demand in each provider: repeated work and no way to
answer "who uses this" without scanning everything.

**Serves.** O3, O4, O8. **Verified by.** E-B3, E-B5, E-B8.

### DEC-B08. Completion inside `${ }` uses an approximate scope; lint decides correctness

**Choice.** The extension tokenises the expression around the cursor to know
what is being typed (a namespace, a path segment, a function name) and offers
candidates from a scope it computes from the index: captures produced by
earlier steps of the same case (including suite `setup`, `beforeEach`, case
`setup`, and meta step exports), suite and case parameters including imported
ones, variables declared earlier, `row` columns where a table or `examples`
applies, the context keys (`cluster`, `target`, `timeoutSec`, `labId`,
`apiUrl`, `defaults`), and the 21 functions. It never evaluates an expression
and never reports a scope error.

**Why.** Suggestions need to be instant and need positions; a lint run can do
neither. Errors, though, must agree with CI, so the extension suggests and lint
judges (DEC-B02).

**Cost.** The scope model is an approximation of the bindings' dataflow pass.
In a corner the bindings treat differently it may offer a name lint then
rejects. One such corner is known: a meta step used twice in one case
(implementation plan open question 4 in `os-context`). The approximation errs
toward offering, and the next save shows the truth.

**Rejected.** Running lint with a probe expression to ask what is in scope:
seconds per keystroke, and no binding has a verb for it.

**Serves.** O4. **Verified by.** E-B5.

### DEC-B09. Action names are completed by the extension, with binding support shown

**Choice.** After `action:`, the extension offers every catalog action, each
with its summary and the bindings that implement it; actions the target
binding lacks are listed after the ones it has.

**Why.** The schema declares `action` as a plain string (`stepEnvelope` in
`suite.base.json`), so the YAML extension offers nothing here. This is also the
moment portability matters most: before the step is written around an action
the target binding cannot run.

**Cost.** If a later schema adds an enum for `action`, both extensions will
offer the names. Plan step B3.1 checks the YAML extension's behaviour on the
current schema and records it; a schema change that adds an enum becomes a
known follow-up to suppress one list.

**Rejected.** Leaving action completion to the schema: it has none.

**Serves.** O2, O4. **Verified by.** E-B2, E-B5.

### DEC-B10. Scaffolding writes real signatures into real registries, then runs the repository's generator

**Choice.** Two commands. *Declare action* (a quick fix on `E104`, or a command)
inserts a catalog entry with the step's parameters typed from their YAML
values, `bindings: [powershell]`, an open capture shape and a summary
placeholder, and creates `scripts/e2e/actions/<Name>.ps1` with a
`Register-LabAction` stub. *Implement in binding* adds, for Go, Rust or C#, a
registration in that binding's registry and a stub handler whose body fails
with the binding's own failure constructor, and adds the binding to the
catalog entry's `bindings:`. Both then run `Build-Schema.ps1`. Stub text comes
from templates shipped with the extension that a workspace may override.

| Binding | Registry the stub goes into | Stub fails with |
| --- | --- | --- |
| PowerShell | new file `scripts/e2e/actions/<Name>.ps1` | `throw '<action>: not implemented in the PowerShell binding yet'` |
| Go | `Registry()` in `internal/actions/actions.go`, or `handlers` in `internal/lifecycle/actions.go` for `lifecycle.*` | `Failed(...)` / `actions.Failed(...)` |
| Rust | `registry()` in `src/actions.rs`, or `names()` and `dispatch()` in `src/lifecycle/actions.rs` for `lifecycle.*` | `Err(ActionError::action(...))` |
| C# | `CoreActions.Registry`, or `LifecycleContext.Handlers` for `lifecycle.*` | `throw ActionException.Failed(...)` |

**Why.** The PowerShell registration is not optional: a test in
`scripts/e2e/SuiteLint.Tests.ps1` asserts the catalog's names and
`Get-LabActionNames` are the same set, so declaring without registering breaks
the build. Adding a binding to `bindings:` together with its stub keeps the
coverage view free of drift, and the stub fails loudly, so a suite that uses an
unfinished action fails with a sentence saying so rather than passing.
`Build-Schema.ps1` runs because the committed schema must match the catalog
(`suite-lint` runs it with `-Check`).

**Cost.** Templates encode each binding's current handler signature; a refactor
of a registry means updating a template. The scenario compiles every stub, so
a stale template fails a test rather than an author.

**Rejected.** (a) Generating handler logic from the catalog: the catalog says
what an action takes, not what it does. (b) Writing the schema directly:
breaks INV-1 and duplicates the generator.

**Serves.** O5. **Verified by.** E-B6.

### DEC-B11. A run is one suite file under the target binding, mapped from its trace

**Choice.** Test Explorer lists each case as a test item, and each `examples`
row of an outline as a child. Running an item runs its whole suite file with
`suiterun run --path <file> --trace-file <tmp> --results <tmp>` (or the
PowerShell equivalent, which can also select one case with `-TestName`), then
maps the trace's `case` entries to items. Lab runs take `--api-url`, `--lab-id`
and `--connection-file` from settings or a prompt at run time.

**Why.** The trace is the bindings' machine-readable, conformance-checked
account of what ran (`test/e2e/conformance/execute/*.expected.json` pins it), so
results shown in the editor are the ones CI would compute. `suiterun` has no
case-name filter, so a single case cannot be selected under Go, Rust or C#
without changing the shared command-line contract.

**Cost.** Running one case under Go, Rust or C# runs its siblings too; the
editor says so before starting a lab run. Adding a case filter to DEC-Y14 is an
open question in the plan, not part of this work.

**Rejected.** (a) Parsing human output: not a contract. (b) Parsing the NUnit
report only: it lacks phase order and step provenance that the trace carries.
(c) Filtering with `--tags`: tags select by label, and a case's tags are not
unique to it.

**Serves.** O7. **Verified by.** E-B9, E-B10.

### DEC-B12. A lab run is always an explicit act, never a side effect

**Choice.** Nothing runs a suite on open, save or index. A run against a lab
starts only from a Test Explorer action or a command, after the extension shows
the target binding, the lab id, the API URL and the cases `list` selected, and
the operator confirms. Cancelling a lab run asks before killing the program and
says that the suite's cleanup and teardown may not run.

**Why.** A suite can create runs on a lab (the `bootstrap, portable` case in
`lifecycle-stage0.yml` submits a bootstrap). An editor that ran it by accident,
or killed it mid-step without warning, would leave state behind that only the
suite's own cleanup knows how to remove.

**Cost.** One confirmation per lab run.

**Rejected.** Running without confirmation when settings are complete: settings
persist across days and labs, and the operator should see which lab is about to
be driven.

**Serves.** O7. **Verified by.** E-B10.

### DEC-B13. Defaults match `os-context`; the extension activates where a catalog exists

**Choice.** Every path setting defaults to the `os-context` layout. The
extension activates on `workspaceContains:**/test/e2e/schema/actions.catalog.yaml`
and on YAML files, finds the repository root as the folder holding
`test/e2e/schema` (the rule every `suiterun` uses), and stays inert in a
workspace with no catalog. A file is treated as a suite when it matches
`bddSuite.suiteGlobs` *and* has a top-level `suite:` key, or is listed in some
suite's `imports:`.

**Why.** Zero configuration for the repository this exists for, and no effect on
any other YAML. Detecting suites by content, not only by path, keeps
`actions.catalog.yaml`, `run-manifest.yaml` and corpus tables out of the index
even though they sit under `test/e2e`.

**Cost.** A suite outside the globs is not indexed until the glob is widened.

**Rejected.** Activating on every YAML file with no catalog check: every YAML
workspace would pay for an index it cannot use.

**Serves.** O1 to O8. **Verified by.** E-B1, E-B11.

### DEC-B14. Proof runs in a real VS Code against the real `os-context` checkout and its corpus

**Choice.** Core modules (catalog, indexer, recognizers, scope, coverage, trace
mapping, stub rendering) are free of the `vscode` API and unit-tested in Node.
The scenarios in section 7 run in a real VS Code extension host
(`@vscode/test-electron`) against the real `os-context` checkout, read-only,
with real binding programs. Scenarios that change files do so in a disposable
`git worktree` of `os-context`. Expected values come from `os-context`'s own
artefacts (corpus expectation files, the catalog, `actions --json`), not from
numbers copied into this repository.

**Why.** The extension's value is the join between files it does not own. A
fixture copied into this repository would pass while `os-context` moved on.
Using the corpus as the oracle means the extension is held to the same
definition of correct as the four bindings.

**Cost.** The integration suite needs an `os-context` checkout and built
binding programs; the plan states how to provide them.

**Rejected.** Mocked binding programs for the scenarios: they would prove the
extension parses what the mock prints, not what the bindings print. A small
fake program is still used in unit tests for process handling (timeouts,
oversize output, bad JSON), where a real one cannot be made to misbehave on
demand.

**Serves.** O1 to O8. **Verified by.** every scenario in section 7.

---

## 5. What the author sees

One worked example, a case from a lifecycle suite, annotated with what each
gesture does.

```yaml
tests:
  - name: E-R1-a-declared-limit-is-enforced
    steps:
      - when: a bootstrap is submitted for the selected lab
        action: lifecycle.submit        # (1) (2) (3)
        route: /labs/bootstrap
        body: { plan: '${capture.source.plan}' }   # (4)
        captureAs: accepted
      - then: the run is readable by that identifier
        action: lifecycle.get
        route: /labs/${capture.accepted.}            # (5)
        captureAs: run
      - and: the node is suspended
        action: cluster.suspend         # (6)
        node: ${param.node}
      - meta: select-lab                # (7)
        with: { labId: '${labId}' }
```

1. **Hover** on `lifecycle.submit` shows the catalog summary, the parameter
   table, the capture shape, `interruptible`, notes, and a line per binding:
   PowerShell, C#, Go, Rust, each a link to its registration site.
2. **Inlay hint** after the action name: `PS C# Go Rs`. For an action with fewer
   bindings it lists only those (`PS`).
3. **Go to Definition** opens a peek with five locations: the catalog entry and
   the four registration sites. **Find All References** lists every step in the
   workspace that uses `lifecycle.submit`.
4. **Hover** on `capture.source` names the step that produced it (here a
   `beforeEach` meta step from `_lib/lifecycle.yml`) and its declared shape.
5. **Completion** after `capture.accepted.` offers the properties of
   `lifecycle.submit`'s capture shape, or says the shape is open when the
   catalog declares `additionalProperties: true`.
6. With the target binding set to `go`, saving marks this line `E201` (Go does
   not implement `cluster.suspend`; PowerShell does), and the inlay hint shows
   `PS` only.
7. **Go to Definition** on `select-lab` opens its definition in
   `_lib/lifecycle.yml`; completion inside `with:` offers its parameters.

From the other side, in `test/e2e/bindings/go/internal/lifecycle/actions.go`,
the line `"lifecycle.get": get,` carries a CodeLens: `14 suite steps` (the
number is whatever the index finds), and clicking it lists them.

The **Suite bindings** view, in the Explorer side bar:

```
Binding      Source                         Declared   Found   Drift
PowerShell   scripts/e2e/                   100        100     0
Rust         test/e2e/bindings/rust/        24         24      0
Go           test/e2e/bindings/go/          24         24      0
C#           test/e2e/bindings/dotnet/      24         24      0
```

Each row expands to its drift list, and a toolbar action runs each built
program's `actions --json` and adds a column with its answer.

---

## 6. Failure behaviour

What happens when something the extension depends on is missing or wrong. In
every case the rule is the same: say what failed and where, keep the last good
state visible as such, and never show an empty result as if it were a clean
one.

| Situation | What the author sees | What is kept | Recovery |
| --- | --- | --- | --- |
| No catalog in the workspace | Nothing; the extension is inert | n/a | Open a repository with a catalog, or set `bddSuite.catalogPath` |
| Catalog does not parse | An error notification with file, line and parser message; one diagnostic on the catalog at that position | The last catalog that parsed, marked stale in the status bar | Fix the file; the next save reloads it |
| Lint tool not found or not built | A status-bar item "Lint: go not built", and a notification offering *Build lint tool* or *Choose another* | Any diagnostics from a previous lint, marked stale | Build or switch tool; next save lints |
| Lint exceeds `LINT_TIMEOUT_MS` | The process tree is killed; status bar "Lint timed out after 20 s" with a link to the output channel | Previous diagnostics, marked stale | Next save retries; repeated timeouts suggest another tool |
| Lint exits 2 with output that is not a diagnostic array | Treated as a harness error, not as "no findings"; the program's error output goes to the output channel and a notification | Previous diagnostics, marked stale | Fix the binding or switch tool |
| Lint output exceeds `MAX_TOOL_OUTPUT_BYTES` | Treated as a tool failure, never truncated into a partial list | Previous diagnostics, marked stale | Report as a binding defect |
| Two saves in quick succession | The first lint is cancelled and its output discarded | Only the newest result is published | Automatic |
| A recognizer matches nothing for a binding | The coverage row shows Found 0 and every declared action as drift | n/a | Fix the recognizer setting |
| A recognizer pattern is not a valid regular expression | An error naming the setting and the pattern | Other recognizers keep working | Fix the setting |
| `Build-Schema.ps1` fails after scaffolding | A notification with its error output; the catalog and stub edits stay in place and can be undone | The edits, unsaved, in one undo step per command | Fix and re-run *Regenerate schema*, or undo |
| A stub's target registry has a shape the template does not recognise | The command refuses before editing anything and names the file and the anchor it looked for | Nothing changed | Update the template override |
| A run's trace file is missing or malformed | Every item in that run is marked errored with "no trace"; the program's output is attached | The NUnit report, if written | Inspect the output channel |
| An offline run is cancelled | The program is killed; items not reported are marked skipped | Partial trace, if any | Re-run |
| A lab run is cancelled | Confirmation first, warning that cleanup and teardown may not run; then the program is killed | Partial trace; the extension does not touch the lab | The operator checks the lab and runs the suite's cleanup case if one exists |

Resource ownership, stated once because a run can create things: the
extension owns only the processes it starts and the temporary files it names
(trace and report paths under the extension's storage folder, deleted when the
next run of the same file starts). Lab resources a suite creates are owned by
that suite run, recorded by the lab's API, and removed by the suite's own
`cleanup`, `afterEach` and `teardown`. The extension never adopts, deletes or
retries anything on a lab.

---

## 7. Verification

Every scenario runs in a real VS Code extension host against the
`os-context` checkout (DEC-B14), driven by this repository's integration
harness. The controller is the developer's machine. Only E-B10 needs a lab. Each
names the outcome it proves and the plan steps that it signs off.

Common Given for E-B1 to E-B9 and E-B11, unless a scenario says otherwise:

* `os-context` checked out at a recorded commit, path in `OS_CONTEXT_ROOT`.
* The Rust, Go and C# `suiterun` programs built from that commit at the paths
  the plan's working rules name; `pwsh` 7 on the path.
* `redhat.vscode-yaml` installed in the test VS Code.
* The extension under test loaded from the `.vsix` built from a recorded commit
  of this repository (in the build stages, from the development build).

### E-B1. The editor shows exactly what the corpus says lint must find

* **Given.** Every `validate` entry listed in
  `test/e2e/conformance/run-manifest.yaml` that has no `catalogOverlay` (an
  overlay is a corpus-only mechanism the editor does not use), each with its
  `<stem>.expected.json`. Among them, `typos.yml` (`E101`, `E104`, `E101`),
  `gherkin.yml` (`E212` to `W304`), `meta.yml` (`E207`), `dataflow.yml`
  (`E3xx`) and `portability.yml` (`E201`). Target binding: the entry's
  `binding` where it sets `bindingCheck: true`, otherwise `powershell` (which
  implements every action, so the portability check adds nothing). Lint tool:
  each of `go`, `rust`, `csharp`, `powershell` in turn.
* **When.** The harness opens each file in the editor and waits for the lint
  controller's "published" event, then saves it unchanged and waits again.
* **Then.** For each file and each tool, the diagnostics the editor holds for
  that file, as `(code, severity, line, column)` with line and column converted
  back to one-based, equal the `diagnostics` array of the expectation file, in
  the same order. Each diagnostic's source is `suiterun:<tool>`. The save
  produced the same set, not a doubled one.
* **Cleanup.** None; nothing is written.
* **Proves.** O1; plan steps B2.1, B2.2, B2.5.

### E-B2. A step the target binding cannot run is marked, and says who can

* **Given.** `test/e2e/suites/smoke.yml`, which uses `cluster.state` and
  `invoke` (PowerShell only). Target binding `rust`, lint tool `go`.
* **When.** The harness opens and saves the file, then requests inlay hints and
  action completion on the first step.
* **Then.** The editor's `E201` diagnostics are exactly those printed by
  `suiterun lint --path test/e2e/suites/smoke.yml --json --binding-check
  --binding rust` run by the harness in a terminal from the repository root.
  Each step whose action is PowerShell-only carries the inlay hint `PS`; a
  `core.noop` step carries `PS C# Go Rs`. In the completion list after
  `action: `, every action whose catalog `bindings` include `rust` sorts before
  every action whose list does not. With the target switched to `powershell`
  and the file saved again, no `E201` remains.
* **Cleanup.** Reset the two settings.
* **Proves.** O2; plan steps B1.2, B2.3, B3.1.

### E-B3. Go to Definition on an action lists the catalog entry and every registration

* **Given.** `test/e2e/suites/lifecycle-stage0.yml`, a step using
  `lifecycle.get`; `test/e2e/suites/smoke.yml`, a step using `cluster.state`;
  any step using `wait` (the harness finds one with the index, or a scratch
  file in the worktree if none exists).
* **When.** The harness runs `vscode.executeDefinitionProvider` at the action
  value of each.
* **Then.** For `lifecycle.get`: exactly five locations, namely the catalog's
  `- name: lifecycle.get` line, and one registration each in
  `scripts/e2e/actions/` (`Register-LabAction -Name 'lifecycle.get'`),
  `test/e2e/bindings/go/internal/lifecycle/actions.go`
  (`"lifecycle.get": get,`), `test/e2e/bindings/rust/src/lifecycle/actions.rs`
  (the `"lifecycle.get" =>` dispatch arm), and
  `test/e2e/bindings/dotnet/Hci.E2E.Suite/Actions/Lifecycle/LifecycleActions.cs`
  (`["lifecycle.get"] =`). The harness checks each location's line text with
  the substring in parentheses. For `cluster.state`: exactly two (catalog and
  PowerShell). For `wait`: catalog, `Wait.ps1`, and the `wait` lines in Go
  `exec.go`, Rust `actions.rs` and C# `Executor.cs`. Go to Definition on
  `meta: select-lab` in a stage 0 case returns the definition in
  `_lib/lifecycle.yml`.
* **Cleanup.** None.
* **Proves.** O3; plan steps B1.3, B1.4, B1.6.

### E-B4. A registration site shows, and lists, the steps that use it

* **Given.** The Go registration line `"lifecycle.get": get,` and the catalog
  entry for `lifecycle.get`.
* **When.** The harness asks for CodeLenses on the Go file and runs
  `vscode.executeReferenceProvider` on the registration line and on the catalog
  entry's name.
* **Then.** The reference list is identical from both places, and its length
  equals the lens's count. Its members are exactly the steps whose `action`
  value is `lifecycle.get`, which the harness determines independently by
  parsing every suite and library with the `yaml` package (not with the
  extension's indexer) and walking every step list, including those inside
  `metaSteps`, hooks and libraries.
* **Cleanup.** None.
* **Proves.** O3; plan step B1.5.

### E-B5. Completion offers what is in scope, and nothing the format forbids

* **Given.** A scratch suite written by the harness into the worktree under
  `test/e2e/suites/_scratch-b5.yml`, importing `_lib/lifecycle.yml`, with a
  suite `setup` capturing `agent`, a case whose first step is
  `action: cluster.state` with `captureAs: cs`, a parameter `node`, a variable
  `limit`, a step with a two-column `table:`, and an `examples:` case.
* **When.** The harness requests completion at marked positions.
* **Then.**
  - After `${`: the namespaces `capture`, `param`, `var`, the context keys, and
    the 21 functions; `row` only inside the table step and the outline case.
  - After `${capture.` in the second step: `agent` and `cs`; not a capture
    produced by a later step or another case.
  - After `${capture.cs.`: exactly the property names of `cluster.state`'s
    capture shape in the catalog.
  - After `${param.`: `node` and the parameters `_lib/lifecycle.yml` declares.
  - After `${row.` in the table step: the two column names.
  - After `meta: `: the meta steps declared locally and in `_lib/lifecycle.yml`;
    inside its `with:`, that meta step's parameters.
  - After `action: `: all 100 actions, each once in the extension's list.
* **Cleanup.** Delete the scratch file; the worktree is disposed at the end of
  the run.
* **Proves.** O4; plan steps B3.1 to B3.5.

### E-B6. A new action is declared and implemented in all four bindings from the editor

* **Given.** A fresh `git worktree` of `os-context` at the recorded commit. A
  scratch suite with a step `action: demo.echo` and parameters
  `text: hello` and `times: 2`.
* **When.**
  1. Save; the YAML extension underlines `demo.echo` (`E104`) and lint reports
     it. Apply the quick fix *Declare action demo.echo*.
  2. Run *Implement demo.echo in Go*, then in Rust, then in C#.
  3. In the worktree, run `pwsh -File test/e2e/schema/Build-Schema.ps1 -Check`,
     the PowerShell catalog test
     (`Invoke-Pester scripts/e2e/SuiteLint.Tests.ps1`), `go build ./...` and
     `go vet ./...` in the Go module, `cargo build` in the Rust crate,
     `dotnet build` of the solution, and each built program's `actions --json`.
* **Then.** The catalog has a `demo.echo` entry with `text: string` and
  `times: integer` and finally `bindings: [powershell, go, rust, csharp]`;
  `scripts/e2e/actions/DemoEcho.ps1` registers it; `-Check` exits 0; the Pester
  file passes; all three builds succeed; every `actions --json` includes
  `demo.echo`; saving the scratch suite clears `E104`. Running the scratch
  suite under each binding fails the step with a message containing
  `not implemented`. Undo in the editor reverts each command's text edits in
  one step.
* **Cleanup.** Remove the worktree (`git worktree remove --force`). If removal
  fails, the harness prints its path and leaves it for inspection; it is never
  inside the main checkout.
* **Proves.** O5; plan steps B5.1 to B5.4.

### E-B7. The binding table matches the catalog and the binaries, and drift appears when introduced

* **Given.** The clean `os-context` checkout and the three built `suiterun`
  programs; a worktree for the second half.
* **When.** The harness reads the coverage view's model, then runs *Verify with
  binding programs*. In the worktree, it deletes the Rust dispatch arm for
  `lifecycle.get` and saves the file.
* **Then.** On the clean tree: Declared is 100, 24, 24, 24 for PowerShell, Rust,
  Go, C# (whatever `actions.catalog.yaml` declares at the recorded commit, read
  independently by the harness); Found equals Declared; Drift is 0 for every
  row; each program's `actions --json` set equals the catalog's set for that
  binding and equals Found. In the worktree, within 2 s of the save, the Rust row
  shows Drift 1 naming `lifecycle.get` as "declared, not registered".
* **Cleanup.** Remove the worktree.
* **Proves.** O6; plan steps B4.1 to B4.3, and the recognizer defaults of B1.4.

### E-B8. A catalog change is picked up without a reload

* **Given.** A worktree; a suite open in the editor with a `cluster.resume`
  step.
* **When.** The harness edits the catalog in the worktree to add parameter
  `reason: string` to `cluster.resume`, saves it, and runs `Build-Schema.ps1`.
* **Then.** Without reloading the window, hover on `cluster.resume` lists
  `reason`, and key completion inside the step offers it (from the YAML
  extension reading the regenerated schema, or from the extension; the scenario
  asserts it is offered, once).
* **Cleanup.** Remove the worktree.
* **Proves.** O8; plan steps B1.2, B1.7 (hover) and B3.4 (completion).

### E-B9. An offline suite runs under each binding, and each case shows the corpus result

* **Given.** `test/e2e/conformance/execute/gherkin.yml` and
  `execute/case-setup-fails.yml` with their expected traces. No lab.
* **When.** For each of the four bindings as target, the harness runs the file's
  test items through the Test Explorer API.
* **Then.** Each case item's result (passed, failed, errored) equals the
  outcome of that case's `case` entry in the expected trace; outline rows appear
  as child items named `<case> [<column>=<value>, ...]` with their own results;
  failed items carry the failing step's keyword and sentence in their message.
  The four bindings produce the same item results.
* **Cleanup.** Temporary trace and report files are deleted by the next run.
* **Proves.** O7 (offline half); plan steps B6.1 to B6.3 and B6.5.

### E-B10. The portable stage 0 cases run from the editor against a real lab

* **Given.**
  - A lab whose lifecycle API is deployed and reachable from the controller,
    with its host already bootstrapped (the state `lifecycle-stage0.yml`'s
    portable cases expect). The operator supplies at run time the API URL, the
    lab's lineage id (the identifier the API records, not the connection file's
    friendly name; `yml_suite_design.md` 6.4), and the path to the lab's
    connection file. No credential is typed into or stored by the extension.
  - Target binding `go`. Tag filter `portable`. This is the selection
    `os-context`'s own E-Y7 ran on lab1 on 2026-09-12 under Go, Rust and C#
    (eight cases, all passed), so the scenario tests the extension's path, not a
    new use of the lab.
  - Footprint, stated before running: seven of the eight cases only read, or
    ask questions the API answers without acting (`lifecycle.cleanup` before
    Onboard, a `dryRun` rollback). `S0-48-ready-host-bootstrap-is-verified`
    submits a bootstrap to the already-ready host, which verifies it and leaves
    one succeeded run record of kind `bootstrap` per execution. The scenario
    executes the selection twice (editor, then terminal), so it leaves two.
  - Preflight, by the harness, before anything runs: `suiterun list --path
    test/e2e/suites/lifecycle-stage0.yml --tags portable` lists exactly the
    cases the extension's index finds with the `portable` tag, and every action
    those cases use lists `go` in the catalog. If either fails, the scenario
    stops without running.
* **When.** From Test Explorer, the operator runs the file with the tag filter.
  The extension shows its confirmation (binding, lab id, API URL, case list);
  the operator confirms. Then, in a terminal on the same machine, the operator
  runs the identical `suiterun run` command the extension printed in its output
  channel, with a different `--results` path.
* **Then.** Each item's result equals the terminal run's NUnit result for that
  case; the extension's NUnit report, canonicalised as
  `test/e2e/conformance/report/canonicalise.md` describes (with
  `-IgnoreOutput`, since each run mints its own bootstrap run id), equals the
  terminal run's; both exit 0. Recorded: `os-context` commit, extension `.vsix`
  hash, lab id, API URL, start and end time, both report files, and the two
  bootstrap run ids from the reports' captured output.
* **Cleanup.** None by the extension, which owns nothing on the lab. The two
  bootstrap run records belong to the API's history, as E-Y7's did; the
  recorded ids let the operator find them. If a run fails partway, the operator
  checks the lab with the stage 0 `read-only` cases before any other use.
* **Proves.** O7 (lab half); plan step B6.4.

### E-B11. A missing, slow or broken lint tool is reported, not hidden

* **Given.** A suite with one known `E301` open in the editor, with that
  diagnostic shown from a successful lint.
* **When.** The harness, in turn: points the Go lint tool path at a file that
  does not exist; points it at a test program that sleeps past
  `LINT_TIMEOUT_MS`; points it at a test program that exits 2 and prints
  `not json`; points it at one that prints more than `MAX_TOOL_OUTPUT_BYTES`.
  After each, it saves the suite.
* **Then.** Each time: the status bar names the failure; the output channel has
  the program's error output; the previous `E301` is still shown and marked
  stale (its message is prefixed `[stale]`); no diagnostic set is replaced by an
  empty one; no child process remains after 1 s (checked by process id).
  Restoring the real path and saving clears the stale marks.
* **Cleanup.** Restore the setting.
* **Proves.** O1; plan step B2.4.

### Scope of the guarantee

Passing these scenarios proves the stated behaviour for the tested
`os-context` commit, the tested binding programs and the tested VS Code version,
on Windows. It does not prove behaviour on macOS or Linux (the process-tree
handling differs and is unit-tested only), against a catalog shape the
recognizers' defaults were not written for, or for a lab the read-only cases
were not run against.

---

## 8. Traceability

| Outcome | Decisions | Plan steps | Scenarios |
| --- | --- | --- | --- |
| O1 lint findings in place | DEC-B02, DEC-B03, DEC-B04, DEC-B13 | B2.1, B2.2, B2.4, B2.5 | E-B1, E-B11 |
| O2 binding support per step | DEC-B04, DEC-B09 | B1.2, B2.3, B3.1 | E-B2 |
| O3 navigation both ways | DEC-B01, DEC-B05, DEC-B06, DEC-B07 | B1.3, B1.4, B1.5, B1.6 | E-B3, E-B4 |
| O4 completion beyond the schema | DEC-B07, DEC-B08, DEC-B09 | B3.1, B3.2, B3.3, B3.4, B3.5 | E-B5 |
| O5 scaffolding | DEC-B10 | B5.1, B5.2, B5.3, B5.4 | E-B6 |
| O6 drift visible | DEC-B05 | B4.1, B4.2, B4.3 | E-B7 |
| O7 run from the editor | DEC-B11, DEC-B12 | B6.1, B6.2, B6.3, B6.4, B6.5 | E-B9, E-B10 |
| O8 no extension release for a format change | DEC-B02, DEC-B07 | B1.2, B1.7, B3.4 | E-B8 |
| (all) packaged and installable | DEC-B13, DEC-B14 | B1.1, B7.1, B7.2, B7.3 | all, re-run on the `.vsix` |

---

## 9. Decision index

| ID | Decision | Serves |
| --- | --- | --- |
| [DEC-B01](#dec-b01-steps-are-joined-to-code-by-action-name-through-the-catalog-not-by-matching-the-sentence) | Join on action name through the catalog, not on the sentence | O3, O4 |
| [DEC-B02](#dec-b02-diagnostics-come-from-a-bindings-own-lint---json-the-extension-is-not-a-validator) | Diagnostics come from a binding's `lint --json` | O1, O8 |
| [DEC-B03](#dec-b03-lint-runs-on-files-on-disk-on-open-and-on-save-live-typing-stays-with-the-yaml-extension) | Lint on open and save; live structure stays with the YAML extension | O1 |
| [DEC-B04](#dec-b04-the-lint-tool-and-the-target-binding-are-separate-choices-go-is-the-default-lint-tool) | Lint tool and target binding are separate; Go lints by default | O1, O2 |
| [DEC-B05](#dec-b05-registration-sites-are-found-by-per-language-recognizers-which-are-configuration) | Recognizers find registration sites, as configuration | O3, O6 |
| [DEC-B06](#dec-b06-the-registration-site-is-the-definition-the-handler-body-belongs-to-the-languages-own-tooling) | Registration site is the definition target | O3 |
| [DEC-B07](#dec-b07-one-in-memory-index-parsed-with-positions-updated-per-file) | One in-memory index, updated per file | O3, O4, O8 |
| [DEC-B08](#dec-b08-completion-inside---uses-an-approximate-scope-lint-decides-correctness) | Approximate scope for completion; lint decides | O4 |
| [DEC-B09](#dec-b09-action-names-are-completed-by-the-extension-with-binding-support-shown) | Extension completes action names with binding support | O2, O4 |
| [DEC-B10](#dec-b10-scaffolding-writes-real-signatures-into-real-registries-then-runs-the-repositorys-generator) | Scaffolding uses real registries and the real generator | O5 |
| [DEC-B11](#dec-b11-a-run-is-one-suite-file-under-the-target-binding-mapped-from-its-trace) | A run is one file, mapped from its trace | O7 |
| [DEC-B12](#dec-b12-a-lab-run-is-always-an-explicit-act-never-a-side-effect) | A lab run is always explicit | O7 |
| [DEC-B13](#dec-b13-defaults-match-os-context-the-extension-activates-where-a-catalog-exists) | `os-context` defaults; activate only where a catalog exists | O1-O8 |
| [DEC-B14](#dec-b14-proof-runs-in-a-real-vs-code-against-the-real-os-context-checkout-and-its-corpus) | Proof in real VS Code against real `os-context` | O1-O8 |
