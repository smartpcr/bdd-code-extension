# Stage T5 evidence: Rust

Plan: [docs/test-providers/implementation.md](../test-providers/implementation.md#stage-t5-rust-p1).
Recorded 2026-10-19 on Windows 11 with Rust 1.96.0 (cargo 1.96.0), libtest-mimic
0.8.2 (pinned `=0.8.2`, the version the T0 spike tested), Node.js 24.16.0 for
the scripts. Nothing here has run in CI.

## What was built

| Where | What |
| --- | --- |
| `runtimes/rust/src/session.rs` | **New**, re-exported from `exec`. `RunContext`: the options, the started extensions, the trace behind a mutex, whether guarded suites may run, and the trace file. `for_run` builds one for `suiterun run`; `from_lookup` and `from_environment` read `<prefix>OPTION_<FLAG>`, `TAGS`, `DRY_RUN`, `ALLOW_GUARDED`, `TRACE_FILE` and `RECORD_PATH`; `write_trace` writes it. `Session` has `open`, `open_linted` (lints first and refuses with the findings), `cases`, `index_of`, `is_selected`, `setup` (lazy, once), `before_each`, `run_case`, `after_each` and `teardown` (once, only after a setup). `before_each` returns a `CaseGuard` holding the session's case lock; `after_each` consumes it. Dropping the guard without `after_each`, for example in a panic, still runs afterEach and writes the case entry. Each operation traces into its own list and adds it to the shared trace when done, so parallel sessions never interleave inside an operation. |
| `runtimes/rust/src/exec.rs` | `run_file` keeps its signature and is now the session's operations in order, through `run_session`. The case body (case setup, steps, asserts) is `run_case_body`. `CaseResult` gained `reason` and `after_each_failed`. The hook and step runners are crate-visible for the session. |
| `runtimes/rust/src/cli.rs`, `run.rs` | `impl Default for cli::Options`, a plain `run`. The verb `generate` takes `--config` (repeatable), `--plan`, `--check`, `--provider` and `--out`; no other verb takes those flags, and `generate` takes no others. `generate --plan` prints the plan; a suite that does not lint clean refuses with its findings and exit 2. Without `--plan` it refuses and points to `build.rs` (below). |
| `runtimes/rust/src/generate.rs` | **New.** The shared test plan, as in Go: config loading with the schema's checks, globs, identifiers, the offline-action guard over expanded steps (imported meta steps and `wait`'s `forStep` included), and plan JSON. `render` writes the `&[suiterun::testing::Suite { ... }]` a harness includes, with suite paths as `concat!(env!("CARGO_MANIFEST_DIR"), "/...")` so the text does not depend on where the repository is checked out. `watched` lists the folders whose change can change it. Golden file: `testdata/golden/suites.rs.golden`. |
| `runtimes/rust/src/testing.rs`, `Cargo.toml` | **New**, behind the feature `testing` with `libtest-mimic = "=0.8.2"` as an optional dependency. `generate`, `generate_in`, and `build(config, output)` for `build.rs`: it writes `$OUT_DIR/<output>` only when changed, prints `cargo:rerun-if-changed` for the config, each include's starting folder and the schema root, and stops the build with the findings when a suite does not lint. `main(extensions, suites)` is the harness (DEC-T11): one trial per case and row, named `<suite id>::<case name>`, plus a `<suite id>::teardown` trial. It predicts which trials run with `Arguments::is_filtered_out` and `is_ignored`, and gives each suite a turnstile (a turn number, mutex and condition variable, and a guard that advances the turn even on panic). Suites are interleaved round-robin. Setup runs in a suite's first case; teardown runs in its trial, or in the last case when that trial is filtered out, which then prints the failure and exits 101. The run context is built at the first trial that runs, so `--list` starts no extension. Skipped cases are ignored trials with the reason. |
| `runtimes/rust/src/actions.rs` | `core.record` writes each marker line in one write, under a process-wide lock. **A bug E11 found**: `writeln!` wrote the marker and its newline separately, so suites on parallel threads merged lines (`one:endoverlap-c:one:end`). C# got the same lock in T2. |
| `runtimes/rust/tests/{session,conformance_session,conformance_generate}.rs` | **New.** One test per session rule, plus the run context, `write_trace`, `open_linted` and `run_file`'s teardown entry; E1 (both case orders, results equal to `run_file`'s); E3 (the manifest's `generate` list, honouring `pendingIn`). |
| `samples/workspace/test/e2e/bindings/rust` | A `[lib]` target (`shop_suiterun`, `src/lib.rs`) holding its actions and extension, so the test crate can use the `Shop` extension; `src/main.rs` uses it, and `suiterun` behaves as before. |
| `samples/workspace/tests/rust/` | **New** crate `shop-suite-tests`. `build.rs` generates `shop.rs` (the sample workspace's suites and the shared local ones) and `corpus.rs` (the conformance corpus). The two `harness = false` targets `shop` and `corpus` pass them to `suiterun::testing::main` with the `Shop` extension and `CorpusExtension` (`src/lib.rs`). Nothing generated is committed. `scenarios.mjs` runs E6 and E9–E12. |
| `samples/workspace/tests/harness/corpus.mjs` | A Rust adapter. It runs one suite with the filter `<id>::`, plus `--skip` for every other suite id that filter would also match, reads `--format json`, and reads stderr for a teardown run by the last case. The check "a teardown failure is reported that did not happen" now counts only a *failed* teardown row, because Rust lists a teardown trial for every suite. MSTest's teardown row only ever appears failed, and NUnit, xUnit and Go have none, so their results are unchanged (MSTest re-run below). |
| `conformance/run-manifest.yaml` | rust removed from `pendingIn` of the two `generate` entries. Rust already met `capture-isolation` in T0. |

## Differences from D9 and D10 as written

* **Trial names.** They use the suite's plan id (`Hooks::first`), not its declared name. Ids are unique in a plan; names are not (`billing`, `Billing`). The `-- --exact '<suite>::<name>'` form in DEC-T05 holds with `<suite>` as the id.
* **Name clash.** When a case is named `teardown`, the teardown trial is `teardown_2` (then `_3`, and so on).
* **`generate` signature.** `suiterun::testing::generate(config)` returns `Result<String, String>`, the refusal being the findings. `build(config, output)` is the one-line call `build.rs` makes.
* **The command line.** `suiterun generate` without `--plan` refuses: Rust writes the code in `build.rs` at every build (DEC-T10), so there is nothing to write or `--check` from the command line. The flags parse, so the command line is the same in every runtime.
* **Where the code lives.** The harness is `src/testing.rs` and the plan `src/generate.rs`, not a `src/testing/` folder. The plan is outside the feature because `suiterun generate --plan` needs it.
* **Linting at build and run time.** The generator lints with the config's `contextKeys`. At run time, the first trial of a suite lints again with the real extensions (`Session::open_linted`), and every trial of that suite fails with the findings if it does not lint.

## Step by step

| Step | Evidence |
| --- | --- |
| T5.1 `Options::default`; `RunContext`; environment options | `cli::tests::the_default_options_are_a_plain_run`; `session::the_run_context_reads_options_tags_and_switches_under_the_prefix`, `write_trace_writes_where_the_run_context_says`. |
| T5.2 Session with recorded failures and a case guard | `tests/session.rs`, one test per rule: 1 (a case run twice refused; beforeEach then afterEach settles as failed), 2 (once; nothing selected; beforeEach runs it), 3 (failed setup, failed beforeEach), 4 (failed afterEach; a guard dropped without afterEach still runs it), 5, 6 (once, only after setup; failure returned), 7 (three threads on one session never overlap and each case's entries stay one group; eight sessions in parallel lose no trace entry), 9, 10. 18 pass. |
| T5.3 `run_file` rebuilt; E1, E2 | E1: `conformance_session`. E2: below. Every expectation unchanged. |
| T5.4 Plan, `generate --plan`, E3 | `conformance_generate` runs both `generate` entries; rust removed from their `pendingIn`. `generate::tests`: identifiers, collisions, offline patterns, config refusals, relative paths, the guard through a library meta step and a polled step. |
| T5.5 Feature `testing`: `generate` for `build.rs` | The golden test; `testing::tests` (another provider refused, a suite that does not lint refused with `suites/b-broken.yml:8:17  E104`); the sample crate's `build.rs`. |
| T5.6 Harness: trials, teardown trial, predicted selection, teardown by the last case | E6 below. |
| T5.7 One suite at a time on each turnstile, suites in parallel | E11 below, with its negative check. |
| T5.8 Sample crate; E6 | `samples/workspace/tests/rust`; the corpus harness; `scenarios.mjs E6`. |
| T5.9 E9–E12 | `scenarios.mjs E9 E10 E11 E12`. |

## Scenarios

| Scenario | What ran | Result |
| --- | --- | --- |
| E1 | `cargo test --test conformance_session`: every execute entry through the session in file order and reversed | pass |
| E2 | `cargo test --features testing` in `runtimes/rust` (also built without the feature); `npm run test:integration` | pass, see Runs. The divergence check was not re-run: it patches only Go and TypeScript, and neither changed in T5. |
| E3 | `cargo test --test conformance_generate` | pass |
| E6 | `node samples/workspace/tests/harness/corpus.mjs --provider rust`: 14 corpus entries and 9 sample suites, one suite per `cargo test` run with `--format json`. Each trial's outcome and the trace are compared with the corpus, and the teardown failure is checked as reported. `scenarios.mjs E6`: `--list` gives one trial per planned case and row plus one teardown trial per suite. `--exact Hooks::first` runs one trial, with one suite-setup and one suite-teardown entry after it and nothing for `second`. `--exact TeardownFails::a-case-that-passes` passes its case, prints `TeardownFails::teardown failed ...` and exits 101. With the suite's teardown trial selected, that trial fails and the case passes. `BDD_SUITE_TAGS=wanted` ignores `the-unselected-one` with `tag filter`. `--format json` works on stable. `--test-threads 8` runs all 51 shop trials. | pass |
| E9 | `--list` of both targets gives exactly `<id>::<case name>` for every planned case and row (e.g. `OrderPlacement::rejects a bad quantity [qty=-1]`), plus one teardown trial per suite | pass |
| E10 | **Without the opt-in:** the three `OrderPlacement` cases are ignored with `guarded suite: set BDD_SUITE_ALLOW_GUARDED=1 to run it`, and neither the setup nor the teardown marker is written. `Shipping` passes. **With it:** every trial runs and the markers are written once each. The rows pass. `places an order` fails with `Unknown action: order.place`, because the sample catalog says that action is "implemented by every binding but rust"; the binding's own `suiterun` fails it the same way, and the corpus harness checks they agree. **Generated code:** `BDD_SUITE_OPTION_STORE=outlet-7` was set, and neither the value nor any `BDD_SUITE_OPTION` name is in the generated `shop.rs` or `corpus.rs`. | pass |
| E11 | The three overlap suites with `--test-threads 8`, ten times. In each suite, every case's markers are `before`, its own `start`, `end`, then `after`, 12 per suite per run. Different suites really ran at once: 88 cases overlapped a case of another suite. **Negative check:** with both the turnstile and the session's case lock taken out, every round failed with one suite's cases interleaved (`before before before one:start three:start two:start ...`); with only the turnstile taken out, the case lock alone kept them apart and it passed. Both restored. | pass |
| E12 | A case added to `order-placement.yml` is a trial after `cargo test --no-run`. Renamed, the new name replaces the old; removed, it is gone. With `action: order.plaec` the build stops with `order-placement.yml:<line>:<col>  E104`. No file of the crate changed, and the suite is restored byte for byte. | pass |

## Runs

| Run | Result |
| --- | --- |
| `cargo test --features testing` in `runtimes/rust` | all pass: lib 150; conformance 6, asserts 1, execute 1 (14 entries), expressions 1, generate 1, report 3, session 1, validate 2, example 6, session rules 18; doc 1 |
| `cargo test --no-run` without the feature; `cargo clippy --features testing --all-targets` | builds; no clippy finding in T5's code (the warnings left are in `report.rs`, `suite.rs`, `schema.rs` and older `exec.rs` tests) |
| `cargo test` in `samples/workspace/tests/rust` (`--no-run`, `--list`) | builds; 51 shop trials and 42 corpus trials |
| `node samples/workspace/tests/harness/corpus.mjs --provider rust` | 14 corpus entries and 9 sample suites checked; 0 differ |
| `node samples/workspace/tests/rust/scenarios.mjs` | 5 of 5 pass (after the `core.record` fix and the E10 expectation for `order.place`) |
| `node samples/workspace/tests/harness/corpus.mjs --provider mstest` (the harness's teardown-row check changed) | 14 corpus entries and 9 sample suites checked; 0 differ |
| `npm run test:integration` (the Rust runtime and binding changed) | node:test 14 of 14; extension host 27 passing and **1 failing**, then 1, 61 and 5 passing. The failure was E-B7's "Copy binding table puts the Markdown table on the clipboard": the command returned the right table (Rust `7 / 7 / 0`), but the system clipboard read back empty within 20 s. That file re-run alone (`BDD_SESSIONS=sample BDD_FILES=coverage.test.js`) passed 5 of 5, the clipboard test in 41 ms, along with B4.3-1, each binding program's `actions --json` against the catalog. Read as clipboard contention on the desktop the run shares, not a defect; it passed in T4's full run. |

## Open

* E10's "options missing" clause, as in T2 to T4: the extension API has no required options.
* `smoke.yml` fails in every Rust run, `cargo test` and `suiterun` alike, because no Rust action implements `shop.state`. The corpus harness checks they agree.
* E6's cleanup (`cargo clean -p`) was not run. The crate's `target/` is ignored by its own `.gitignore`.
* CI has not run any of this.
