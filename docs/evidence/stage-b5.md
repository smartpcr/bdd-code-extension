# Stage B5 evidence

Recorded 2026-10-14. Plan: [implementation.md, stage B5](../implementation.md#stage-b5-declaring-and-implementing-an-action).
Scenario: [E-B6](../design.md#e-b6-a-new-action-is-declared-and-implemented-in-every-binding-from-the-editor), four-binding part.

## Identity

| What | Value |
| --- | --- |
| This repository | working tree on top of `77f0667` (stage B4), not committed |
| `os-context` | `E:\work\os\os-context` at `e9da5ab5` (main checkout read only); every edit ran in a disposable worktree of `e9da5ab5` that the harness removed |
| Toolchains | Go (`go build`, `go vet`), Rust (`cargo build`, target dir `%TEMP%\bdd-b6-rs`), .NET 10 (`dotnet build Hci.E2E.Suite.sln`, warnings are errors), `pwsh` 7.6.7 with Pester 5.7.1 and `powershell-yaml` 0.4.12 |
| VS Code | Insiders `4c6cba1504` with `redhat.vscode-yaml` |

## Unit gate

`npm run test:unit` with `OS_CONTEXT_ROOT` set, exit 0: 163 tests, none skipped, 100 % of statements, branches, functions and lines over `src/core`, `src/config` and `src/tools`. New for B5:

* `catalogEdit.test.ts`:
  * The type table: string, a `${...}` string (type `string` with `# TODO type`), integer, number, boolean, array, object, and null (`any` with `# TODO type`).
  * `commonStepKeys` reading `$defs.stepEnvelope.properties`, and saying nothing when it cannot.
  * The rendered entry.
  * Insertion after the family's last entry, after the last entry, and under an empty `actions:`, with and without a final line break, and stopping at the next top-level key.
  * B5.1-4: `when` and `action` never become parameters, and the result parses as a catalog with the new name last.
  * B5.1-3 and every other refusal.
  * `addBindingEdit` in the catalog's order, with an unlisted binding last.
* `stubs.test.ts`:
  * The three naming rules.
  * Templates and their `@@` sections.
  * gofmt's value column.
  * For each of the six registries (Go, Rust and C#, core and lifecycle), the insertion on an excerpt of the real file: the entry's indentation, Rust's sorted `names()` and its arm before the catch-all, C#'s CRLF kept, an empty map or dictionary, a file without `#[cfg(test)]`.
  * A workspace template override.
  * Every refusal: no template, a site already there, a name already declared, a missing section, and each missing anchor.

The six real registry files at `e9da5ab5`, with stubs for `demo.echo` and `lifecycle.demoEcho` added by `planStub`, were also compiled once in a scratch worktree before the scenario was written. `go build ./...` and `go vet ./...`, `cargo build` (no warnings) and `dotnet build` all succeeded.

## Integration (real VS Code), final build

| Session | Result |
| --- | --- |
| `oscontext` | 24 passing, 1 pending (PowerShell E-B1, blocked as recorded in stage B2) |
| `worktree` | 33 passing (the 8 E-B6 tests among them) |
| `empty` | 1 passing |
| `untrusted` | 4 passing |

E-B6, four-binding part (`scaffold.test.ts`, worktree session). The scratch suite `test/e2e/suites/_scratch-b6.yml` has one step with `when:`, `why:`, `action: demo.echo`, `text: hello` and `times: 2`. The worktree is restored afterwards to exactly the `git status` it had before.

1. **E104 and the quick fix (B5.1).**
   * Lint (Go) reports `E104` on `demo.echo`. Nothing else reports a diagnostic at the action: `redhat.vscode-yaml` does not underline it, because the schema gives `action` no enum (as recorded for B3.1).
   * *Declare action demo.echo* is offered once, as the preferred quick fix. Applying it gives the catalog entry with `text: string`, `times: integer` and `bindings: [powershell]`; `when` and `why` are not parameters (B5.1-4). It creates `scripts/e2e/actions/DemoEcho.ps1` (ASCII, `Register-LabAction -Name 'demo.echo'`) and regenerates `suite.schema.json` (generator exit 0).
   * After the next save of the suite, `E104` is gone.
2. **One undo (B5.1-2).** With the catalog in the editor, one `undo` removed the catalog entry and deleted `DemoEcho.ps1`, with no confirmation dialog. Declaring again restored both.
3. **Declaring twice (B5.1-3)** refuses with "already in the catalog" and leaves the catalog byte-identical.
4. **Implement (B5.2-B5.4).**
   * On the step, the code actions offer exactly *Implement demo.echo in C#*, *in Go* and *in Rust*.
   * Go was applied from the code action, Rust and C# through the command. Each regenerated the schema (exit 0).
   * The catalog then lists `bindings: [powershell, csharp, go, rust]`, in the catalog's order. The *Suite bindings* view shows no drift in any row, so each recognizer finds the new registration.
   * Implementing in Go again refuses, and no *Implement* action is offered any more.
5. **The repository's checks (B5.1-1).**
   * `Build-Schema.ps1 -Check` exits 0.
   * The catalog checks of `SuiteLint.Tests.ps1` (its Y1.3 block, read from the file at run time by `test/integration/harness/catalog-y13.ps1`, without its action-count line) pass: 953 checks over 101 actions.
   * `SuiteLint.Tests.ps1` as a whole **does not pass, and this stays open**; see below.
6. **Builds, programs and runs (B5.2-1/2/3, B5.3-1/2/3, B5.4-1/2/3).** For Go, Rust and C#:
   * the build succeeds (`go vet` clean; Rust with no warnings; C# with warnings as errors);
   * the program's `actions --json` includes `demo.echo`;
   * `suiterun run --path test/e2e/suites/_scratch-b6.yml --results <file> --format junit` exits 1, and the results report says `demo.echo: not implemented in the <Go|Rust|C#> binding yet`. The trace file carries outcomes only (`status: failed`, `reason: action`), so the message is read from the results report.

## Still open

* **B5.1-1, `SuiteLint.Tests.ps1` as a whole: blocked in `os-context`.** The file is one Pester test that runs a long harness. It cannot pass for two reasons, neither of which the extension can change:
  1. On the clean tree it already fails, at line 248 (`Expected E101 at line 4; found: E104`). This is the PowerShell 7.6.7 `Test-Json` defect recorded in [stage B2](stage-b2.md).
  2. Line 164 asserts `$catalogNames.Count -eq 100`. Declaring any action makes it 101, so that line fails after every declaration, whoever makes it.

  The checks the declaration is for (catalog and registry are the same set, the catalog validates against its schema, every entry is complete and correctly interruptible) are the Y1.3 block, and they pass. The literal contract stays open until `os-context` fixes the `Test-Json` defect and either derives the count or the plan's contract names Y1.3 instead.
* **B5.5, TypeScript: blocked on B7.5 and B7.7.** `test/e2e/bindings/typescript` does not exist at `e9da5ab5`, and the plan requires the lifecycle handler signature to be read from the real file before its template is written. E-B6's TypeScript part (the fifth binding in `bindings:`, `npm run build` and `npm test`) runs with B5.5.

## Departures

* **No `gofmt` or `rustfmt` after an insertion.** At `e9da5ab5`, `internal/actions/actions.go` is not gofmt-clean (`gofmt -l` lists it: a struct field's alignment) and the Rust crate is not rustfmt-clean at default settings (it has no `rustfmt.toml`). Running either formatter would rewrite lines the command does not own, and the one undo would then carry unrelated changes. Instead:
  * the inserted text is written already formatted;
  * a Go map entry takes the value column of the entry above it when it fits, which is where gofmt puts it;
  * the stubs compile and vet clean, as above.
* **Rust `ActionError::action` takes `impl Into<String>`** (`src/actions.rs:24`), not `String`. The plan's template, which passes `.to_string()`, compiles either way and is kept.
* **Rust's `dispatch()` ends in `other =>`, not `_ =>`.** The arm goes before any catch-all arm (`_` or a binding name), else before the match's closing brace.
* **Names use every segment.** `demo.echo` becomes `demoEcho`, `demo_echo` and `DemoEcho`; `lifecycle.streamWait` becomes `lifecycleStreamWait`. This follows the plan's examples. Its wording "segments after the family" would give `echo`, which collides with existing handlers such as Go's `get`.
* **Templates have `@@ <section>` parts** (`registration`, `handler`, and `name` for Rust lifecycle), so one file per binding and family holds the registry line and the handler. The command refuses when an override lacks a section.
* **Registry paths are fixed relative to the repository root** (the anchor table), not a setting.
* **The quick fix and the commands read the document's current text**, not the index. The index trails the buffer by `INDEX_DEBOUNCE_MS`, and a file created a moment before is not in it yet. The first full run caught this: the fix was missing on a just-written suite. Code actions answer only for files the suite globs match.
* **An *Implement <action> in <binding>* code action** (kind `refactor.bddSuite`) is offered on a step whose action a binding with a template does not yet register, in addition to the command.

## Defects found while building, and the unstated decision behind each

| Found | Cause | Fix | The decision that was missing |
| --- | --- | --- | --- |
| The quick fix was not offered on a suite written a moment before | the provider found the step through the index, which had not yet seen the file | steps are read from the document's text | A quick fix answers for the text on screen |
| An entry in an empty C# dictionary was indented like the `{` line | the line above the closing `};` was taken as an entry even when it opened the block | an opening line gives the closing line's indent plus one level | An anchor's neighbour is an entry only when it is one |
| `watch.test.ts` failed after the scaffold scenario | both use `demo.echo` as a name, and the scaffold scenario left it declared in the shared worktree | the scaffold scenario restores the worktree to its starting `git status` | A scenario that edits a shared worktree leaves it as it found it |
| `B2.2 lint on save` failed in full runs only | `lint()` in the test helpers retried a superseded lint but not a cancelled one, and the lint that opening the file schedules after `LINT_DEBOUNCE_MS` cancels a slower explicit lint (B2.2-3) | the helper asks again after `cancelled` too | A helper waits for a finished lint, whichever request finishes it |
| A cold `cargo build` in a worktree under the scratchpad failed with `LNK1104` | the build-script paths passed the Windows path limit | `CARGO_TARGET_DIR` is a short directory under `%TEMP%` | Build output lives at a short path |

## Harness additions

* `BDD_FILES` (comma-separated file-name prefixes) narrows a session to some test files. It was used only to isolate the B2.2 race above; every result in this record is from full sessions.
* `test/integration/harness/catalog-y13.ps1`, described above. It reads the checkout and writes nothing, and was checked against the clean main checkout (947 checks over 100 actions) before it was used.
