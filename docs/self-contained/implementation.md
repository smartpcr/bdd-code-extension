# A self-contained BDD suite repository: implementation plan

Status: **stage S1 built (2026-10-15), evidence in [docs/evidence/self-contained-s1.md](../evidence/self-contained-s1.md); S2 to S7 not started.** The design, its outcomes
(O1–O5), decisions (DEC-S01–DEC-S10) and scenarios (E1–E8) are in
[design.md](design.md). This plan says how each outcome is built, in what
order, and what evidence closes each step.

Working rules (from the repository's standing rules):

* **os-context is changed only in a worktree**, never in its main checkout
  `E:\work\os\os-context`, and only from stage S6. ASCII only in os-context
  files.
* **Statuses stay separate**: designed, built, unit-tested, locally accepted
  and remotely accepted. A step is ticked only with its evidence recorded in
  `docs/evidence/self-contained-s<n>.md`; a skipped, blocked or failed
  scenario stays open.
* **Each copy records its source**: the os-context commit it was copied from
  (DEC-S07).

## Contents

* [1. Deliverables](#1-deliverables)
* [2. Order and dependencies](#2-order-and-dependencies)
* [3. Stages](#3-stages)
* [4. Acceptance index](#4-acceptance-index)

## 1. Deliverables

Priority: **P0** is needed for O1–O3 (this repository self-contained and the
runtimes extensible); **P1** is needed for O4–O5 (os-context switched, releases
pinned). Priority orders the work; it never weakens a completion condition.

### <a id="d1"></a>D1. The core spec in `spec/`, extensible by import (P0)

* **Result.** `spec/` holds only the core (DEC-S10): `suite.core.json` (the
  suite structure with no product fields), `core.catalog.yaml` (`core.*` and
  `wait`), the catalog schema extended with `imports` and `suiteSchema`, an
  extension schema that a suite-schema extension must satisfy (it may only add
  top-level properties), the diagnostic schema, the diagnostics reference and
  the generator, which resolves imports and extensions.
* **Why.** O2: this repository owns the core and only the core; a workspace
  adds to it by import.
* **How.** Copy `suite.base.json` (as `suite.core.json`),
  `actions.catalog.schema.json`, `diagnostic.schema.json`, `diagnostics.md`,
  `Build-Schema.ps1`, `Schema.Tests.ps1` and `README.md`. Remove
  `requires`, `sharedChecks`, `cluster` and `target` from the core schema
  and write them as os-context's suite-schema extension (handed over in D10).
  Split `core.*` and `wait` out of os-context's catalog into
  `core.catalog.yaml`. Add `imports` (depth first, relative to the importing
  file; a duplicate name is an error naming both files; an import cycle is an
  error) and `suiteSchema` to the catalog schema and to the generator. Open
  the binding-name list in the catalog schema to a name pattern (DEC-S10). Leave
  os-context's other 94 actions and its scenario-catalog schema in os-context.
* **Files.** `spec/*`.
* **Depends on.** Nothing.
* **Done when.** `Schema.Tests.ps1` passes, including imports, duplicates,
  cycles and an extension that tries to redefine a core field; a catalog of
  os-context's 94 actions that imports `core.catalog.yaml`, with its
  suite-schema extension, generates a `suite.schema.json` that validates
  exactly like os-context's today: every definition and branch equal once
  descriptions, comments and the order of the action list are set aside
  (recorded diff: empty).
* **Proved by.** E1, E5, E8.

### <a id="d2"></a>D2. The corpus and its neutral catalog in `conformance/` (P0)

* **Result.** The corpus with `conformance/catalog.yaml` (importing
  `spec/core.catalog.yaml` and declaring the fixture actions of DEC-S02), every file renamed by one mapping table, and
  the divergence check pointing at `runtimes/`.
* **Why.** O2; it is what all five runtimes are tested against.
* **How.** Copy `test/e2e/conformance`. Write `conformance/rename.json`
  (`cluster.state` to `fixture.state`, ...) and a script that applies it to
  `.yml` and `.expected.json` files and reports every replacement. Declare the
  fixture actions with the replaced actions' exact parameters and binding
  lists. Set each manifest entry's catalog to `conformance/catalog.yaml`. Move
  the four `lifecycle-*` entries and the E214 entries to a hand-over folder for
  D10.
* **Files.** `conformance/**`.
* **Depends on.** D1.
* **Done when.** The rename report lists only action names; every remaining
  manifest entry is unchanged apart from them; the first runtime (D3) passes
  the whole corpus.
* **Proved by.** E2.

### <a id="d3"></a>D3. The TypeScript runtime in `runtimes/typescript` (P0)

* **Result.** `@bdd-suite/runtime`: library, `suiterun` CLI, in-process
  `createLinter`, the extension API (DEC-S03), an example extension, and the
  corpus passing.
* **Why.** O1, O3. TypeScript first: it is this repository's own binding (the
  extension's live lint uses it) and needs only Node.js, so it proves D1 and D2
  earliest.
* **How.** Copy from the os-context worktree's untracked
  `test/e2e/bindings/typescript` (excluding `node_modules`, `dist*`,
  `coverage`, `r.xml`). Remove `src/lifecycle`. Add `Extension` (actions,
  context keys, options, rules, environment prefix), `main(argv, extensions)`
  and `createLinter({..., extensions})`; make `expr` roots and dataflow keys
  come from extensions; turn the lifecycle ceiling into a rule the example
  extension shows; default prefix `BDD_SUITE_`. Fix `--schema-root` so a given
  root is used without a repository walk. The catalog loader resolves
  `imports` (DEC-S10). Corpus tests read `conformance/`.
* **Files.** `runtimes/typescript/**`; the VS Code extension's
  `bindings.typescript` default library path is unchanged (consumers keep it).
* **Depends on.** D1, D2.
* **Done when.** `npm test` passes (100% line coverage, as today); the corpus
  passes; E3's TypeScript part passes.
* **Proved by.** E2, E3.

### <a id="d4"></a>D4. The Go runtime in `runtimes/go` (P0)

* **Result.** Module `github.com/smartpcr/bdd-code-extension/runtimes/go`:
  public packages (actions, exec, model, trace, value, walk, expr, cli, run)
  under `suite/`, the rest internal; `suiterun.Main(ext...)`; example
  extension; corpus passing.
* **How.** Copy; remove `internal/lifecycle` and `internal/run/lifecycle.go`;
  move the packages an extension needs out of `internal/`; replace the single
  `Dispatcher` slot with a composite of extension dispatchers; lab options,
  context keys, lifecycle rule, prefix and catalog `imports` as in D3.
* **Depends on.** D1, D2; D3 as the reference API shape.
* **Done when.** `go vet ./... && go test ./...` passes; corpus passes; E3's
  Go part passes.
* **Proved by.** E2, E3.

### <a id="d5"></a>D5. The Rust runtime in `runtimes/rust` (P0)

* **Result.** Crate `suiterun` (library and binary) with a public `Action`
  trait and `Registry`, `run::execute_with(&options, &registry)`,
  `main_with(&extensions)`, example extension, corpus passing.
* **How.** Copy; remove `src/lifecycle`, `tests/stream_loopback.rs`, the
  `reqwest` and `getrandom` dependencies; make the handler type public; pass a
  registry into `run` and `exec` instead of the free `registry()`/`names()`;
  a per-run extension context replaces `Option<lifecycle::Shared>`; vocabulary
  and catalog `imports` as in D3.
* **Depends on.** D1, D2; D3 as reference.
* **Done when.** `cargo test` passes; corpus passes; E3's Rust part passes.
* **Proved by.** E2, E3.

### <a id="d6"></a>D6. The C# runtime in `runtimes/csharp` (P0)

* **Result.** `Bdd.Suite` (library), `Bdd.Suite.Cli` (`suiterun`),
  `Bdd.Suite.Tests`; `Runner.Run(args, extensions)`; example extension;
  corpus passing.
* **How.** Copy; rename namespaces and assemblies; remove
  `Actions/Lifecycle`, `LifecycleTests`, `EventStreamTests`, `LoopbackServer`;
  replace the hard-wired `LifecycleContext` in `Runner.Running.cs` with the
  extensions' composite dispatcher; vocabulary and catalog `imports` as in D3.
* **Depends on.** D1, D2; D3 as reference.
* **Done when.** `dotnet build` and `dotnet test` pass; corpus passes; E3's
  C# part passes.
* **Proved by.** E2, E3.

### <a id="d7"></a>D7. The PowerShell runtime in `runtimes/powershell` (P0)

* **Result.** Module `BddSuite` with the suite model, lint, step execution,
  expressions, assertions, report comparison, the action registry
  (`Register-SuiteAction`, alias `Register-LabAction`), `core.*` and `wait`,
  and `Invoke-BddSuite` (the generic half of `Invoke-LabTestSuite.ps1`), with
  `-ActionPath <folders>` and `-Extension <modules>`; corpus passing.
* **How.** Copy the generic files of `scripts/e2e` (design section 2). Split
  the runner: lab configuration, credentials, budgets, evidence, scenario
  catalog lint and result publishing stay in os-context's wrapper (D10). The
  step runspace loads the registry and the extensions' modules instead of
  `LifecycleTestSupport.psm1` and `LifecycleStream.psm1` by fixed path.
  Redaction becomes an extension hook. The catalog loader resolves `imports`.
* **Depends on.** D1, D2; D3 as reference.
* **Done when.** `Conformance.Tests.ps1 -RunHarness` and the generic Pester
  tests pass; E3's PowerShell part passes.
* **Proved by.** E2, E3.

### <a id="d8"></a>D8. `samples/workspace`: a consumer workspace in this repository (P0)

* **Result.** A small but realistic workspace: a catalog, suites (including
  one as large as os-context's `lifecycle-stage1.yml`, for the extension's
  latency test), and example actions in all five languages built on the
  runtimes through their example extensions.
* **Why.** It replaces the os-context checkout as the VS Code extension's
  integration fixture (O1), and shows consumers the layout.
* **How.** Port every scenario's fixture that the integration suite takes
  from os-context (`smoke.yml`, the typo and dataflow files, the large suite,
  the scratch suites it writes) to equivalents using the sample catalog;
  record each mapping in the stage evidence.
* **Depends on.** D3–D7.
* **Done when.** Each language's `suiterun` built for the sample lints and
  runs every sample suite with the same results.
* **Proved by.** E4.

### <a id="d9"></a>D9. CI and the VS Code extension's tests, self-contained (P0)

* **Result.** `ci.yml` builds and tests each runtime, runs the divergence
  check, and runs the extension's integration suite against
  `samples/workspace`; `OS_CONTEXT_ROOT` is gone from code and docs.
* **How.** One job per runtime (Linux for Go, Rust, C# and TypeScript; Windows
  for PowerShell and the extension); the extension job builds the five
  runtimes first. Change `test/integration/runTest.ts` and the harness to use
  `samples/workspace`; keep the lab mode for B9.3. Update the README.
* **Depends on.** D2–D8.
* **Done when.** E1 and E4 pass in CI on a pull request.
* **Proved by.** E1, E4.

### <a id="d10"></a>D10. os-context consumes the pin (P1, in an os-context worktree)

* **Result.** os-context builds every binding from this repository at a tag,
  with its own extensions, catalog (importing the core), suite-schema
  extension and moved corpus files, and its own
  copies of the runtimes, spec and corpus deleted.
* **How.** Add the submodule `test/e2e/bdd` at the release tag. Per language,
  an os-context extension holding its lifecycle actions, lab options, context
  keys (`cluster`, `target`, `labId`, `apiUrl`), the lifecycle rule (900 s),
  E214 and the prefix `HCI_SUITE_`; a `suiterun` built from runtime plus
  extension. PowerShell: `Invoke-LabTestSuite.ps1` becomes a wrapper that
  loads `BddSuite` and its actions. os-context's catalog imports the
  pinned `core.catalog.yaml` and drops its own copies of `core.*` and
  `wait`; its suite-schema extension adds `requires`, `sharedChecks`,
  `cluster` and `target`; `Build-Schema.ps1` runs from the submodule. Move the handed-over corpus files to os-context's
  tests. Update `suite-conformance.yml`, `suite-lint.yml` and `e2e-tests.yml`
  (checkout with submodules; paths). Update the scripts that name binding
  source files (`LifecycleBudgetSupport.psm1`, `LifecycleSetSegment.psm1`,
  `Docs.Tests.ps1`).
* **Depends on.** D1–D7, D12 (a tag to pin).
* **Done when.** E5 passes on a pushed os-context branch.
* **Proved by.** E5.

### <a id="d11"></a>D11. os-context lab acceptance (P1, remote)

* **Result.** E6 run and recorded on the real lab.
* **Depends on.** D10 merged in os-context's branch; a lab.
* **Done when.** E6 passes with cleanup evidence. Until a lab is available
  this stays open, never passed.
* **Proved by.** E6.

### <a id="d12"></a>D12. Releases tag the runtimes (P1)

* **Result.** The release job also tags `runtimes/go/v<version>` and lists
  the runtime versions in the release notes.
* **Depends on.** D9.
* **Done when.** E7 passes on a real release.
* **Proved by.** E7.

### <a id="d13"></a>D13. The VS Code extension resolves catalog imports (P0)

* **Result.** The extension's index reads a catalog's `imports` (and their
  imports), so completion, hover, the binding table, scaffolding and Go to
  Definition cover core and workspace actions together; a duplicate name is a
  diagnostic on both declarations; *Declare action* writes into the
  workspace's own catalog, never an imported one.
* **Why.** O2 and E8: the editor must see the same catalog as the runtimes.
* **How.** `src/core/catalog.ts` follows `imports` from `bddSuite.catalogPath`;
  each catalog entry records its file; the watcher also watches imported
  files; `catalogEdit.ts` targets the root catalog.
* **Files.** `src/core/catalog.ts`, `src/core/catalogEdit.ts`,
  `src/core/workspaceIndex.ts`, `src/features/indexer.ts`, unit tests.
* **Depends on.** D1.
* **Done when.** Unit tests at 100% coverage include imports, duplicates and
  cycles; E8's editor part passes in the integration suite.
* **Proved by.** E8.

## 2. Order and dependencies

```text
D1 spec ──> D13 editor imports
   │
   └──> D2 corpus ──> D3 TypeScript ──┬─> D4 Go ──┐
                                          ├─> D5 Rust ├─> D8 samples ──> D9 CI ──> D12 release ──> D10 os-context ──> D11 lab
                                          ├─> D6 C#   │
                                          └─> D7 PS ──┘
```

* **Implementation dependencies.** Each arrow above. D4–D7 are independent of
  one another and can be built in parallel once D3 fixes the API shape.
* **Runtime prerequisites.** Toolchains on the build machine and in CI: Node.js
  24, .NET 10, Go 1.24, Rust stable, PowerShell 7 with `powershell-yaml`.
* **When the change becomes visible to os-context.** Only at D10. Before that,
  os-context is unaffected and keeps its own copies.

## 3. Stages

Each stage lists its result, entry dependencies, priority, steps (at most 20)
and exit evidence.

### Stage S1: spec, corpus and the TypeScript runtime (P0)

Result: D1, D2, D3, D13. Entry: none. Exit evidence: E2 for TypeScript; E3
for TypeScript; generator byte-for-byte check; D13 unit tests.

- [x] S1.1 Record the os-context source commit; copy the spec files (D1).
- [x] S1.2 `suite.core.json` without product fields; those fields written as os-context's suite-schema extension (hand-over).
- [x] S1.3 `core.catalog.yaml`; `imports` and `suiteSchema` in the catalog schema, extension schema, generator; schema tests (imports, duplicates, cycles, redefinition refused).
- [x] S1.4 os-context's 94 actions importing the core, with its extension, generate a `suite.schema.json` that validates exactly like its own (empty diff).
- [x] S1.5 Copy `conformance/`; write `rename.json` and the rename script (D2).
- [x] S1.6 Write `conformance/schema/actions.catalog.yaml` with core, wait and fixture actions.
- [x] S1.7 Apply the rename; record the replacement report; hand over lifecycle and E214 entries.
- [x] S1.8 Copy the TypeScript runtime; remove `src/lifecycle` (D3).
- [x] S1.9 Rename the package; point corpus tests at `conformance/`.
- [x] S1.10 Add the `Extension` type: actions, context keys, options, rules, prefix.
- [x] S1.11 Make expression roots and dataflow keys come from extensions.
- [x] S1.12 Turn the lifecycle ceiling into an extension rule; default prefix `BDD_SUITE_`.
- [x] S1.13 Fix `--schema-root` to work without a repository walk.
- [x] S1.14 `main(argv, extensions)` and `createLinter({..., extensions})`.
- [x] S1.15 Example extension and E3's TypeScript test.
- [x] S1.16 `npm test` at 100% line coverage; corpus passes (E2, TypeScript).
- [ ] S1.17 CI job for the TypeScript runtime. (Built: jobs `spec` and `runtime-typescript` in `ci.yml`, YAML-parsed; open until they pass on GitHub, which needs a push.)
- [x] S1.18 VS Code extension resolves catalog imports (D13), unit tests at 100%.

### Stage S2: Go and Rust runtimes (P0)

Result: D4, D5. Entry: S1. Exit evidence: E2 and E3 for Go and Rust.

- [ ] S2.1 Copy Go; record source commit; remove lifecycle packages.
- [ ] S2.2 New module path; move extension-facing packages out of `internal/`.
- [ ] S2.3 Composite dispatcher; `suiterun.Main(ext...)`.
- [ ] S2.4 Extension-supplied options, context keys, rules, prefix.
- [ ] S2.5 Corpus tests read `conformance/`; `go vet`, `go test` pass.
- [ ] S2.6 Go example extension; E3 Go part.
- [ ] S2.7 Copy Rust; record source commit; remove lifecycle, stream test, lifecycle-only dependencies.
- [ ] S2.8 Public `Action` trait and `Registry`; `run::execute_with`.
- [ ] S2.9 Per-run extension context; options, keys, rules, prefix from extensions.
- [ ] S2.10 Corpus tests read `conformance/`; `cargo test` passes.
- [ ] S2.11 Rust example extension; E3 Rust part.
- [ ] S2.12 CI jobs for Go and Rust.

### Stage S3: C# runtime (P0)

Result: D6. Entry: S1. Exit evidence: E2 and E3 for C#.

- [ ] S3.1 Copy; record source commit; remove lifecycle code and tests.
- [ ] S3.2 Rename `Hci.E2E.Suite*` to `Bdd.Suite*`.
- [ ] S3.3 Composite dispatcher replaces the hard-wired `LifecycleContext`.
- [ ] S3.4 `Runner.Run(args, extensions)`; options, keys, rules, prefix from extensions.
- [ ] S3.5 Corpus tests read `conformance/`; `dotnet test` passes.
- [ ] S3.6 C# example extension; E3 C# part.
- [ ] S3.7 CI job for C#.

### Stage S4: PowerShell runtime (P0)

Result: D7. Entry: S1. Exit evidence: E2 and E3 for PowerShell; E2's
divergence check for Go and TypeScript.

- [ ] S4.1 Copy the generic modules and actions; record source commit.
- [ ] S4.2 Module `BddSuite`; `Register-SuiteAction` with alias `Register-LabAction`.
- [ ] S4.3 Split the runner into `Invoke-BddSuite` (generic) and a hand-over list for os-context's wrapper.
- [ ] S4.4 Step runspace loads registry and extension modules, not lifecycle modules by path.
- [ ] S4.5 Redaction as an extension hook.
- [ ] S4.6 `-ActionPath` and `-Extension`; options, keys, rules, prefix from extensions.
- [ ] S4.7 `Conformance.Tests.ps1 -RunHarness` and generic Pester tests pass.
- [ ] S4.8 PowerShell example extension; E3 PowerShell part.
- [ ] S4.9 Divergence check runs against `runtimes/go` and `runtimes/typescript`.
- [ ] S4.10 CI jobs for PowerShell and the divergence check.

### Stage S5: sample workspace, extension tests and CI self-contained (P0)

Result: D8, D9. Entry: S1–S4. Exit evidence: E1, E4 and E8 in CI.

- [ ] S5.1 `samples/workspace` catalog and layout.
- [ ] S5.2 Port each integration fixture from os-context; record the mapping.
- [ ] S5.3 A large suite for the latency test.
- [ ] S5.4 Example actions in five languages; each `suiterun` lints and runs every sample suite.
- [ ] S5.11 E8: the sample catalog imports the core; generator, five runtimes and the editor see one catalog.
- [ ] S5.5 Integration harness uses `samples/workspace`; remove `OS_CONTEXT_ROOT`.
- [ ] S5.6 Integration suite passes locally (E4, local).
- [ ] S5.7 CI: extension job builds the runtimes and runs the integration suite.
- [ ] S5.8 E1 on a clean clone with no os-context on the machine.
- [ ] S5.9 E1 and E4 in CI on a pull request.
- [ ] S5.10 README and docs updated: layout, building each runtime, writing an extension.

### Stage S6: os-context consumes the pin (P1, os-context worktree)

Result: D12, D10. Entry: S5. Exit evidence: E7; E5 on a pushed os-context
branch.

- [ ] S6.1 Release job tags `runtimes/go/v<version>`; a release made; E7 tags checked.
- [ ] S6.2 New os-context worktree and branch; record both commits.
- [ ] S6.3 Add submodule `test/e2e/bdd` at the tag.
- [ ] S6.4 Record the "before" baseline: action lists, lint output, generated schema.
- [ ] S6.5 Go extension and `suiterun` from runtime plus extension.
- [ ] S6.6 Rust extension and binary.
- [ ] S6.7 C# extension and CLI project.
- [ ] S6.8 TypeScript extension and CLI.
- [ ] S6.9 PowerShell: `Invoke-LabTestSuite.ps1` wrapper over `BddSuite`; actions registered as an extension.
- [ ] S6.10 Catalog imports the pinned core; suite-schema extension; `Build-Schema.ps1` from the submodule; schema identical.
- [ ] S6.11 Moved corpus files into os-context's tests.
- [ ] S6.12 Update scripts naming binding source files.
- [ ] S6.13 Workflows: submodule checkout and new paths.
- [ ] S6.14 Delete os-context's copies of spec, corpus and runtimes.
- [ ] S6.15 E5: action lists, lint output and schema identical to the baseline.
- [ ] S6.16 E5: os-context unit and Pester tests pass.
- [ ] S6.17 E5: workflows pass on the pushed branch.

### Stage S7: lab acceptance (P1, remote)

Result: D11. Entry: S6 and a lab. Exit evidence: E6 with cleanup.

- [ ] S7.1 Record the "before" lab report for the stage 0 cases per binding (or reuse a recorded one at the same os-context commit).
- [ ] S7.2 Run the stage 0 cases per binding through `e2e-tests.yml` on the branch.
- [ ] S7.3 Compare reports; record cleanup evidence; E6 verdict.

## 4. Acceptance index

| Scenario | Deliverables | Stage | Needs a lab | Status |
| --- | --- | --- | --- | --- |
| [E1](design.md#e1) | D1–D9 | S5 | no | not run |
| [E2](design.md#e2) | D2–D7 | S1–S4 | no | TypeScript part passed locally (2026-10-15); C#, Go, Rust, PowerShell and the divergence check not run |
| [E3](design.md#e3) | D3–D7 | S1–S4 | no | TypeScript part passed locally (2026-10-15); other languages not run |
| [E4](design.md#e4) | D8, D9 | S5 | no | not run |
| [E5](design.md#e5) | D10 | S6 | no | not run |
| [E6](design.md#e6) | D11 | S7 | yes | not run |
| [E7](design.md#e7) | D12 | S6 | no | not run |
| [E8](design.md#e8) | D1, D3–D7, D13 | S1, S5 | no | not run |
