# Stage T4 evidence: Go

Plan: [docs/test-providers/implementation.md](../test-providers/implementation.md#stage-t4-go-p1).
Recorded 2026-10-19 on Windows 11 with Go 1.27.0 (the sample module declares
`go 1.24`, the oldest Go with `tool` directives). Nothing here has run in CI.

## What was built

| Where | What |
| --- | --- |
| `runtimes/go/suite/exec/session.go` | **New.** `RunContext` (options, extensions, trace, the guarded opt-in, the trace file) with `RunContextFrom(lookup, ext...)` / `FromEnvironment` reading `BDD_SUITE_OPTION_<FLAG>`, `TAGS`, `DRY_RUN`, `ALLOW_GUARDED`, `TRACE_FILE`, `RECORD_PATH` and `PARAM_<NAME>`; `WriteTrace`. `Session` with `Open`, `Cases`, `IndexOf`, `IsSelected`, `Setup` (lazy, once), `BeforeEach` (takes the case lock), `RunCase`, `AfterEach` (settles the result, writes the case's trace entries, releases the lock) and `Teardown` (once, only if setup ran). Hook failures are recorded and reported by the case, never panicked. |
| `runtimes/go/suite/exec/exec.go` | `RunFile` rebuilt on the session: Open, Setup, BeforeEach / RunCase / AfterEach per case, Teardown (a failure adds the `teardown` case with reason hook, as before). `CaseResult` gained `Reason` and `AfterEachFailed`. The old one-level `cloneScope` is gone. |
| `runtimes/go/suite/model/ordered.go` | `Map.DeepClone`: a case starts from a deep copy of the setup's captures (rule 5). |
| `runtimes/go/suite/trace/trace.go`, `suite/expr/expr.go` | A mutex on `Trace` (with `Snapshot`), an atomic identifier counter in `expr`. |
| `runtimes/go/suite/generate/` | **New.** Config loading with the schema's checks, globs, the plan (`Build`, offline-action guard over the expanded steps, identifiers), plan JSON, and the Go template: `bddsuite_main_bdd_test.go` with `TestMain` calling `suitetest.Main`, one `<Suite>_bdd_test.go` per suite with `TestSuite_<id>` and one `t.Run` per case and row; the output is `go/format`ed; `Write` rewrites only changed files, removes only files that carry its header, and with `check` reports stale ones. Golden files in `testdata/golden`. |
| `runtimes/go/suite/suitetest/` | **New.** `Main(m, ext...)` builds the run context from the environment and writes the trace after the run; `Open(t, suite, schemaRoot, guarded)` lints, opens the session and registers teardown with `t.Cleanup` (a failure is `t.Errorf` on the parent); `(*Suite).Case(name)` runs BeforeEach, registers AfterEach with `t.Cleanup`, runs the case and reports with `t.Skip` / `t.Error`. |
| `runtimes/go/suite/cli`, `suite/run/generate.go` | The `generate` verb: `--config` (repeatable), `--plan`, `--check`, `--provider`, `--out`. A suite that does not lint clean refuses with its finding and exit 2. |
| `runtimes/go/internal/where/where.go` | `fixture.append` in the corpus extension (Go appends to a copy: a slice in a map cannot grow in place). |
| `runtimes/go/internal/conformance/{session,generate}_test.go` | **New.** E1 (the execute corpus through the session, cases in file order and reversed, results equal to `RunFile`'s) and E3 (the manifest's `generate` list). |
| `samples/workspace/tests/go/` | **New** module `example.com/shop/suitetests`: package `shop` (the sample workspace's suites and the shared local ones, extension `workspace.Shop`), package `corpus` (the conformance corpus, extension `corpusext.Extension`), each with `//go:generate go tool suiterun generate --config bddsuite.tests.yaml`. The generated `*_bdd_test.go` files are committed, as Go convention has it. `scenarios.mjs` runs E5, E9–E12. |
| `samples/workspace/tests/suites/` | The local suites (`order-placement.yml`, `overlap-{a,b,c}.yml`) moved from `csharp/shared/suites` so every language's sample runs the same ones; the C# config and `csharp/scenarios.mjs` point at the new place. |
| `samples/workspace/tests/harness/corpus.mjs` | A Go adapter (`go test -json`); the adapter now names its own configs, scope and test-name form. |
| `conformance/run-manifest.yaml` | go removed from `pendingIn` of `capture-isolation` and of the two `generate` entries. |

## Differences from D7 and D8 as written

* `RunContext` is in `session.go`; there is no separate `context.go`.
* The scope builders were not moved (T4.1).
* `suitetest.Open` takes `(t, suite, schemaRoot, guarded)`, not `(t, file)`.
  The generator passes the schema root and the guard it worked out, so the test
  does not have to read the config again.
* It returns `*suitetest.Suite`, not `*Session`, because `exec.Session` is
  already the runtime's name.

## Step by step

| Step | Evidence |
| --- | --- |
| T4.1 Move scope builders out of `internal/suite` | **Not needed.** The session lives in `suite/exec`, in the same module as `internal/suite`, so it can use the builders where they are. Nothing moved. |
| T4.2 `RunContext` and environment options | `session_test.go`: `TestRunContextFromReadsOptionsTagsAndSwitchesUnderThePrefix` (options by flag name, tags, dry run, guarded opt-in, params) and `TestWriteTraceWritesWhereTheRunContextSays`. |
| T4.3 Session operations | `session_test.go`, one test per rule of `spec/session.md`: lazy and idempotent setup; a failed initialize hook reported by the case; out-of-order calls refused; teardown once and only after setup; the guarded skip's message and `guard` reason; a dry run traces nothing. |
| T4.4 Deep copy, trace mutex, atomic counter | `TestRule5ACaseThatChangesACapturedMapInPlaceChangesItForItselfOnly` mutates a nested map in one case and checks the next case does not see it. Shown to fail with the old one-level copy restored, then passed again. `TestTheTraceTakesEntriesFromManyGoroutines` and `TestRule7OneCaseOfASessionRunsAtATime` under `go test -race`; `TestAModelMapDeepCloneSharesNothing`. |
| T4.5 `RunFile` rebuilt; E1, E2 | E1: `internal/conformance/session_test.go`, both orders. E2: below. `capture-isolation` passes for Go; go removed from its `pendingIn`. |
| T4.6 Plan, `--plan`, E3 | E3: `internal/conformance/generate_test.go` runs the manifest's two `generate` entries; the Go plan equals `plan.expected.json`. go removed from their `pendingIn`. |
| T4.7 `suitetest` | Exercised by every `go test` run of the sample module (corpus harness, scenarios). |
| T4.8 Template, `gofmt`, `--check`, golden files | `generate_test.go`: golden files; identifiers; the writer rewrites only what changed and removes only its own files; `--check` reports a hand edit and a leftover file. E12 below. |
| T4.9 Sample module; E5 | `go generate ./...` and `go vet ./...` in the module; the corpus harness and `scenarios.mjs E5`. |
| T4.10 E9–E12 | `scenarios.mjs E9 E10 E11 E12`. |

## Scenarios

| Scenario | What ran | Result |
| --- | --- | --- |
| E1 | `go test ./internal/conformance -run E1` (`TestE1EveryExecuteEntryThroughTheSessionInFileOrderAndReversed`): every execute entry through the session in file order and reversed | pass |
| E2 | Go unit tests and full corpus (`go vet ./...`, `go test -race ./...`); `pwsh -File conformance/Assert-DivergenceIsCaught.ps1` (Go); `npm run test:integration` | pass; see the note on expectations below |
| E3 | `go test ./internal/conformance -run E3` (`TestE3EveryGenerateEntryOfTheManifest`) | pass |
| E5 | `node samples/workspace/tests/harness/corpus.mjs --provider go`: 14 corpus entries and 9 sample suites through `go test -json`, each subtest's status and the trace compared with the corpus's. `scenarios.mjs E5`: `-run '^TestSuite_Hooks$/^first$'` runs one subtest with one suite-setup and one suite-teardown entry and no entry for the other case; a single row (`rejects_a_bad_quantity_[qty=0]`) runs with setup and teardown markers once each; `BDD_SUITE_TAGS=wanted` skips the other case with "tag filter"; `teardown-fails` passes its case and fails only `TestSuite_TeardownFails`, naming the teardown | pass |
| E9 | `go test -list .` in both packages lists exactly one `TestSuite_<id>` per planned suite; a `-json` run has exactly one subtest per planned case and row (spaces become `_`, as Go does) | pass |
| E10 | Without the opt-in, the three `order-placement` cases skip with `BDD_SUITE_ALLOW_GUARDED=1` in the message and its setup and teardown never run, while `shipping` runs; with it, all three pass. `BDD_SUITE_OPTION_STORE=outlet-7` set; neither the value nor any `BDD_SUITE_OPTION` name is in any generated file | pass |
| E11 | The three overlap suites under `go test -parallel 8`, ten times: every case's markers are `before`, its own `start`, `end`, `after`, unbroken, 12 per suite per run | pass (see below: Go runs them sequentially) |
| E12 | A case added to `order-placement.yml`: `--check` exits 1; `go generate ./...`; `--check` exits 0 and the case runs as a subtest; renamed: the new name runs, the old is gone; an unknown action: `go generate` fails with `order-placement.yml:<line>:<col> … E104`. The suite and the `shop` package are byte for byte as before afterwards | pass |

### E2: what changed in existing tests

No corpus expectation changed. Two Go unit tests changed:
`suite/run/run_test.go`'s list of the corpus extension's actions gained
`fixture.append` (the action T0 added to the catalog), and `exec_test.go` uses
`DeepClone` where it called the removed `cloneScope`.

### E11 for Go: sequential by design

The generated tests never call `t.Parallel`, so `go test -parallel 8` has no
parallel tests to schedule: suites and their cases run one after another, as
`suiterun` runs them. E11's clause that cases of one suite never overlap holds,
and the check above is the guard against a template change that would add
`t.Parallel` to the subtests. Its clause that different suites *may* overlap is
not exercised. E11's Given in the design lists no Go setting; this records
that Go's is the default.

## Runs

| Run | Result |
| --- | --- |
| `go vet ./...`, `go test -race ./...` in `runtimes/go`; `gofmt -l` | all pass; nothing to format |
| `go generate ./...`, `go vet ./...` in `samples/workspace/tests/go` | 9 suites in `shop`, 14 in `corpus`; vet clean |
| `node samples/workspace/tests/harness/corpus.mjs --provider go` | 14 corpus entries and 9 sample suites checked; 0 differ |
| `node samples/workspace/tests/go/scenarios.mjs` | 5 of 5 pass (E12 re-run alone after its final check was changed from `git status`, which cannot see untracked files, to a byte comparison: pass) |
| `pwsh -File conformance/Assert-DivergenceIsCaught.ps1` | PASS: a divergent Go binding fails the conformance job (TypeScript not re-run: it did not change) |
| After the shared suites moved: the corpus harness and `csharp/scenarios.mjs` (E4, E9–E12) for MSTest, NUnit and xUnit | each harness: 14 corpus entries and 9 sample suites, 0 differ; each provider: 5 of 5 scenarios pass |
| `npm run test:integration` | exit 0: node:test 14 of 14 pass; extension host 28, 1, 61 and 5 passing, 0 failing; the sample files it edits put back |

## Open

* E10's "options missing" clause, as in T2 and T3 (the extension API has no
  required options).
* Whether Go should run different suites in parallel (`t.Parallel` on
  `TestSuite_<id>`). The session would allow it; it is not done, and the
  design does not ask for it.
* CI has not run any of this.
