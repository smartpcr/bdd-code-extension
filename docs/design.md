# Suite authoring in VS Code: design

**Status.** Design. Nothing described here is built yet. The companion
implementation plan is [implementation.md](implementation.md); it says *how*,
this document says *what* and *why*.

**Revision 2 (2026-10-14).** Adds a fifth binding, in TypeScript. It is built
in `os-context` beside the other four and held to the same conformance corpus.
The extension also loads it in-process, so suites can be linted while they are
being typed. New: outcomes O9 and O10; decisions DEC-B15 to DEC-B22;
scenarios E-B12 to E-B15; section [2.5](#25-admitting-a-fifth-binding).
Amended: DEC-B02, DEC-B03, DEC-B04, DEC-B05, DEC-B10 and DEC-B13, and every
scenario that counted bindings.

**What this is.** Two things that belong together:

1. A Visual Studio Code extension for writing the YAML test suites defined in
   the `os-context` repository (`E:\work\os\os-context`, design
   `docs/e2e/yml_suite_design.md`). Those suites are BDD-style: every step
   carries a Gherkin keyword and a sentence, and names an *action* that a
   *binding* executes. The extension helps two people see the vocabulary the
   bindings enforce, while typing, on save, and across the language boundary:
   the person writing a suite, and the person implementing an action in one
   of the binding languages.
2. A fifth binding of that format, in TypeScript on Node.js, built in
   `os-context` at `test/e2e/bindings/typescript/`. It joins the PowerShell,
   C#, Go and Rust bindings: the same command line, the same corpus, and the
   same 24 portable actions. Like any binding it is usable from CI and the
   lab workflow. It is also the binding the extension can run inside the
   editor.

**Who should read it.** Suite authors who want to know what the editor will do
for them; binding implementers who will see it from the other side; reviewers
deciding whether the approach is sound; and anyone new to the format, for whom
the vocabulary section is written.

Paths in `code font` that start with `test/`, `scripts/`, `docs/` or
`.github/` are paths in the `os-context` repository. Paths under `src/` are in
this repository, except `test/e2e/bindings/typescript/src/`, which is the
TypeScript binding's source in `os-context`.

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
  it implements. There are four today: PowerShell, C#, Go, Rust. This work
  adds a fifth, TypeScript (DEC-B15). Every binding except PowerShell ships a
  program named `suiterun`; the PowerShell one is
  `scripts/e2e/Invoke-LabTestSuite.ps1` plus the module
  `scripts/e2e/SuiteLint.psm1`.
* **Portable action.** One of the 24 actions every binding except PowerShell
  also implements: `core.noop`, `core.set`, `core.fail`, `core.sleep`,
  `core.record`, `wait`, and 18 `lifecycle.*` actions that speak HTTP and
  server-sent events (SSE) to the deployed lifecycle API. The other 76
  actions drive PowerShell Direct or WinRM and stay PowerShell-only.
* **Conformance corpus.** `test/e2e/conformance/`: suites paired with the exact
  diagnostics, execution trace or report they must produce, plus tables of
  expressions and assertion comparisons. A binding is correct when the whole
  corpus passes; no binding is the reference.
* **Capture, expression.** A step publishes its result under `captureAs: x`;
  later steps read it as `${capture.x}`. Anything inside `${ }` is an
  expression in a small fixed language (paths, operators, a closed function
  list).
* **Registration site.** The line in a binding's source where an action name is
  tied to the code that runs it. In PowerShell it is
  `Register-LabAction -Name 'cluster.resume' -Handler {`; in Go a map entry
  `"lifecycle.get": get,`; in Rust `map.insert("core.noop", core_noop)` or a
  dispatch arm `"lifecycle.get" => get(context, step)`; in C# a dictionary
  entry `["core.noop"] = Noop,`; in the TypeScript binding a call
  `action('lifecycle.get', get),` (DEC-B16). It is to this format what a step
  definition is to Cucumber.
* **Recognizer.** A pattern the extension uses to find registration sites in
  one language's source files. Recognizers are configuration, not code
  (DEC-B05).
* **Index.** The extension's in-memory map of where things are: every step and
  the action it names, every registration site, every meta step definition and
  use, every capture. It answers "where", never "is this valid" (DEC-B02).
* **Lint tool, target binding.** The *lint tool* is the binding whose code the
  extension runs to get diagnostics: a command-line program, or the
  TypeScript binding's library loaded inside the editor. The *target binding*
  is the binding the author intends to run the suite with; lint checks that it
  implements every action the suite uses. They are separate settings because
  any binding can answer the question for any other (DEC-B04).
* **Live lint.** Linting the text in the editor before it is saved. Only the
  TypeScript binding can do it, because only its library runs inside the
  editor and accepts unsaved text in place of a file (DEC-B20).
* **Workspace trust.** VS Code's switch that says whether a folder's code may
  run. Every binding program and the TypeScript library are code from the
  folder, so in an untrusted folder none of them runs (DEC-B22).
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
                                      csharp, go, rust,    +-->  TypeScript  action('lifecycle.get', get),
                                      typescript]
  sentence: printed in reports    the vocabulary                 the implementations
  action: what runs               (one file)                     (five languages)
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
* **Every binding is a separate program, and none can see unsaved text.** All
  four bindings read files from disk in a process of their own. An editor that
  asks them gets an answer about the saved file, at the cost of a process
  start, and nothing while the author types. None of the four is written in
  the language the editor's extensions are written in, so none can be loaded
  into the editor and handed the buffer.
* **A fifth binding is anticipated but not built.** `os-context`'s own plan
  (`yml_suite_implementation.md`, open question 3) names TypeScript as a
  foreseeable fifth binding: "the corpus is what makes it a week of work
  rather than a negotiation". Its design (6.5) says a fifth binding "needs
  nobody's permission and no negotiation. It needs the corpus to go green."
  A TypeScript binding is useful on its own, as one more check that the corpus
  pins the format. It is also the one binding the editor can host, which
  removes the gap in the bullet above.

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
| TypeScript binding implementer | Builds and maintains the fifth binding in `os-context` | The same corpus, command line and catalog rules as the other four, and the defects they already found, written down before the first line |
| CI owner | Keeps `suite-conformance.yml` and `e2e-tests.yml` green | A fifth job and a fifth `binding` option that behave like the other four |
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
step shows which of the five bindings implement its action; a step the target
binding cannot run is marked with `E201` (after save, or while typing with the
TypeScript lint tool). Proved by
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
Rust, C# or TypeScript binding. Proved by
[E-B6](#e-b6-a-new-action-is-declared-and-implemented-in-every-binding-from-the-editor).

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
soon as the file is saved, without reinstalling or reloading. The TypeScript
binding's library is loaded from the workspace too, never bundled into the
extension, so it is always the version the corpus at that commit pins. Proved by
[E-B8](#e-b8-a-catalog-change-is-picked-up-without-a-reload).

**O9. The format runs from TypeScript, and the corpus says it is the same
format.** A TypeScript binding in `os-context` lints, lists, runs and reports
through the shared command line. It implements the 24 portable actions. It
passes the whole conformance corpus with no entry skipped, runs as a fifth job
in `suite-conformance.yml`, and is a fifth `binding` choice in `e2e-tests.yml`.
On a lab, the portable stage 0 cases give the same canonical report under
TypeScript as under Go. Proved by
[E-B12](#e-b12-the-typescript-binding-passes-the-whole-conformance-corpus) and
[E-B13](#e-b13-the-typescript-binding-runs-the-portable-stage-0-cases-on-a-lab-with-the-same-report-as-go).

**O10. Every finding appears while typing, before the file is saved.** With
the TypeScript binding as the lint tool, the extension lints the editor's text
inside the editor. An unsaved buffer gets exactly the diagnostics the saved
file would get, at the same positions, within a second of the author pausing.
Proved by
[E-B14](#e-b14-an-unsaved-buffer-gets-the-same-diagnostics-the-saved-file-would).

### 1.4 Non-goals

* **Matching sentences to code.** The format's own design rejects it
  (`yml_suite_design.md` 1.2: "a sentence matched to code by a regular
  expression is a second vocabulary to keep in step with the first"). The
  prototype's regex step matching is therefore not carried forward
  (DEC-B01). Supporting Cucumber-style `.feature` files is a different product.
* **A validator inside the extension.** The extension holds no rules of the
  format. The TypeScript binding is not that: it is a binding, in
  `os-context`, built and tested there, held to the same corpus and run by the
  same CI as the other four. The extension loads it as it would run any other
  binding's program (DEC-B02, DEC-B15, DEC-B19).
* **PowerShell-only actions in TypeScript.** Like Go, Rust and C#, the
  TypeScript binding implements the 24 portable actions and refuses the 76
  that need PowerShell Direct or WinRM with `E201` (`yml_suite_design.md`
  DEC-Y12).
* **Publishing the TypeScript binding to a package registry.** It is a
  `private` package inside `os-context`, used from its checkout, like the
  Go module and the Rust crate.
* **Making TypeScript the reference.** No binding is the reference
  (`yml_suite_design.md` 6.5). Where TypeScript disagrees with the others,
  the corpus decides, and a corpus change goes through `os-context`'s own
  review.
* **Replacing `redhat.vscode-yaml`.** Structural checking while typing stays
  with it and the committed schema mapping. The extension depends on it rather
  than duplicating it (DEC-B03).
* **Following a handler into its body.** The extension takes the author to the
  registration site. From there, Go to Definition on the handler name is the
  job of `gopls`, `rust-analyzer`, the C# extension, the PowerShell extension
  or VS Code's built-in TypeScript support (DEC-B06).
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
| Conformance corpus | `test/e2e/conformance/` | `run-manifest.yaml` lists 48 validate and 11 execute entries, an expression table of 276 rows (`expressions/cases.yaml`), an assertion table of 96 rows (`asserts/cases.yaml`) and 7 stored reports compared after `report/canonicalise.md`; `validate/<x>.yml` sits beside `<x>.expected.json` (the exact sorted diagnostics), `execute/<x>.yml` beside its expected trace |
| Conformance CI | `.github/workflows/suite-conformance.yml` | One job per binding (`powershell`, `rust`, `go`, `csharp`) plus `divergence`, on any change under `test/e2e/**` or `scripts/e2e/**`; no job sets up Node today |
| Lab CI | `.github/workflows/e2e-tests.yml` | `binding` input with options `powershell`, `rust`, `go`, `csharp`; a `switch` that runs the chosen binding's `run` |
| Node.js in the repository | `src/UI/dashboard/` only | No root `package.json`, no workspaces, no `.nvmrc`; the dashboard uses TypeScript 5.9 and `@types/node` 24; the development host has Node 24.16.0 |
| Editor mapping | `.vscode/settings.json` | `yaml.schemas` maps suites, `_lib`, and both corpus families to the generated schema |

### 2.2 The bindings, as the extension will meet them

The first four exist; the fifth is what this work builds (DEC-B15, DEC-B16).

| Binding | Source | Program | Registration shape | Declared actions |
| --- | --- | --- | --- | --- |
| PowerShell | `scripts/e2e/` | `pwsh -File scripts/e2e/Invoke-LabTestSuite.ps1` (`-Lint -Json`); `Invoke-SuiteLint` in `SuiteLint.psm1` for `-BindingCheck -Binding` | `Register-LabAction -Name 'x' -Handler { param([hashtable]$Step, [hashtable]$Ctx) ... }`, one file per action under `scripts/e2e/actions/`, dot-sourced by `ActionRegistry.ps1` | 100 |
| Rust | `test/e2e/bindings/rust/` | `suiterun` (crate name), built at `target/debug/suiterun.exe` | `map.insert("core.noop", core_noop)` in `src/actions.rs`; `"lifecycle.get" => get(context, step)` in `src/lifecycle/actions.rs`; `names.push("wait".to_string())` | 24 |
| Go | `test/e2e/bindings/go/` | `suiterun` (`cmd/suiterun`), not built in the tree | `"core.noop": noop,` in `internal/actions/actions.go`; `"lifecycle.get": get,` in `internal/lifecycle/actions.go`; `names = append(names, "wait")` in `internal/exec/exec.go` | 24 |
| C# | `test/e2e/bindings/dotnet/` | assembly `suiterun` from `Hci.E2E.Suite.Cli` | `["core.noop"] = Noop,` in `Actions/CoreActions.cs`; `["lifecycle.get"] = (context, request) => context.Get(request),` in `Actions/Lifecycle/LifecycleActions.cs`; `names.Add("wait")` in `Execution/Executor.cs` | 24 |
| TypeScript (new) | `test/e2e/bindings/typescript/` | `node dist/cli.js` (package bin `suiterun`), and the library `dist/index.js` | `action('core.noop', noop),` in `src/actions/core.ts`; `action('lifecycle.get', get),` in `src/lifecycle/actions.ts`; `action('wait', wait),` in `src/actions/core.ts`: one shape for all 24 | 0 today; 24 when built |

The Go, Rust and C# programs share one command-line contract
(`yml_suite_design.md` DEC-Y14), and the TypeScript program will too:

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
| Reference that resolves to nothing (`E301`), capture read too early (`E303`), meta cycle (`E207`), keyword order (`E212`), every other `E2xx`/`E3xx`/`W3xx` | no | yes | on open and on save with any lint tool (O1); while typing with the TypeScript lint tool (O10) |
| Action the target binding does not implement (`E201`) | no | with `--binding-check` | as a per-step badge while typing; as a diagnostic on save, or while typing with the TypeScript lint tool (O2) |
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

### 2.5 Admitting a fifth binding

`os-context` was written for four bindings, and in a few places it says so in
a way a program checks. Measured on 2026-10-14. Only the first group refuses a
new name; the rest are lists of names that a fifth binding must be added to,
or it is silently left out.

| Kind | Where | What it holds today | Why it matters |
| --- | --- | --- | --- |
| Enforced | `test/e2e/schema/actions.catalog.schema.json` lines 16 and 41 | `enum: [powershell, csharp, go, rust]` for the top-level and per-action `bindings`; its description says "A name outside this list is a typo rather than a fifth runner" | `typescript` anywhere in the catalog fails `SuiteLint.Tests.ps1` until the enum admits it |
| Enforced | `scripts/e2e/SuiteLint.psm1` line 2118 | `ValidateSet('powershell', 'csharp', 'go', 'rust')` on `Invoke-SuiteLint -Binding` | The lab workflow's `E201` pre-check calls it, so a TypeScript lab run is refused |
| Enforced, already wrong | `test/e2e/conformance/expectation.schema.json` line 39 | `enum: [powershell, rust, go, python]`: no `csharp`, a `python` nobody wrote | An expectation naming `typescript` (or `csharp`) fails `Conformance.Tests.ps1` |
| Data | `test/e2e/schema/actions.catalog.yaml` | top-level `bindings:` and the 24 portable actions' `bindings:` | `E201`, the binding table, and each binding's "catalog agrees with what I register" test read these |
| Generated | `test/e2e/schema/suite.schema.md` | one "Bindings:" line per action | Regenerated by `Build-Schema.ps1`, which hard-codes no names |
| Workflow | `.github/workflows/suite-conformance.yml` | four binding jobs plus `divergence` | A binding without a job is not held to the corpus |
| Workflow | `.github/workflows/e2e-tests.yml` lines 16-20, 112-123, 233-249 | `binding` options, per-binding toolchain steps, the run `switch` whose `default` throws | A fifth binding cannot be chosen for a lab run |
| Workflow | `.github/workflows/suite-lint.yml` line 117 | `foreach ($binding in 'rust', 'go', 'csharp')` informational `E201` report | Leaves TypeScript out of the portability report |
| Test | `docs/e2e/Docs.Tests.ps1` lines 143, 160-163, 170-171 | the four job names, the four workflow options, the four binding directories | Pins the documentation's claims to the workflows |
| Test | `scripts/e2e/LifecycleBudgetSupport.psm1` 215, 218, 407; `LifecycleSetSegment.psm1` 569-576 | each binding's executor file | Its budget rule ("no `overbudget` tag in any executor") does not see a fifth |
| Prose | `CLAUDE.md` line 31, `.claude/context/tests.md` 192-225 and 325-355, `yml_suite_design.md` 3.1, 6.1, 6.2, conformance and schema READMEs | "four", and tables of four | Readers |

The three Go, Rust and C# programs accept any `--binding` name, so they need
no change to answer `E201` about TypeScript.

What the other three found when they were written, and which the TypeScript
binding must not repeat (`yml_suite_design.md` 6.4 and the plan's Y4 to Y6):

| Lesson | Where it was learned | Consequence for TypeScript |
| --- | --- | --- |
| A conditional with a `long` and a `double` became `double` in C#, and whole numbers came back as fractions | C#, 6.4 | JavaScript has one `number` type; integers must be a different type from floats (DEC-B16) |
| Go's `map` order is random, so Go keeps an ordered map | Go, `internal/model/ordered.go` | A JavaScript object moves integer-like keys first; every YAML mapping is a `Map` (DEC-B16) |
| C# and Go compare ordinally by default; PowerShell does not | 6.4 | Every comparison states its case rule, from `asserts/cases.yaml` |
| `E100` is reported at 1:1, whatever the parser says | 6.4 | The YAML parser's error position is not used for `E100` |
| An `and` becomes the keyword it continues, once, at expansion | 6.4 | Same rule, at expansion |
| The Rust executor forgot to put `labId` and `apiUrl` in scope | 6.4 | The scope is built from the CLI options, and a unit test reads both |
| `--lab-id` is the 32-hex lineage id, not the friendly name | 6.4 | Validated as such before any request |
| A failing `${...}` inside longer text lost its own code | 6.4 | The template path reports the expression's code |
| Only PowerShell retries a stream connect that fails (`LifecycleStream.psm1`: up to 300 s, pause `min(30, 5 x attempt)`, at most 5 reconnects, `Last-Event-ID`) | open question 5 | TypeScript implements the retry window, and the plan files the same fix for Go, Rust and C# (DEC-B18) |

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
   |      Lint controller ---------------+                                   |
   |        |  (lint tool = typescript)  |  (any other lint tool, and every  |
   |        v                            |   actions/list/run/build)         |
   |      Lint worker (worker thread)    v                                   |
   |        | import() at run time     Tool runner (spawn, timeout, cancel,  |
   |        |                          JSON) <--------------------------+    |
   +--------|---------------------------|--------^-----------------------|----+
            |                           |        |                       |
            v                           v        | JSON, trace           v
   test/e2e/bindings/typescript/   suiterun (Go | Rust | C# | TypeScript)  Build-Schema.ps1
   dist/index.js  (library,        or pwsh Invoke-LabTestSuite.ps1        -> suite.schema.json
   same code as its CLI)                |                                    suite.schema.md
                                        v (run against a lab only)
                                   deployed lifecycle API on the lab

   Alongside, unchanged:  redhat.vscode-yaml + .vscode/settings.json -> live E1xx
```

The TypeScript binding, inside `os-context`, mirrors the Go binding's package
map one module per package, so a reader who knows one knows the other:

```
   test/e2e/bindings/typescript/src/
     cli.ts  run.ts  index.ts (library API)          verbs, exit codes, the in-editor entry
     paths.ts  schema.ts  model.ts  value.ts         roots, catalog + schema at run time, YAML with positions, typed values
     walk.ts  validate/{structure,semantics,dataflow}.ts  diag.ts  spelling.ts      E1xx, E2xx, E3xx/W3xx
     suite.ts  exec.ts  expr.ts  assertion.ts  trace.ts  report.ts                 expansion, phases, expressions, operators, trace, NUnit3/JUnit
     actions/{registry,core}.ts  lifecycle/{context,actions,stream}.ts             the 24 portable actions
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

**Lint controller.** Runs the lint tool on open and save, and on every pause in
typing when the lint tool is TypeScript. It maps diagnostics to editor ranges
and publishes them, and owns the diagnostics collection.

**Lint worker.** A Node.js worker thread owned by the lint controller. It
imports the TypeScript binding's library from the workspace checkout, keeps
one linter per repository root (the loaded schema and catalog are reused
between lints), and answers one lint request at a time, with unsaved buffers
passed in as text. It exists so a lint never runs on the extension host's own
thread, and so a lint that hangs can be stopped by terminating the thread
(DEC-B19, DEC-B20).

**TypeScript binding (in `os-context`).** A full binding of the format: a
library and a `suiterun` program over it. Its tests run the whole corpus; CI
runs those tests as a fifth job. It does not know the extension exists. The
one thing it offers beyond the other four is a library entry point,
`createLinter()`, that accepts file contents in place of files. The extension
relies on that (DEC-B15, DEC-B20).

**Coverage view.** The binding table (one row per binding the catalog lists,
with source and declared action count), the registration count found in
source, and the drift list. It can also ask each built binding for
`actions --json` and compare.

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
| TypeScript binding library (`os-context`) | the same as its program, plus answering about unsaved text it is handed | the editor's buffers, which it only reads from the request |
| Conformance corpus (`os-context`) | what "the same" means, for all five bindings | any binding's idioms |
| Lint worker (extension) | the loaded library and its cached linters, for one window | anything on disk |
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
bindings. The sentence under `given`/`when`/`then`/`and` is shown in hover
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

### DEC-B02. Diagnostics come from a binding; the extension is not a validator

**Choice.** Every `E`/`W` diagnostic the extension shows was produced by a
binding, with that binding's code, position and message. It comes either from a
binding program's `lint --json` or from the TypeScript binding's library, loaded
from the workspace. The extension's own source computes none of them.

**Why.** The format's whole design (DEC-Y01, DEC-Y11) is that rules live in one
schema and the bindings agree through a corpus. A validator written inside the
extension would be an implementation outside that corpus, so the first
disagreement would show an author an error that CI does not raise, or hide one
it does. `yml_suite_design.md` 6.4 lists nine defects that a second
implementation exposed in the first; a validator that is never run in CI would
carry such defects silently. The TypeScript binding is the opposite case. It
lives in `os-context`, its tests run the whole corpus, and CI runs those tests
(DEC-B15). Running its code in the editor is running a binding.

**Cost.** For the program-based lint tools, a process start per lint (measured
in plan step B2.5), and `E2xx`/`E3xx` findings appear on save. For the
TypeScript lint tool, the library must be built in the checkout (`npm ci` and
`npm run build` in `test/e2e/bindings/typescript/`).

**Rejected.** (a) Re-implementing semantics and dataflow inside the extension,
for the reason above. (b) Showing only what the schema shows, which is today's
gap. (c) Adding a long-lived language-server mode to the bindings: it changes
every binding to serve one editor. The library entry point of DEC-B20 gives the
same result for one binding without a protocol.

**Serves.** O1, O8, O10. **Verified by.** E-B1, E-B11, E-B14.

### DEC-B03. Program lint tools lint files on disk, on open and on save; live typing stays with the YAML extension

**Choice.** With a program-based lint tool (Go, Rust, C#, PowerShell), the lint
controller lints a suite when it is opened and each time it is saved, using the
file on disk. While the author types, structural checking (`E101`-`E105`)
comes from `redhat.vscode-yaml` through the committed schema mapping, which the
extension declares as a dependency and does not duplicate. With the
TypeScript lint tool, DEC-B20 replaces "on save" with "on every pause in
typing", and nothing else here changes.

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
lint runs. This is the problem the TypeScript library solves without a file:
it is handed the text and the real path (DEC-B20).

**Serves.** O1. **Verified by.** E-B1.

### DEC-B04. The lint tool and the target binding are separate choices; TypeScript is the default lint tool once it is built

**Choice.** Two settings. `bddSuite.lintTool` names the binding whose code
lints. Its default is `typescript` from plan step B9.3 onward, and `go` before
that. `bddSuite.targetBinding` names the binding the author intends to run with
(default `powershell`). Lint is asked with `--binding-check --binding <target>`,
or the library's equivalent options, so `E201` reports what *that* binding
cannot run. When the chosen lint tool cannot run (not built, or the workspace
is untrusted), the extension says so and does not quietly switch to another
tool. A silent switch would change whose rules the author is looking at.

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
module on every save. (b) Lint with every binding and merge: one process per
binding per save for findings the corpus already guarantees are identical.

The defaults are provisional on measurement. Plan step B2.5 measures program
lint latency on `lifecycle-stage1.yml` (the largest suite) for the four program
tools and makes the fastest the pre-TypeScript default; if that is not Go, the
step records the change and the reason here. Plan step B9.3 measures the
in-editor TypeScript lint on the same file. It makes TypeScript the default
only if the result meets O10's one-second budget at the 95th percentile;
otherwise it records the number and leaves the default where it was.

**Serves.** O1, O2. **Verified by.** E-B1, E-B2.

### DEC-B05. Registration sites are found by per-language recognizers, which are configuration

**Choice.** For each binding, the settings name source globs, exclusion globs
and a list of recognizers: a regular expression with a named group `name` (the
action) and an optional named group `handler`. The defaults match the shapes
listed in [2.2](#22-the-bindings-as-the-extension-will-meet-them),
including each older binding's special case for `wait`. The TypeScript binding
is designed to need one pattern for all 24 of its actions (DEC-B16).

**Why.** Registration in every binding is a literal string next to a handler
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

**Rejected.** (a) Each language's language server (workspace symbols). Five
servers must be installed and running, and none of them knows a dictionary key
is an action name. (b) Asking each binding's `actions --json` for names only: it
gives names without positions, needs every program built, and cannot navigate.
(c) Requiring an annotation comment at each registration: it changes four
existing codebases for the editor's benefit and can itself drift.

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
`Register-LabAction` stub. *Implement in binding* adds, for Go, Rust, C# or
TypeScript, a registration in that binding's registry and a stub handler whose
body fails
with the binding's own failure constructor, and adds the binding to the
catalog entry's `bindings:`. Both then run `Build-Schema.ps1`. Stub text comes
from templates shipped with the extension that a workspace may override.

| Binding | Registry the stub goes into | Stub fails with |
| --- | --- | --- |
| PowerShell | new file `scripts/e2e/actions/<Name>.ps1` | `throw '<action>: not implemented in the PowerShell binding yet'` |
| Go | `Registry()` in `internal/actions/actions.go`, or `handlers` in `internal/lifecycle/actions.go` for `lifecycle.*` | `Failed(...)` / `actions.Failed(...)` |
| Rust | `registry()` in `src/actions.rs`, or `names()` and `dispatch()` in `src/lifecycle/actions.rs` for `lifecycle.*` | `Err(ActionError::action(...))` |
| C# | `CoreActions.Registry`, or `LifecycleContext.Handlers` for `lifecycle.*` | `throw ActionException.Failed(...)` |
| TypeScript | the `coreActions` array in `src/actions/core.ts`, or `lifecycleActions` in `src/lifecycle/actions.ts` for `lifecycle.*` | `throw failed('<action>: not implemented in the TypeScript binding yet')` |

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
case-name filter, so a single case cannot be selected under Go, Rust, C# or
TypeScript without changing the shared command-line contract. The TypeScript
binding does not add one on its own, because a flag only one `suiterun` takes is
the first step to five dialects. A run under TypeScript goes through its
program like every other run, not through the library in the editor: a run can
take thirty minutes and talks to a lab, and belongs in a process that can be
killed without touching the editor.

**Cost.** Running one case under Go, Rust, C# or TypeScript runs its siblings too; the
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

**Serves.** O1 to O10. **Verified by.** E-B1, E-B11.

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
definition of correct as the bindings.

**Cost.** The integration suite needs an `os-context` checkout and built
binding programs; the plan states how to provide them.

**Rejected.** Mocked binding programs for the scenarios: they would prove the
extension parses what the mock prints, not what the bindings print. A small
fake program is still used in unit tests for process handling (timeouts,
oversize output, bad JSON), where a real one cannot be made to misbehave on
demand.

**Serves.** O1 to O10. **Verified by.** every scenario in section 7.

### DEC-B15. The TypeScript binding is a full binding in `os-context`, held to the corpus like the other four

**Choice.** A fifth binding at `test/e2e/bindings/typescript/` in `os-context`.
It is a standalone, `private` Node.js package with its own `package.json` and
committed `package-lock.json`, not a member of the dashboard's build. It
implements:

* the shared command line (`lint`, `run`, `list`, `actions`, exit 0/1/2);
* the core semantics: parse, validate at all three levels, expand imports,
  meta steps, tables and outlines, run the six phases under their limits,
  capture, assert, trace, and write NUnit 3 and JUnit;
* the 24 portable actions.

Its tests run every corpus entry and table. `suite-conformance.yml` gains a
`typescript` job, `e2e-tests.yml` gains a `typescript` option, and every
enforced or listed place in [2.5](#25-admitting-a-fifth-binding) admits the
name.

**Why.** Two reasons, and both need a *real* binding rather than a validator.
First, the extension can only lint text in the editor with code that runs in
the editor, and only a binding's own rules are trustworthy there (DEC-B02).
A binding is trustworthy only when the corpus says so and CI keeps saying so.
Second, `os-context` already anticipates this binding (its plan's open
question 3, its design 6.5). Each earlier binding found defects in the ones
before it, nine of them in 6.4, so a fifth is also a fifth check on the
corpus.

**Cost.** About 8,500 lines of source and 4,000 to 5,000 lines of tests, if it
matches the other three (Go 8,620 and 5,048; Rust 8,349 and 3,408; C# 8,389 and
3,908, measured on 2026-10-14). There is a fifth CI job, a Node.js toolchain in
CI where there was none, and one more binding to change whenever the format
changes.

**Rejected.** (a) Building it in this repository: `os-context`'s CI would not
run it, so it would not be held to the corpus, and it would drift as soon as
the corpus changed. (b) A validator-only TypeScript library: the "fifth
validator" of DEC-B02, which no corpus job runs end to end, since the execute
entries need an executor. (c) Compiling the Rust or Go binding to WebAssembly
and loading that in the editor: both read the file system and the Rust one runs
on `tokio`, so a WASI host and a rework of both I/O layers would be needed. It
would also not be the TypeScript binding that was asked for.

**Serves.** O9, O10. **Verified by.** E-B12, E-B13.

### DEC-B16. The TypeScript binding's values are typed, its maps are ordered, and its registry has one shape

**Choice.** Five construction rules, each the answer to a defect another
binding already had:

1. **Integers are `bigint`, floats are `number`.** YAML is parsed with the
   `yaml` package's `intAsBigInt: true`. The expression evaluator, the value
   text rules and JSON output carry the distinction through, so `6 / 3` is the
   integer `2` and `1.5 + 1.5` is the float `3`, as `expressions/cases.yaml`
   requires.
2. **Every YAML mapping is a `Map<string, Value>`**, never a plain object,
   because JavaScript moves integer-like keys to the front of an object and the
   report and trace orders are part of the contract.
3. **Comparisons state their case rule.** `equals`, `notEquals`, `in`, and
   string `contains`/`startsWith`/`endsWith` compare after `toLowerCase()`;
   list membership in `contains` is exact. These are the rules
   `asserts/cases.yaml` pins.
4. **Regular expressions are checked before they are compiled.** JavaScript's
   engine accepts lookahead, lookbehind and backreferences, which RE2 does not.
   So the binding refuses those constructs with `E308` (the list in
   `SuiteLint.psm1`'s `$script:UnportablePatterns`) before calling
   `new RegExp(pattern, 'i')`, both at lint time and at run time.
5. **One registration shape.** Every action, `wait` included, is registered
   by a call `action('<name>', handler)` in an exported array:
   `coreActions` in `src/actions/core.ts`, `lifecycleActions` in
   `src/lifecycle/actions.ts`. `wait` gets the executor through its request,
   so it needs no special case in the executor and no second recognizer.

Libraries: `yaml` (parsing with positions) and `ajv` with its draft 2020-12
build (`ajv/dist/2020`) for structure. Structure uses the same
`stepEnvelope`-then-per-step-branch method as Go
(`validate/structure.go`), mapping Ajv's `required`,
`additionalProperties` and `false schema` errors to `E102`, `E101`/`E105`, and
everything else to `E103`. Cancellation uses `AbortSignal`, HTTP uses
Node's built-in `fetch`, and tests use `node:test` with `c8` for coverage.

**Why.** Each rule closes a hazard that has already cost time in this format
(table in [2.5](#25-admitting-a-fifth-binding)). The single registration shape
is a choice only a new binding can make cheaply, and it gives the extension a
recognizer that cannot confuse an action with an ordinary object key.

**Cost.** `bigint` arithmetic needs explicit conversion where integers meet
floats. `JSON.stringify` cannot write a `bigint`, so the binding has its own
serialiser. One question is open until plan step B8.3: whether integer overflow
past 64 bits is pinned by the corpus. If the other bindings disagree on it, that
is a corpus gap to raise in `os-context`, not a choice for TypeScript to make
alone.

**Rejected.** (a) Plain `number` for every number and plain objects for
mappings: the C# `long`/`double` defect and a key-order defect, chosen on
purpose. (b) A second registration form for `wait`, copying the others: it
would only make the recognizer and scaffolding handle a special case for no
benefit.

**Serves.** O9, and O3 and O6 through the recognizer. **Verified by.** E-B12,
E-B3, E-B7.

### DEC-B17. The TypeScript lifecycle actions follow Go's transport and the catalog's contract

**Choice.** The 18 `lifecycle.*` actions behave as Go's do
(`test/e2e/bindings/go/internal/lifecycle/`):

* `fetch` against `--api-url`, with system certificate verification.
* No authentication header.
* A JSON connection file re-read on every call.
* The `{success, data}` envelope, with a byte-order mark stripped.
* The `/labs` route guard.
* Each request bounded by what remains of the case deadline, with 300 s as the
  fallback.
* One SSE subscription per run id, parsed frame by frame (`labEvent`,
  `complete`, `error`, `lagged`).

Where Go and the catalog disagree, TypeScript follows the catalog:

* `expectedStatus` on `lifecycle.submit` may be a number or a list, as the
  catalog's `type: any` and PowerShell allow. Go silently treats a list as 202.

Where PowerShell does something the catalog does not declare, TypeScript
follows the other three:

* no `attachTo`/`blocking` on a refusal;
* no `X-Lab-Scenario` header.

**Why.** Four bindings agreeing through a corpus means the fifth must agree
with the behaviour, not with one binding's accident. The catalog is the
contract; where Go departs from it, that is Go's defect. The plan records these
departures as defects for `os-context`, rather than copying them into a fifth
language.

**Cost.** Two places where TypeScript's behaviour differs from Go's on a lab.
Neither is reachable from the portable stage 0 cases E-B13 runs, which
`lifecycle-stage0.yml` shows: every `expectedStatus` there is a single number.

**Rejected.** Copying Go exactly: the defect would then be in two bindings, and
the next reader would take agreement for correctness.

**Serves.** O9. **Verified by.** E-B13, and the loopback tests of plan step B8.7.

### DEC-B18. Every text the TypeScript binding writes is redacted, and a stream connect is retried

**Choice.** Two departures from Go, both toward behaviour `os-context` has
already decided is right:

* **Redaction everywhere.** The connection file's `password`,
  `guestAdminPassword`, `safeModePassword`, `lcmPassword` and the generated
  unaccepted guest password are registered as secrets when read. Every string
  the binding writes is passed through one `redact()` function: messages,
  stream errors, captured output, trace, and reports. Go redacts only request
  error messages (`lifecycle.go` 194-222).
* **A stream connect that fails is retried.** This is PowerShell's window
  (`LifecycleStream.psm1`):
  - transport failures only, never an HTTP answer;
  - pauses of `min(30, 5 x attempt)` seconds;
  - at most 300 s in all, and at most 5 reconnects;
  - resuming with `Last-Event-ID` as well as `?after`.

  `os-context`'s open question 5 asks for exactly this in the other three.

**Why.** A secret in a report is a leak whatever binding wrote it, and a stream
blip that fails a case whose run succeeded is the lab3 defect open question 5
records. Building the fifth binding without them would add a fifth place to
fix.

**Cost.** On a lab where the API connection blips, TypeScript passes a case
that Go, Rust and C# fail. That is a difference in outcome on an unreliable
network, not on the format, and the corpus cannot see it. The plan files the
same fix for the other three. Open question 5's prose says the pauses are
"5, 10, 20, 30 s", but the code does `min(30, 5 x n)`; TypeScript follows the
code, and the plan records the prose as a documentation defect.

**Rejected.** One connect attempt, as Go does: the known defect, built again.

**Serves.** O9. **Verified by.** loopback tests in plan step B8.7; E-B13.

### DEC-B19. The extension loads the TypeScript library from the workspace, in a worker thread

**Choice.** When the lint tool is `typescript`, the lint controller starts one
Node.js `worker_threads` worker. The worker loads
`test/e2e/bindings/typescript/dist/index.js` from the workspace checkout with
`import()`. It checks the library's exported `apiVersion` (major `1`) and keeps
one linter per repository root. It is never bundled into the extension. A
lint that exceeds its limit is ended with `worker.terminate()`, and the next
lint starts a fresh worker.

**Why.** Loading from the workspace means the rules the editor applies are the
rules at that commit. Bundling would freeze the binding at the extension's
build, and the corpus would move on without it, which breaks O8. A worker
thread keeps a slow or stuck lint off the extension host's own thread (where it
would freeze every other extension), and terminating a thread is the only way
to stop JavaScript that is not cooperating.

**Cost.** The checkout must have run `npm ci` and `npm run build` in the
binding's directory; the extension offers *Build lint tool* as for the others.
A library whose `apiVersion` major differs is refused with a message naming
both versions.

**Rejected.** (a) Bundling the library into the `.vsix`: version skew against
the corpus, and a release for every format change. (b) Running the library on
the extension host thread: a pathological file would freeze the editor.
(c) Spawning `node dist/cli.js` per lint: it works and is kept as the
`typescript` program for runs and `actions`, but a process cannot be handed an
unsaved buffer (DEC-B03).

**Serves.** O8, O10. **Verified by.** E-B14, E-B8, E-B11.

### DEC-B20. Unsaved text is linted by handing the library the text and the real path

**Choice.** The library exports `createLinter({ root })`, whose `lint()` takes
`{ paths, binding, bindingCheck, strict, overlays }`. `overlays` maps an
absolute path to text, and every file the linter reads is looked up there
before the disk. The lint controller sends the active buffer, and any other
unsaved suite or library open in the editor, as overlays. It does this on every
pause in typing of `LIVE_LINT_DEBOUNCE_MS`, as well as on open and save. The
result is published as for any lint, with source `suiterun:typescript`.

**Why.** Imports resolve from the real path, the `file` field is the real
repository-relative path, and the rules are the binding's own. The answer is
therefore the one the saved file would get, which E-B14 checks against the
corpus. A library entry point that reads through an overlay is the smallest
change that gives a binding this ability. It changes nothing in the shared
command line, which stays file-based.

**Cost.** A library API that the other four bindings do not have, and that the
TypeScript binding must keep stable, which is what `apiVersion` is for. The
overlay is the only way the extension's unsaved text reaches the binding, and
the binding never writes it anywhere.

**Rejected.** (a) A `--stdin` mode on the command line: a shared contract
change for all five, raised as an open question instead. (b) Linting only the
saved file, as today: the gap this decision closes.

**Serves.** O10, O1. **Verified by.** E-B14.

### DEC-B21. `typescript` enters the catalog action by action, as it is implemented

**Choice.** The name is admitted in two steps:

1. **Before any handler exists**, in plan step B8.1, `os-context` accepts the
   name everywhere it is validated:
   - the two enums in `actions.catalog.schema.json`;
   - the `ValidateSet` in `SuiteLint.psm1`;
   - `expectation.schema.json`, fixing its stale `python`/missing `csharp` at
     the same time;
   - the top-level catalog `bindings:`.
2. **Per action**, `typescript` is added to that action's `bindings:` only in
   the step that registers its handler: the five `core.*` actions and `wait` in
   B8.5, the 18 lifecycle actions in B8.7. That step's test (catalog agrees
   with what the binding registers, the same test the other three run) fails
   if the two differ.

**Why.** An action's `bindings:` list is what `E201` and the binding table
believe. Claiming TypeScript for an action it does not implement would make
lint pass a suite the binding then refuses. `os-context`'s Y1.3 did mark the
lifecycle actions for Rust, Go and C# in advance, "so that Y4 to Y6 have a
target". This design does not, because the extension now shows that claim to
authors while they type.

**Cost.** Two catalog edits during B8, each followed by `Build-Schema.ps1`.

**Rejected.** Marking all 24 at once in B8.1, as Y1.3 did: a window in which
the binding table and `E201` are wrong.

**Serves.** O6, O9. **Verified by.** E-B7, E-B12.

### DEC-B22. No binding code runs in an untrusted workspace

**Choice.** The extension declares
`capabilities.untrustedWorkspaces: { supported: "limited" }`. In a workspace
VS Code does not trust, it indexes, navigates, hovers and completes. It does
not start any binding program, load the TypeScript library, run
`Build-Schema.ps1`, build a tool or run a suite, and the status bar says why.
Trusting the folder enables them without a reload.

**Why.** Every one of those runs code from the folder: a `suiterun` built from
it, a `pwsh` script in it, a JavaScript module from it. That is exactly what
workspace trust exists to gate.

**Cost.** In an untrusted clone, no diagnostics beyond the YAML extension's.

**Rejected.** Running the program-based tools in an untrusted folder because
"they are only linting": the program is the folder's code, whatever verb it is
given.

**Serves.** O1, O7, O10. **Verified by.** E-B15.

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
   PowerShell, C#, Go, Rust, TypeScript, each a link to its registration site.
2. **Inlay hint** after the action name: `PS C# Go Rs TS`. For an action with
   fewer bindings it lists only those (`PS`).
3. **Go to Definition** opens a peek with six locations: the catalog entry and
   the five registration sites. **Find All References** lists every step in the
   workspace that uses `lifecycle.submit`.
4. **Hover** on `capture.source` names the step that produced it (here a
   `beforeEach` meta step from `_lib/lifecycle.yml`) and its declared shape.
5. **Completion** after `capture.accepted.` offers the properties of
   `lifecycle.submit`'s capture shape, or says the shape is open when the
   catalog declares `additionalProperties: true`.
6. With the target binding set to `go`, this line is marked `E201` (Go does
   not implement `cluster.suspend`; PowerShell does), and the inlay hint shows
   `PS` only. With the TypeScript lint tool the mark appears within a second of
   typing `cluster.suspend`, before any save; with the other tools, on save.
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
TypeScript   test/e2e/bindings/typescript/  24         24      0
```

(The TypeScript row reads `0 0 0` until plan step B8.5 and `6 6 0` until B8.7,
because the catalog claims an action for TypeScript only once it is registered;
DEC-B21.)

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
| TypeScript library not built (`dist/index.js` missing) | Status bar "Lint: typescript not built", a notification offering *Build lint tool* (`npm ci`, then `npm run build`, in the binding's directory) or *Choose another* | Previous diagnostics, marked stale | Build or switch tool |
| TypeScript library's `apiVersion` major is not `1` | Status bar "Lint: typescript library is API v<n>, this extension needs v1"; no lint runs | Previous diagnostics, marked stale | Update the extension or the checkout so they agree |
| A live lint exceeds `WORKER_LINT_TIMEOUT_MS`, or the worker throws or exits | The worker is terminated; status bar names the cause; the next pause in typing starts a new worker | Previous diagnostics, marked stale | Automatic; three failures in a row stop live lint until the next save, and say so |
| Text is typed while a live lint is running | The running lint's result is discarded when it arrives; a new one starts after the pause | Only the newest result is published | Automatic |
| The workspace is not trusted | Status bar "Suite: untrusted, lint and run disabled"; navigation, hover and completion still work | Nothing is run | Trust the folder; tools start without a reload |
| A `typescript` lab run where the API connection drops briefly | The binding retries the stream connect for up to 300 s (DEC-B18); a case whose run succeeded passes | n/a | n/a; under Go, Rust or C# the same blip fails the case (`os-context` open question 5) |

Resource ownership, stated once because a run can create things: the
extension owns only the processes it starts and the temporary files it names
(trace and report paths under the extension's storage folder, deleted when the
next run of the same file starts). Lab resources a suite creates are owned by
that suite run, recorded by the lab's API, and removed by the suite's own
`cleanup`, `afterEach` and `teardown`. The extension never adopts, deletes or
retries anything on a lab.

---

## 7. Verification

Every editor scenario runs in a real VS Code extension host against the
`os-context` checkout (DEC-B14), driven by this repository's integration
harness. E-B12 and E-B13 are the TypeScript binding's own scenarios. They run
in `os-context` with no editor, as the other bindings' Y-scenarios do. The
controller is the developer's machine. Only E-B10 and E-B13 need a lab. Each
scenario names the outcome it proves and the plan steps it signs off.

Before plan stage B8 completes, the scenarios that list five bindings run with
the four that exist, and the TypeScript half stays open in the plan; it is never
recorded as passed.

Common Given for the editor scenarios (E-B1 to E-B9, E-B11, E-B14, E-B15),
unless a scenario says otherwise:

* `os-context` checked out at a recorded commit, path in `OS_CONTEXT_ROOT`.
* The Rust, Go, C# and TypeScript `suiterun` programs built from that commit
  at the paths the plan's working rules name (for TypeScript, `npm ci` and
  `npm run build` in `test/e2e/bindings/typescript`); `pwsh` 7 on the path.
* The test workspace trusted, except in E-B15.
* `redhat.vscode-yaml` installed in the test VS Code.
* The extension under test loaded from the `.vsix` built from a recorded commit
  of this repository (in the build stages, from the development build).

### E-B1. The editor shows exactly what the corpus says lint must find

* **Given.** Every `validate` entry listed in
  `test/e2e/conformance/run-manifest.yaml` that has no `catalogOverlay` (an
  overlay is a corpus-only mechanism the editor does not use) and no `params`
  (command-line `--param` values an editor lint does not have; corrected at
  plan step B2.2), each with its
  `<stem>.expected.json`. Among them, `typos.yml` (`E101`, `E104`, `E101`),
  `gherkin.yml` (`E212` to `W304`), `meta.yml` (`E207`), `dataflow.yml`
  (`E3xx`) and `portability.yml` (`E201`). Target binding: the entry's
  `binding` where it sets `bindingCheck: true`, otherwise `powershell` (which
  implements every action, so the portability check adds nothing). Lint tool:
  each of `go`, `rust`, `csharp`, `powershell`, `typescript` in turn.
* **When.** The harness opens each file in the editor and waits for the lint
  controller's "published" event, then saves it unchanged and waits again.
* **Then.** For each file and each tool, the diagnostics the editor holds for
  that file, as `(code, severity, line, column)` with line and column converted
  back to one-based, equal the `diagnostics` array of the expectation file, in
  the same order. Each diagnostic's source is `suiterun:<tool>`. The save
  produced the same set, not a doubled one.
* **Cleanup.** None; nothing is written.
* **Proves.** O1; plan steps B2.1, B2.2, B2.5, and B9.3 for the `typescript`
  tool.

### E-B2. A step the target binding cannot run is marked, and says who can

* **Given.** `test/e2e/suites/smoke.yml`, which uses `cluster.state` and
  `invoke` (PowerShell only). Target binding `rust`, lint tool `go`.
* **When.** The harness opens and saves the file, then requests inlay hints and
  action completion on the first step.
* **Then.** The editor's `E201` diagnostics are exactly those printed by
  `suiterun lint --path test/e2e/suites/smoke.yml --json --binding-check
  --binding rust` run by the harness in a terminal from the repository root.
  Each step whose action is PowerShell-only carries the inlay hint `PS`; a
  `core.noop` step carries `PS C# Go Rs TS` once B8.5 has put `typescript` in
  its catalog entry (`PS C# Go Rs` before). The same holds with target
  `typescript`: the `E201` set equals the terminal's for `--binding
  typescript`. In the completion list after
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
* **Then.** For `lifecycle.get`: exactly six locations, namely the catalog's
  `- name: lifecycle.get` line, and one registration each in
  `scripts/e2e/actions/` (`Register-LabAction -Name 'lifecycle.get'`),
  `test/e2e/bindings/go/internal/lifecycle/actions.go`
  (`"lifecycle.get": get,`), `test/e2e/bindings/rust/src/lifecycle/actions.rs`
  (the `"lifecycle.get" =>` dispatch arm),
  `test/e2e/bindings/dotnet/Hci.E2E.Suite/Actions/Lifecycle/LifecycleActions.cs`
  (`["lifecycle.get"] =`), and
  `test/e2e/bindings/typescript/src/lifecycle/actions.ts`
  (`action('lifecycle.get', get)`). The harness checks each location's line
  text with the substring in parentheses. For `cluster.state`: exactly two
  (catalog and PowerShell). For `wait`: catalog, `Wait.ps1`, the `wait` lines in
  Go `exec.go`, Rust `actions.rs` and C# `Executor.cs`, and
  `action('wait', wait)` in TypeScript `src/actions/core.ts`. Go to Definition on
  `meta: select-lab` in a stage 0 case returns the definition in
  `_lib/lifecycle.yml`.
* **Cleanup.** None.
* **Proves.** O3; plan steps B1.3, B1.4, B1.6 (the TypeScript locations once
  B8.5 and B8.7 have registered them).

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

### E-B6. A new action is declared and implemented in every binding from the editor

* **Given.** A fresh `git worktree` of `os-context` at the recorded commit. A
  scratch suite with a step `action: demo.echo` and parameters
  `text: hello` and `times: 2`.
* **When.**
  1. Save; the YAML extension underlines `demo.echo` (`E104`) and lint reports
     it. Apply the quick fix *Declare action demo.echo*.
  2. Run *Implement demo.echo in Go*, then in Rust, then in C#, then in
     TypeScript.
  3. In the worktree, run `pwsh -File test/e2e/schema/Build-Schema.ps1 -Check`,
     the PowerShell catalog test
     (`Invoke-Pester scripts/e2e/SuiteLint.Tests.ps1`), `go build ./...` and
     `go vet ./...` in the Go module, `cargo build` in the Rust crate,
     `dotnet build` of the solution, `npm run build` and `npm test` in the
     TypeScript package, and each built program's `actions --json`.
* **Then.** The catalog has a `demo.echo` entry with `text: string` and
  `times: integer` and finally
  `bindings: [powershell, csharp, go, rust, typescript]`;
  `scripts/e2e/actions/DemoEcho.ps1` registers it; `-Check` exits 0; the Pester
  file passes; all four builds succeed, and the TypeScript tests (including its
  "catalog agrees with what this binding registers" test) pass; every
  `actions --json` includes
  `demo.echo`; saving the scratch suite clears `E104`. Running the scratch
  suite under each binding fails the step with a message containing
  `not implemented`. Undo in the editor reverts each command's text edits in
  one step.
* **Cleanup.** Remove the worktree (`git worktree remove --force`). If removal
  fails, the harness prints its path and leaves it for inspection; it is never
  inside the main checkout.
* **Proves.** O5; plan steps B5.1 to B5.5.

### E-B7. The binding table matches the catalog and the binaries, and drift appears when introduced

* **Given.** The clean `os-context` checkout and the four built `suiterun`
  programs; a worktree for the second half.
* **When.** The harness reads the coverage view's model, then runs *Verify with
  binding programs*. In the worktree, it deletes the Rust dispatch arm for
  `lifecycle.get` and saves the file, then deletes the TypeScript
  `action('lifecycle.get', get),` line and saves that file.
* **Then.** On the clean tree: Declared is 100, 24, 24, 24, 24 for PowerShell,
  C#, Go, Rust, TypeScript (whatever `actions.catalog.yaml` declares at the
  recorded commit, read independently by the harness); Found equals Declared;
  Drift is 0 for every row; each program's `actions --json` set equals the
  catalog's set for that binding and equals Found. In the worktree, within 2 s
  of each save, that binding's row shows Drift 1 naming `lifecycle.get` as
  "declared, not registered".
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
* **When.** For each of the five bindings as target, the harness runs the file's
  test items through the Test Explorer API.
* **Then.** Each case item's result (passed, failed, errored) equals the
  outcome of that case's `case` entry in the expected trace; outline rows appear
  as child items named `<case> [<column>=<value>, ...]` with their own results;
  failed items carry the failing step's keyword and sentence in their message.
  The five bindings produce the same item results.
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
  After each, it saves the suite. Then, with the lint tool `typescript`, in a
  worktree: it renames `dist/index.js` away; restores it and sets its exported
  `apiVersion` to `2`; restores it and makes `createLinter().lint()` loop
  forever; makes it throw. After each, it types one character and pauses.
* **Then.** Each time: the status bar names the failure; the output channel has
  the program's or library's error output; the previous `E301` is still shown
  and marked stale (its message is prefixed `[stale]`); no diagnostic set is
  replaced by an empty one; no child process remains after 1 s (checked by
  process id), and after the looping library no worker thread remains after
  `WORKER_LINT_TIMEOUT_MS` plus 1 s (checked through the lint controller's
  worker count). Restoring the real path or library and saving clears the
  stale marks.
* **Cleanup.** Restore the setting; remove the worktree.
* **Proves.** O1, O10; plan steps B2.4 and B9.1.

### E-B12. The TypeScript binding passes the whole conformance corpus

* **Given.** `os-context` at a recorded commit, with no lab, no credentials and
  no network. `npm ci` in `test/e2e/bindings/typescript`. The corpus as
  `test/e2e/conformance/run-manifest.yaml` lists it: 48 validate entries,
  11 execute entries, the expression table (276 rows) and the assertion table
  (96 rows), and 7 stored reports, counted from the manifest at run time and
  not from this document.
* **When.** `npm test` in the package, which runs `node --test` over
  `test/conformance/*.test.ts` and the unit tests under `c8`. Then the
  `typescript` job of `suite-conformance.yml` runs the same on `ubuntu-latest`,
  and `test/e2e/conformance/Assert-DivergenceIsCaught.ps1 -Binding typescript`
  mutates TypeScript's `equals` to be case-sensitive.
* **Then.**
  - Every manifest entry is run, and every file the manifest names exists. The
    corpus test fails if it ran fewer entries than the manifest lists, as Go's
    `TestEveryEntryIsOfAKindThisBindingRuns` does.
  - Every validate entry gives the expected diagnostics: same codes, same
    order, same lines and columns. Every execute entry gives the expected trace
    and exit code.
  - Every expression row gives the expected value and type (int and float
    distinct) or code. Every assertion row passes, fails or errors as the table
    says. Every stored report canonicalises equal.
  - "The catalog agrees with what this binding registers": the set of
    `action('...')` names equals the catalog actions that list `typescript`.
  - Coverage is 100 percent of lines for the package, and 100 percent of
    branches for `src/expr.ts` and `src/assertion.ts`.
  - The CI job is green. The divergence check reports the mutation caught,
    then restores the file.
* **Cleanup.** None; the divergence check restores the file in `finally`.
* **Proves.** O9; plan steps B8.1 to B8.6 and B8.8.

### E-B13. The TypeScript binding runs the portable stage 0 cases on a lab with the same report as Go

* **Given.** The lab, footprint, identifiers and preflight of E-B10, with
  binding `typescript` in place of `go`: the TypeScript and Go programs built
  from the same `os-context` commit, and every action in the selected cases
  listing `typescript` in the catalog. No editor is involved.
* **When.** From the repository root, in this order:
  `node test/e2e/bindings/typescript/dist/cli.js run --path
  test/e2e/suites/lifecycle-stage0.yml --tags portable --results ts.xml
  --api-url <u> --lab-id <id> --connection-file <f>`, then the same with the
  Go program and `--results go.xml`. Then `e2e-tests.yml` is dispatched with
  `binding: typescript`, the same tags and the same lab inputs.
* **Then.**
  - Both local runs exit 0 with the eight cases passed.
  - `ts.xml` and `go.xml` canonicalise identical under `-IgnoreOutput`.
  - Neither report, nor the TypeScript trace, contains any value from the
    connection file's password fields; the harness searches for each.
  - The workflow run passes with the same cases and publishes its NUnit report
    through `dorny/test-reporter`.

  Recorded: commit, lab id, API URL, start and end, both reports, the workflow
  run id, and the three bootstrap run ids.
* **Cleanup.** None by the binding. Three bootstrap run records are left, as
  E-B10's footprint states for its runs; their ids are recorded. A partial
  failure is followed by the stage 0 `read-only` cases before the lab is used
  again.
* **Proves.** O9; plan step B8.7, and B8.8 for the workflow half.

### E-B14. An unsaved buffer gets the same diagnostics the saved file would

* **Given.** Lint tool `typescript`. A worktree. A clean suite
  `test/e2e/suites/_scratch-b14.yml` that imports `_lib/lifecycle.yml`, open in
  the editor and saved.
* **When.** For each validate corpus entry used by E-B1, the harness replaces
  the whole buffer's text with that entry's file content, without saving. It
  waits for the lint controller's "published" event and records the time from
  the last edit. Separately, in a buffer importing `_lib/lifecycle.yml`, it types
  `${capture.nosuch}` into a step, without saving, and pauses.
* **Then.**
  - For each entry, the diagnostics shown for `_scratch-b14.yml` equal that
    entry's expectation (code, severity, line, column). Entries whose
    expectation depends on their own file name or relative imports are the
    exception: they are compared to a lint of the same text saved under the
    entry's real path in the worktree, instead of to the expectation file.
  - The 95th percentile of the edit-to-published times is under 1 s on
    `lifecycle-stage1.yml`-sized text.
  - The typed reference produces `E301` at its position before any save.
    Imports are resolved from the real path, so a meta step from
    `_lib/lifecycle.yml` is not reported missing.
  - Nothing was written to disk: the harness checks the worktree's
    `git status` is unchanged apart from the scratch file as first saved.
* **Cleanup.** Revert the buffer; remove the worktree.
* **Proves.** O10; plan steps B9.1 to B9.3.

### E-B15. In an untrusted workspace no binding code runs

* **Given.** The `os-context` checkout opened as an untrusted workspace (the
  harness sets `security.workspace.trust.enabled` and does not trust the
  folder). Lint tool `typescript`, then `go`.
* **When.** The harness opens a suite with a known `E301`, types, saves, runs
  *Show actions implemented by binding*, starts a Test Explorer run, and runs
  *Build lint tool*.
* **Then.**
  - No child process is started; the harness checks the tool runner's spawn
    counter and the operating system's process list.
  - No worker thread is created, and nothing is imported from the workspace.
  - The status bar says lint and run are disabled because the folder is not
    trusted. Hover, Go to Definition and completion still answer.
  - After the harness grants trust, the next save lints, with no reload.
* **Cleanup.** Reset trust for the folder.
* **Proves.** DEC-B22; plan steps B2.6 and B9.1.

### Scope of the guarantee

Passing these scenarios proves the stated behaviour for the tested
`os-context` commit, the tested binding programs and library, and the tested
VS Code and Node.js versions, on Windows. The TypeScript binding's CI job adds
Linux for the corpus only.

It does not prove:

* behaviour of the extension on macOS or Linux (the process-tree handling
  differs and is unit-tested only);
* behaviour against a catalog shape the recognizers' defaults were not written
  for;
* behaviour on a lab the stage 0 portable cases were not run against;
* the TypeScript stream-retry window on a real network fault (proved on a
  loopback server only).

---

## 8. Traceability

| Outcome | Decisions | Plan steps | Scenarios |
| --- | --- | --- | --- |
| O1 lint findings in place | DEC-B02, DEC-B03, DEC-B04, DEC-B13, DEC-B22 | B2.1, B2.2, B2.4, B2.5, B2.6 | E-B1, E-B11, E-B15 |
| O2 binding support per step | DEC-B04, DEC-B09 | B1.2, B2.3, B3.1 | E-B2 |
| O3 navigation both ways | DEC-B01, DEC-B05, DEC-B06, DEC-B07, DEC-B16 | B1.3, B1.4, B1.5, B1.6 | E-B3, E-B4 |
| O4 completion beyond the schema | DEC-B07, DEC-B08, DEC-B09 | B3.1, B3.2, B3.3, B3.4, B3.5 | E-B5 |
| O5 scaffolding | DEC-B10 | B5.1, B5.2, B5.3, B5.4, B5.5 | E-B6 |
| O6 drift visible | DEC-B05, DEC-B21 | B4.1, B4.2, B4.3 | E-B7 |
| O7 run from the editor | DEC-B11, DEC-B12, DEC-B22 | B6.1, B6.2, B6.3, B6.4, B6.5 | E-B9, E-B10 |
| O8 no extension release for a format change | DEC-B02, DEC-B07, DEC-B19 | B1.2, B1.7, B3.4 | E-B8 |
| O9 a conformant TypeScript binding | DEC-B15, DEC-B16, DEC-B17, DEC-B18, DEC-B21 | B8.1 to B8.8 | E-B12, E-B13 |
| O10 lint while typing | DEC-B02, DEC-B19, DEC-B20 | B9.1, B9.2, B9.3 | E-B14, E-B11 |
| (all) packaged and installable | DEC-B13, DEC-B14 | B1.1, B7.1, B7.2, B7.3 | all editor scenarios, re-run on the `.vsix` |

---

## 9. Decision index

| ID | Decision | Serves |
| --- | --- | --- |
| [DEC-B01](#dec-b01-steps-are-joined-to-code-by-action-name-through-the-catalog-not-by-matching-the-sentence) | Join on action name through the catalog, not on the sentence | O3, O4 |
| [DEC-B02](#dec-b02-diagnostics-come-from-a-binding-the-extension-is-not-a-validator) | Diagnostics come from a binding, never from the extension | O1, O8, O10 |
| [DEC-B03](#dec-b03-program-lint-tools-lint-files-on-disk-on-open-and-on-save-live-typing-stays-with-the-yaml-extension) | Program lint tools lint on open and save; live structure stays with the YAML extension | O1 |
| [DEC-B04](#dec-b04-the-lint-tool-and-the-target-binding-are-separate-choices-typescript-is-the-default-lint-tool-once-it-is-built) | Lint tool and target binding are separate; TypeScript lints by default once built | O1, O2 |
| [DEC-B05](#dec-b05-registration-sites-are-found-by-per-language-recognizers-which-are-configuration) | Recognizers find registration sites, as configuration | O3, O6 |
| [DEC-B06](#dec-b06-the-registration-site-is-the-definition-the-handler-body-belongs-to-the-languages-own-tooling) | Registration site is the definition target | O3 |
| [DEC-B07](#dec-b07-one-in-memory-index-parsed-with-positions-updated-per-file) | One in-memory index, updated per file | O3, O4, O8 |
| [DEC-B08](#dec-b08-completion-inside---uses-an-approximate-scope-lint-decides-correctness) | Approximate scope for completion; lint decides | O4 |
| [DEC-B09](#dec-b09-action-names-are-completed-by-the-extension-with-binding-support-shown) | Extension completes action names with binding support | O2, O4 |
| [DEC-B10](#dec-b10-scaffolding-writes-real-signatures-into-real-registries-then-runs-the-repositorys-generator) | Scaffolding uses real registries and the real generator | O5 |
| [DEC-B11](#dec-b11-a-run-is-one-suite-file-under-the-target-binding-mapped-from-its-trace) | A run is one file, through the binding program, mapped from its trace | O7 |
| [DEC-B12](#dec-b12-a-lab-run-is-always-an-explicit-act-never-a-side-effect) | A lab run is always explicit | O7 |
| [DEC-B13](#dec-b13-defaults-match-os-context-the-extension-activates-where-a-catalog-exists) | `os-context` defaults; activate only where a catalog exists | O1-O10 |
| [DEC-B14](#dec-b14-proof-runs-in-a-real-vs-code-against-the-real-os-context-checkout-and-its-corpus) | Proof in real VS Code against real `os-context` | O1-O10 |
| [DEC-B15](#dec-b15-the-typescript-binding-is-a-full-binding-in-os-context-held-to-the-corpus-like-the-other-four) | TypeScript is a full binding in `os-context`, under the corpus and CI | O9, O10 |
| [DEC-B16](#dec-b16-the-typescript-bindings-values-are-typed-its-maps-are-ordered-and-its-registry-has-one-shape) | Typed integers and floats, ordered maps, explicit case rules, checked regexes, one registry shape | O9, O3, O6 |
| [DEC-B17](#dec-b17-the-typescript-lifecycle-actions-follow-gos-transport-and-the-catalogs-contract) | Lifecycle actions follow Go transport and the catalog contract | O9 |
| [DEC-B18](#dec-b18-every-text-the-typescript-binding-writes-is-redacted-and-a-stream-connect-is-retried) | Redact every written text; retry a failed stream connect | O9 |
| [DEC-B19](#dec-b19-the-extension-loads-the-typescript-library-from-the-workspace-in-a-worker-thread) | Load the library from the workspace, in a worker thread | O8, O10 |
| [DEC-B20](#dec-b20-unsaved-text-is-linted-by-handing-the-library-the-text-and-the-real-path) | Lint unsaved text through overlays at the real path | O10, O1 |
| [DEC-B21](#dec-b21-typescript-enters-the-catalog-action-by-action-as-it-is-implemented) | typescript enters the catalog action by action | O6, O9 |
| [DEC-B22](#dec-b22-no-binding-code-runs-in-an-untrusted-workspace) | No binding code in an untrusted workspace | O1, O7, O10 |
