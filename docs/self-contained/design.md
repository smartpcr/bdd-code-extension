# A self-contained BDD suite repository: design

Status: **stage S1 built and locally accepted for TypeScript (2026-10-15); S2 to S7 not started.** Revised the
same day: the core is extended by import (DEC-S10). The plan that builds it is [implementation.md](implementation.md); every outcome
here links to the deliverables that produce it and the scenarios that prove it.

Audience: anyone who writes suites, writes or maintains a binding, maintains
`os-context`, or contributes to this repository. No knowledge of the bindings'
source is assumed; the words are introduced in [Vocabulary](#vocabulary).

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

| Word | Meaning, and why it matters here |
| --- | --- |
| **Suite** | A YAML file of BDD cases: Given/When/Then steps, each naming an **action**. |
| **Action** | A named operation a step calls (`core.set`, `wait`, `lifecycle.get`). Suites name actions; bindings implement them. |
| **Catalog** | `actions.catalog.yaml`: every action a workspace may use, its parameters and which bindings implement it. Each workspace has its own; os-context's has 100 actions. |
| **Core** | The minimum needed to author and check any suite: the suite structure (cases, steps, Gherkin keys, meta steps, imports, params, vars, hooks, tags, limits), the built-in actions `core.*` and `wait`, the diagnostics, and the schemas that describe them. This repository ships the core and nothing product-specific. |
| **Import** (of the core) | How a workspace extends the core: its catalog imports the core catalog and adds its own actions, and may import suite-schema extensions that add top-level suite fields. Nothing is copied or merged by hand; the core stays one file the workspace refers to. |
| **Format spec** | What a suite may contain and what each finding means: the base suite schema, the catalog schema, the diagnostic schema, the schema generator and the diagnostics reference. |
| **Conformance corpus** | Suites with their exact expected results (findings, traces, reports, expression and assertion tables). Every binding must reproduce them; it is how five independent implementations stay one language. |
| **Binding** | One language's implementation: a **runtime** plus actions. Five exist: PowerShell, C#, Go, Rust, TypeScript. |
| **Runtime** | The language-independent part of a binding: parse, lint, expressions, assertions, the step runner, traces, reports, the `suiterun` command line, and the built-in actions `core.*` and `wait`. Nothing in it knows about any particular product. |
| **Extension** (of a runtime) | Code outside the runtime that adds to it through a public API: actions, context keys, command-line options, lint rules, limits. os-context's lab actions become an extension. Not to be confused with the VS Code extension; this document says **VS Code extension** for that. |
| **Consumer** | A repository that uses the runtimes and the format spec from here and adds its own catalog, actions and suites. os-context is the first. |
| **Pin** | The exact version of this repository a consumer builds against, so a change here reaches a consumer only when it moves its pin. |

## 1. What we want to achieve

### 1.1 The problem

The BDD suite format, its five bindings and the corpus that keeps them in step
all live inside `os-context`, interleaved with os-context's own lab code. That
has three costs:

* **This repository cannot test itself.** The VS Code extension's integration
  suite needs an os-context checkout with all five bindings built
  (`OS_CONTEXT_ROOT`), so CI here runs only unit tests and a demo, and a change
  to the extension is never checked against a real binding in CI.
* **Nobody else can use the format.** Each runtime compiles os-context's lab
  actions in and has no way to add others: the C#, Go and TypeScript runners
  hard-wire one lab dispatcher; Rust has no hook at all; PowerShell loads only
  the files in its own folder. Lab command-line options (`--api-url`,
  `--lab-id`, `--connection-file`), context keys (`cluster`, `labId`,
  `apiUrl`), a `lifecycle` tag rule with a 900-second ceiling, a
  shared-checks rule and `HCI_SUITE_*` environment names are built into the
  generic code of every runtime.
* **The format's own tests depend on one product.** 45 of the corpus's 70
  YAML files check findings against os-context's catalog (`cluster.state` alone
  is referenced 55 times), and the base schema carries os-context fields
  (`requires`, `sharedChecks`, `cluster`, `target`).

### 1.2 Outcomes

| ID | Outcome (observable) | Built by | Proved by |
| --- | --- | --- | --- |
| <a id="o1"></a>**O1** | **A fresh clone of this repository builds and tests everything with no other checkout**: the format spec, the corpus in all five runtimes, the VS Code extension's unit, demo and integration suites. CI runs all of it on every pull request. | [D1](implementation.md#d1), [D2](implementation.md#d2), [D3](implementation.md#d3)–[D7](implementation.md#d7), [D8](implementation.md#d8), [D9](implementation.md#d9) | [E1](#e1), [E2](#e2), [E4](#e4) |
| <a id="o2"></a>**O2** | **The core format lives here, and only the core.** The spec holds the suite structure, `core.*` and `wait`, and the diagnostics; a workspace extends it by importing it (its own actions, its own suite fields). The corpus uses only the core plus its own test catalog, so its results mean the same in any workspace. | [D1](implementation.md#d1), [D2](implementation.md#d2), [D13](implementation.md#d13) | [E2](#e2), [E8](#e8) |
| <a id="o3"></a>**O3** | **Each runtime is generic and extensible.** A project outside this repository adds actions, context keys, command-line options, lint rules and limits through a public API, without editing the runtime, in each of the five languages. | [D3](implementation.md#d3)–[D7](implementation.md#d7) | [E3](#e3) |
| <a id="o4"></a>**O4** | **os-context behaves exactly as before, built from here.** It consumes the runtimes and the format spec at a pin, registers its lab actions as extensions, and its lint results, action lists, CI and lab runs are unchanged. | [D10](implementation.md#d10), [D11](implementation.md#d11) | [E5](#e5), [E6](#e6) |
| <a id="o5"></a>**O5** | **Each release versions the runtimes with the extension**, so a consumer can pin a tested set. | [D12](implementation.md#d12) | [E7](#e7) |

### 1.3 Scope and non-goals

In scope: moving the format spec, the corpus and the five runtimes here;
separating them from os-context's actions; an extension API per language;
os-context switching to them; this repository's CI and release.

Not in scope:

* **Changing what suites mean.** No finding code, trace field, report format
  or expression rule changes; the corpus results stay identical apart from
  action names (DEC-S02).
* **os-context's actions themselves.** The 81 PowerShell lifecycle actions, the
  cluster, CAU and storage actions, the 18 lifecycle actions in each compiled
  binding, the scenario catalog and the lab tooling stay in os-context; they
  are re-wired, not rewritten.
* **Public package registries.** Runtimes are consumed by pin from this
  repository (DEC-S06); publishing to npm, NuGet, crates.io or the PowerShell
  Gallery can follow later without changing the API.

## 2. What exists today

Measured in the os-context worktree `E:\work\os\os-context-ts` (branch
`typescript-binding`) on 2026-10-15.

| Part | Where | Size | Generic | os-context's own |
| --- | --- | --- | --- | --- |
| Format spec | `test/e2e/schema/` | 11 files | base schema (most of it), catalog schema, diagnostic schema, `Build-Schema.ps1`, diagnostics reference | the 100-action catalog, scenario-catalog schema, schema fields `requires`, `sharedChecks`, `cluster`, `target` |
| Corpus | `test/e2e/conformance/` | 140 files | execute (11), expressions, asserts, reports, manifest, divergence check | 45 validate files name os-context actions; 4 test the `lifecycle` rule, others the shared-checks rule (E214) |
| C# | `test/e2e/bindings/dotnet` | 53 files, 12,430 lines; projects `Hci.E2E.Suite`, `.Cli`, `.Tests` | everything except below | `Actions/Lifecycle/*` (18 actions, HTTP client, event stream); one hard edge: `Run/Runner.Running.cs` constructs `LifecycleContext` |
| Go | `test/e2e/bindings/go` | 55 files, 13,689 lines; module `suiterun`, all packages `internal/` | everything except below | `internal/lifecycle`; `internal/run/lifecycle.go` wires it in |
| Rust | `test/e2e/bindings/rust` | 34 files, 11,792 lines; crate `suiterun` | everything except below | `src/lifecycle/*`; `actions.rs` and `exec.rs` call into it directly |
| TypeScript | `test/e2e/bindings/typescript` | untracked in git (stage B7 of this repo's plan) | everything except below | `src/lifecycle/*`; `run.ts` constructs its dispatcher |
| PowerShell | `scripts/e2e` | 151 files, 39,687 lines | `SuiteModel`, `SuiteLint`, `StepExecution`, `Expression`, `Assertions`, `ReportCompare`, `ActionRegistry`, `Core`, `Wait`, the runner's generic half, `Conformance.Tests.ps1` | ~120 files: 7 `lab-*.ps1` action files (81 lifecycle actions), cluster, CAU, storage and invoke actions, `Lifecycle*`, scenario catalog, update-process health, SAN health, the runner's lab half |

In every runtime the generic code also carries os-context vocabulary: the lab
options, `cluster`/`target`/`labId`/`apiUrl` as expression roots and dataflow
context keys, the `lifecycle` tag rule and its 900 s budget (in lint and in
the runner), the E214 shared-checks library name, and the `HCI_SUITE_PARAM_`
and `HCI_SUITE_RECORD_PATH` environment names. Each runtime finds the format
spec by walking up to a folder containing `test/e2e/schema`.

## 3. The shape of the result

```text
bdd-code-extension/                 (this repository)
  spec/                             the core only: core.catalog.yaml (core.*, wait), suite.core.json,
                                    catalog / diagnostic / extension schemas, generator, diagnostics reference
  conformance/                      corpus + neutral catalog (catalog.yaml) + manifest + divergence check
  runtimes/
    powershell/  csharp/  go/  rust/  typescript/
                                    each: runtime library, suiterun CLI, extension API,
                                    corpus tests, an example extension
  samples/workspace/                a small consumer workspace: catalog, suites, example actions
                                    in five languages built on the runtimes (the VS Code
                                    extension's integration fixture)
  src/  test/                       the VS Code extension, unchanged in place
  .github/workflows/ci.yml          extension + five runtime jobs + divergence check + release

os-context/                         (a consumer)
  test/e2e/bdd/                     this repository, as a git submodule pinned to a release tag
  test/e2e/schema/                  os-context's catalog (imports the core catalog) and its suite-schema
                                    extension (requires, sharedChecks, cluster, target)
  test/e2e/bindings/<lang>/         os-context's extension per language: lifecycle actions,
                                    lab options, lifecycle rule; a suiterun built from runtime + extension
  scripts/e2e/                      PowerShell lab actions and tooling, loading the runtime module
```

How a run flows after the change, for one binding:

```text
os-context's suiterun (Go)  =  runtime package (from the pin)  +  os-context extension
                                     |                                   |
   suite.yml ── lint ──> runtime: structure, semantics, dataflow   + extension rules (lifecycle budget, E214)
            └── run ───> runtime: steps, wait, limits, trace        + extension actions (lifecycle.*),
                                                                       options (--api-url ...), context keys
```

## 4. Decisions

### DEC-S01. One repository layout: `spec/`, `conformance/`, `runtimes/<lang>/`, `samples/`; the VS Code extension stays at the root

**Choice.** As drawn in [section 3](#3-the-shape-of-the-result).

**Why.** Each part has one obvious home and its own build, so a runtime can be
built and tested from its folder alone, and a consumer can point at one folder
per language. The VS Code extension stays where it is, so its packaging,
scripts and CI do not move.

**Tradeoff.** The root mixes the extension's files with the other folders;
moving the extension to `extension/` would be tidier but would touch every
script and path for no behavioural gain.

**Serves.** O1, O2. **Verified by.** E1.

### DEC-S02. The corpus uses a neutral catalog; os-context action names are replaced one for one

**Choice.** The corpus gets its own catalog, `conformance/catalog.yaml`: the
built-in `core.*` and `wait`, plus fixture actions that exist only to be
checked (`fixture.state`, `fixture.suspend`, `fixture.resume`, `fixture.move`,
`fixture.invoke`, `fixture.get`), each declared with exactly the parameters,
types and binding lists of the os-context action it replaces. Every corpus
file is rewritten by a mapping table (`cluster.state` to `fixture.state`, and
so on); expected results change only in the action names they quote.

**Why.** The corpus defines the format, so its results must not depend on one
product's catalog. A one-for-one rename keeps every finding, position and code
identical, which is what proves nothing about the format changed.

**As built (S1).** The rename table is `conformance/rename.json`: `cluster.*` to
`fixture.*` and `lifecycle.get` to `inventory.get`, each of the same length so no
expected column moved; host names in test values (`WSFC-N1`) became `HOST-N1`
the same way. Suite fields and context keys keep their names (`cluster`,
`target`, `requires`, `labId`, `apiUrl`): the corpus declares the fields in its own
suite-schema extension (`conformance/schema/fixture.suite.json`) and each
runtime's corpus harness registers the context keys as a test extension, which
also exercises both extension mechanisms.

**Tradeoff.** Fixture actions are declared but implemented by no runtime, which
is what the validate corpus needs (it checks lint, not execution). The four
`lifecycle-*` files and the E214 files test os-context rules and move to
os-context's own tests (DEC-S05).

**Serves.** O2. **Verified by.** E2.

### DEC-S03. Each runtime exposes one extension API with the same five parts, in its own language's idiom

**Choice.** An extension supplies any of:

| Part | What it adds | Replaces today's built-in |
| --- | --- | --- |
| Actions | name to handler, with the handler receiving the step and a per-run context | os-context's lab dispatcher, hard-wired |
| Context keys | names readable in `${...}` and known to dataflow lint | `cluster`, `target`, `labId`, `apiUrl` in every runtime |
| Options | command-line options the extension declares and reads | `--api-url`, `--lab-id`, `--connection-file` |
| Rules | extra lint rules and limits (e.g. a tag-based time ceiling) | the `lifecycle` 900 s rule; E214 |
| Environment prefix | the prefix for parameter and record variables | `HCI_SUITE_` (the runtime default becomes `BDD_SUITE_`) |

A consumer builds its own `suiterun` from the runtime and its extensions:
Go `suiterun.Main(ext...)`; C# `Runner.Run(args, extensions)`; Rust
`suiterun::main_with(&extensions)`; TypeScript `main(argv, extensions)` and
`createLinter({..., extensions})` for in-process lint; PowerShell
`Invoke-BddSuite -Extension <module>` with `Register-SuiteAction`
(`Register-LabAction` kept as an alias). Several extensions compose; a name
two extensions both define is refused at start-up.

**Why.** All four compiled runtimes already have a dispatcher interface; it
only lacks a public way in and a slot for more than one. Making the other four
os-context parts pluggable the same way is what lets the runtime contain no
product knowledge. One model across languages keeps the bindings in step, as
the corpus does for behaviour.

**Tradeoff.** Each runtime's internals change shape (Go packages must leave
`internal/`; C# assemblies are renamed; Rust's handler type becomes public).
That is most of the work, and it happens while os-context still depends on the
old shape, which is why os-context keeps its copies until D10 switches it.

**Serves.** O3, O4. **Verified by.** E3, E5.

### DEC-S04. Generic names: no product names in runtime code

**Choice.** C# `Hci.E2E.Suite*` becomes `Bdd.Suite*`; the Go module path
becomes `github.com/smartpcr/bdd-code-extension/runtimes/go` with public
packages under `suite/`; the Rust crate stays `suiterun` (library and binary);
the TypeScript package becomes `@bdd-suite/runtime`; the PowerShell module is
`BddSuite`. The command name `suiterun`, its verbs, flags (other than the lab
ones), exit codes and output formats do not change, because the VS Code
extension and os-context's CI call them.

**Why.** Consumers other than os-context should not import `Hci.*`; and the
contract that tools depend on, the command line, must not move.

**Serves.** O3. **Verified by.** E3, E5.

### DEC-S05. os-context's specifics become os-context's runtime extensions and catalog imports

**Choice.** os-context gets, per language, an extension with its lifecycle
actions, the lab options, the context keys, the lifecycle rule and E214. Its
catalog imports the core catalog (DEC-S10) and declares its own 94 actions;
its suite fields `requires`, `sharedChecks`, `cluster` and `target` live in a
suite-schema extension its catalog imports. The `lifecycle-*` and E214 corpus
files move to os-context's own tests.

**Why.** This is the line between "the format" and "one product's use of it";
drawing it here is what makes O3 and O4 both true.

**Serves.** O3, O4. **Verified by.** E5, E6.

### DEC-S10. The core is extended by import, never by copying or merging

**Choice.** This repository's `spec/` holds only the core:
`core.catalog.yaml` (`core.*` and `wait`), `suite.core.json` (the suite
structure, with no product fields), the catalog, diagnostic and extension
schemas, the generator and the diagnostics reference. A workspace catalog
extends it by import:

```yaml
# os-context/test/e2e/schema/actions.catalog.yaml
imports:
  - ../bdd/spec/core.catalog.yaml        # core.* and wait, from the pin
suiteSchema:
  - os-context.suite.json               # adds requires, sharedChecks, cluster, target
actions:
  - name: lifecycle.get
    ...
```

`imports` lists other catalogs, resolved relative to the importing file,
depth first; a name declared twice is an error naming both files.
`suiteSchema` lists suite-schema extensions: JSON Schema fragments that add
top-level suite properties, checked against an extension schema so they can
only add, never loosen or redefine the core. The generator resolves both and
writes the workspace's `suite.schema.json`; every runtime's catalog loader
and the VS Code extension resolve `imports` the same way, so lint,
navigation and completion all see one catalog.

No language needs a schema of its own (checked 2026-10-15): all five
runtimes load the same `suite.schema.json`, `actions.catalog.yaml` and
`diagnostic.schema.json`, and the catalog is language-neutral (parameter and
capture types are JSON types; there is no per-language type, handler or
signature field). Language differences live in each runtime's code and are
held together by the corpus. The one language-aware part is the binding
names, which the catalog schema closes to the five built-in ones; in the core
it accepts any binding name (`^[a-z][a-z0-9]*$`), so a workspace can add a
binding of its own without editing the core.

**Why.** The core must be the same for every workspace and change only here;
a workspace must be able to add actions and fields without editing or copying
it. An import keeps one source of truth, makes the dependency visible in the
workspace's own files, and moving the pin (DEC-S06) updates the core wherever
it is imported.

**Tradeoff.** Catalog loading changes in six places (five runtimes and the VS
Code extension), and a catalog file no longer stands alone. Go to Definition on
`core.set` now opens a file under the pinned submodule, which is right: that
is where it is declared.

**Rejected.** A schema overlay merged by the generator (this design's first
draft): it hides the dependency in a build step, and a runtime reading the
catalog would not see the core actions without repeating the merge.

**Serves.** O2, O3, O4. **Verified by.** E2, E5, E8.

---

### DEC-S06. os-context consumes this repository as a git submodule pinned to a release tag

**Choice.** `os-context/test/e2e/bdd` is a submodule of this repository at a
release tag. Each language refers into it by path: Go with a `replace`
directive, C# with project references, Rust with a path dependency, TypeScript
with a `file:` dependency, PowerShell with `Import-Module`. The generator and
the corpus are read from it too.

**Why.** One pin moves the format spec, the corpus and all five runtimes
together, so os-context can never build against a runtime of one version and a
spec of another. Path references need no package registry, credentials or
network beyond the clone.

**Tradeoff.** Submodules need `git submodule update --init` (CI's checkout does
it with `submodules: true`). Alternatives rejected: five registries (five
credentials, five release pipelines, versions that drift apart); copying files
(the copies drift, which is the problem we are removing).

**Serves.** O4, O5. **Verified by.** E5, E7.

### DEC-S07. Files move as copies with a recorded source commit; history stays in os-context

**Choice.** Each move records the os-context commit it was copied from in the
stage's evidence. os-context deletes its copy only in D10, after its build from
the pin passes.

**Why.** Rewriting history across repositories (`filter-repo`, subtree splits)
is slow and error-prone for a tree this mixed. The recorded commit keeps blame
reachable.

**Serves.** O2, O4. **Verified by.** E5.

### DEC-S08. CI here builds and tests every runtime; the VS Code extension's integration suite runs against `samples/workspace`

**Choice.** CI adds one job per runtime (build, unit tests, corpus), the
divergence check (an injected defect must fail the corpus), and the VS Code
extension's integration suite against `samples/workspace` with the runtimes
built from this commit. `OS_CONTEXT_ROOT` is no longer needed.

**Why.** That is what O1 means in practice: a pull request here is checked
against real bindings.

**Serves.** O1. **Verified by.** E1, E4.

### DEC-S09. One version for the repository; a release tags the runtimes too

**Choice.** The existing automatic release (a new `package.json` version on
`main`) also creates the Go module tag `runtimes/go/v<version>`, and its GitHub
release names the runtime versions it contains.

**Why.** A consumer's pin is one tag; Go's module system requires the
subdirectory tag to resolve a version.

**Serves.** O5. **Verified by.** E7.

## 5. Failure, rollback and cleanup

* **Nothing in os-context changes until D10**, and D10 happens in a worktree
  of os-context, never in its main checkout. Until D10 merges, os-context
  builds exactly as today.
* **A runtime that fails the corpus here blocks its stage**; the copy in
  os-context is unaffected.
* **D10 is reversible by moving the pin back** or reverting the D10 commit in
  os-context: the extension code it adds is self-contained, and the deleted
  copies are restored by the revert.
* **Lab runs (E6) create and delete lab resources through os-context's own
  actions, unchanged.** The rollback, cleanup and ownership rules are
  os-context's; this work does not change them, and E6 records that cleanup
  ran as it does today.

## 6. Verification

Local checks and mocks are separate evidence from E5 and E6; a skipped,
blocked or failed scenario stays open. Every scenario records the source
commits (this repository and, for E5 and E6, os-context), tool versions,
commands, results and cleanup.

### <a id="e1"></a>E1. A fresh clone builds and tests everything with no os-context

* **Given** a clean clone of this repository at the tested commit, on Windows
  with Node.js 24, .NET 10, Go 1.24, Rust stable and PowerShell 7 (with
  `powershell-yaml`), and no os-context checkout anywhere on the machine
  (`OS_CONTEXT_ROOT` unset).
* **When** the documented build-and-test commands run from the repository
  root, and the same commit runs in CI.
* **Then** every runtime builds and passes its unit tests and the corpus; the
  VS Code extension's unit, demo and integration suites pass; no command reads
  a path outside the clone (checked by running in a folder with no parent
  repository and by a scan of the logs for absolute paths outside it).
* **Cleanup.** None: everything is under the clone and `out/`.

### <a id="e2"></a>E2. Five runtimes agree on the relocated corpus, and a defect is caught

* **Given** the corpus and neutral catalog under `conformance/`, and the five
  runtimes built from this commit.
* **When** each runtime's corpus test runs; then the divergence check injects
  its known defect (case-sensitive `equals`) into the Go and TypeScript
  runtimes in turn.
* **Then** all five pass every entry; each finding's code, line and column
  equals the os-context original apart from renamed action names (a recorded
  mapping diff); and with the defect injected the corpus fails, and passes
  again after the revert.
* **Cleanup.** The divergence check reverts its edit; `git status` is clean.

### <a id="e3"></a>E3. An outside extension adds to each runtime

* **Given** the example extension in each runtime's folder (built as a
  separate package that depends on the runtime only through its public API):
  one action `example.echo`, one context key `region`, one option `--region`,
  one rule (a ceiling for suites tagged `slow`).
* **When** a suite using all four runs through the extension-built `suiterun`
  in each language, and the same suite runs through the plain runtime
  `suiterun`.
* **Then** with the extension: the action runs, `${region}` reads the option's
  value, and lint reports the ceiling; without it: `${region}` is `E301` (no
  such context key), the ceiling is not reported, `--region` is refused as an
  unknown flag, and running the action fails its step ("no extension of this
  runtime registers it"). Lint does not report `E104`, because the action is in
  the workspace catalog: lint follows the catalog, execution follows the
  registered actions. Two extensions defining the same action are refused at
  start-up.
* **Cleanup.** None.

### <a id="e4"></a>E4. The VS Code extension's integration suite runs against `samples/workspace`

* **Given** `samples/workspace` and the five runtimes built from this commit.
* **When** `npm run test:integration` runs locally and in CI.
* **Then** every scenario that ran against os-context passes against the
  sample workspace (navigation, lint parity, run parity across bindings,
  scaffolding, live lint through the TypeScript library); the lab scenario
  (B9.3 of the extension's plan) is excluded and still needs a lab.
* **Cleanup.** The suite's own restores; `git status` is clean.

### <a id="e5"></a>E5. os-context, built from the pin, behaves exactly as before

* **Given** an os-context worktree (never the main checkout) with the D10
  change, its submodule at the release tag under test; and, for comparison,
  the same os-context commit before D10.
* **When**, in both: each binding's `suiterun actions --json`; lint of every
  file under `test/e2e/suites`, `provisioning` and `provisioning/recovery`
  with each binding and `--binding-check` for each target; `Build-Schema.ps1
  -Check`; os-context's own unit and Pester tests; its CI workflows on a pushed
  branch.
* **Then** action lists are identical per binding; lint output is identical
  byte for byte after sorting; the generated `suite.schema.json` is identical;
  all tests and workflows pass.
* **Cleanup.** The worktree and branch are kept for the record until D10
  merges, then removed.

### <a id="e6"></a>E6. os-context's lab runs are unchanged (remote, against the real lab)

* **Given** a real lab reachable through os-context's documented jump path,
  its connection file supplied at run time, and os-context built from the pin.
* **When** the portable stage 0 cases run under each binding through
  os-context's `e2e-tests.yml` on its self-hosted runner.
* **Then** each binding's report equals the report from before D10 for the
  same cases (same cases, statuses and failure reasons), and os-context's
  cleanup ran and left the lab at its baseline (its own evidence).
* **Cleanup.** os-context's own teardown; if it fails, the run's evidence and
  lab state are retained and the scenario stays open.

### <a id="e7"></a>E7. A release tags the runtimes and os-context can pin it

* **Given** a version bump merged to `main` here.
* **When** CI releases it.
* **Then** the tags `v<version>` and `runtimes/go/v<version>` exist and point
  at the same commit; the GitHub release lists the runtime versions; moving
  os-context's submodule to the tag and running E5's checks passes.
* **Cleanup.** None.

### <a id="e8"></a>E8. A workspace extends the core by import, and every tool sees one catalog

* **Given** `samples/workspace`, whose catalog imports `spec/core.catalog.yaml`
  and a suite-schema extension adding a top-level field `owner`; and a second
  catalog that imports the first.
* **When** the generator builds the workspace schema; each of the five
  runtimes runs `suiterun actions --json` and lints a suite that uses
  `core.set`, a workspace action and `owner`; the VS Code extension opens
  that suite.
* **Then** the schema accepts `owner` and the workspace action and rejects an
  unknown field; every runtime lists the same actions (core plus workspace)
  and reports the same findings; in the editor, completion offers `core.set`
  and the workspace action, Go to Definition on `core.set` opens
  `spec/core.catalog.yaml`, and a name declared in two imported catalogs is
  reported with both files. An extension that tries to redefine a core field
  is rejected.
* **Cleanup.** None.

## 7. Traceability

| Outcome | Decisions | Deliverables | Scenarios |
| --- | --- | --- | --- |
| O1 | DEC-S01, DEC-S08 | D1–D9 | E1, E2, E4 |
| O2 | DEC-S01, DEC-S02, DEC-S07, DEC-S10 | D1, D2, D13 | E2, E8 |
| O3 | DEC-S03, DEC-S04, DEC-S05, DEC-S10 | D3–D7, D13 | E3, E8 |
| O4 | DEC-S03, DEC-S05, DEC-S06, DEC-S07, DEC-S10 | D10, D11 | E5, E6 |
| O5 | DEC-S06, DEC-S09 | D12 | E7 |
