# Stage K3 evidence: Rust

Plan: [docs/packages/implementation.md](../packages/implementation.md#stage-k3-rust-p1).
Recorded 2026-10-20 on Windows 11, the installed stable Rust toolchain, on top
of `3998301` with K0 to K3 uncommitted. **Status: built; locally accepted (E1
and E4 for Rust, E7 and E8 for Rust); CI not run** (nothing pushed; nothing
published).

## What was built

| Where | What |
| --- | --- |
| `src/cli.rs`, `src/extension.rs` | **D4.** `--name glob[,glob]` (repeatable, appended) and `--progress` in `cli::Options` (`names`, `progress`), the usage and the module comment; both among the core flags an extension may not take. |
| `src/suite.rs`, `src/session.rs`, `src/run.rs` | `suite::name_matches` (the `--path` glob over the whole name); a session selects by tags and names; `list` applies both. |
| `src/exec.rs`, `src/trace.rs`, `src/session.rs`, `src/progress.rs` (new) | `exec::Observer` (`case_started`, `case_finished`, `entry`), held in `exec::Options` as `SharedObserver` (an `Arc` with a hand-written `Debug`, so the options keep their derives), and `exec::Options::names`. Each session operation traces into its own `Trace`, which no lock guards; `RunContext::operation_trace` gives it the observer's entry hook (`Trace::observed`), so step lines are live, not batched per operation. `run_session` reports only selected cases, never in a dry run. `ProgressPrinter` writes the spec's lines to standard output, or to a writer `progress::set_writer` sets. |
| `src/exec.rs` | The action thread catches an unwinding panic (`catch_unwind`) and reports it as that step's failure ("<action> panicked: <message>"). Under `panic = "abort"` nothing can; the README says so. |
| `src/schema.rs`, `src/core.catalog.yaml` (new) | `bdd-suite:core` with the cut; `schema::core_catalog_text`. A crate holds only its own folder, so it carries a **copy** of the spec's core, checked equal by a test. |
| `tests/common/mod.rs`, `samples/workspace/tests/rust/src/lib.rs` | `fixture.throw`: a panic. `common::Captured`, a writer tests read progress lines back from. |
| `tests/conformance*.rs` | Entries' `names`, `schemaRoot` (library and program validate paths, execute, session) and `progress` honoured; the progress lines compared after masking; counts 42 validate and 20 execute, none pending; the placeholder that kept `lists` pending replaced by a real `lists` test. |
| `tests/packages.rs` (new) | The unit tests C# and Go have for the same features (12, including that the crate's `LICENSE` is the repository's). Tests that set the progress writer take one lock between them. |
| `conformance/run-manifest.yaml` | `rust` removed from `pendingIn` of the K0 entries and the `lists`. |
| `Cargo.toml`, `LICENSE` (new) | **K3.6.** `publish = false` removed; `license = "MIT"`, `repository`, `homepage`, `readme`, five `keywords`, `categories`; `include` = `src/**`, `Cargo.toml`, `README.md`, `LICENSE`; `[package.metadata.docs.rs] features = ["testing"]`; a `LICENSE` copy. `cargo package` warns that the tests and the example are not in the package: that is the intent (they read the corpus outside this folder), and switching auto-discovery off would hide them from `cargo test` here. `rust-version` is left out until a minimum toolchain is actually tested. |
| `README.md` | "Install": the two dependency lines, the one-call `suiterun`, `bdd-suite:core`, the new flags, the panic strategy, the library form, the consumer sample by its GitHub URL (crates.io shows this page). |
| `scripts/Test-PackageContents.ps1`, `packaging/suiterun.files.txt` | Rewritten around one table of kinds (NuGet, Go module zip, Rust crate), reading a `.crate` with .NET's own tar and gzip readers (PowerShell found Git's GNU tar first, which reads `E:` as a remote host). A crate: the `<name>-<version>/` prefix, the 34 listed files, and `Cargo.toml` naming the crate, the version, MIT, the repository, the README, a description. |
| `scripts/local-feeds.ps1` | `-Language rust`: `cargo package --allow-dirty` (which also builds the crate from its packaged files), the `.crate` into `artifacts/feeds/cargo`, checked, and unpacked beside it. |
| `samples/consumers/rust/` (new) | **K3.8.** The greeter in Rust: `suiterun = { version = "0.6.10", features = ["testing"] }` as a dependency and a build-dependency, its extension, its `suiterun` binary, `build.rs`, the harness, a catalog importing `bdd-suite:core`, the two suites, `run-e4.ps1`, a README. |
| `src/tools/versions.ts`, `test/unit/versions.test.ts` | A `cargo-dependency` kind: `set-version` moves the Rust consumer's two pins too (13 files). |
| `.gitignore` | The consumers' `target/` and `Cargo.lock`. |
| `.github/workflows/ci.yml` | `providers-rust` runs `run-e4.ps1` (E1 and E4) and `cargo publish --dry-run`. |
| `docs/packages/design.md`, `implementation.md` | E4 builds through `[patch.crates-io]` on the unpacked crate, not a directory registry (which would have to vendor every dependency); D9 without `rust-version`; K3.7's wording. |

## Step by step

| Step | Status | Evidence |
| --- | --- | --- |
| K3.1 `--name`, `--progress`; `names` and the `Observer` trait | done | Unit tests; corpus. |
| K3.2 The progress printer | done | Unit test; corpus `progress.yml` against the transcript. |
| K3.3 `catch_unwind`; panic strategy documented | done | Unit test; corpus `worker-throws.yml` through `suiterun`, the session and the harness; README. |
| K3.4 Embedded core; `bdd-suite:core` | done | Unit tests; corpus `core-import`. |
| K3.5 Tests; `cargo test --features testing`; the corpus | done | Runs below. |
| K3.6 Metadata, `include`, docs.rs; `publish = false` removed | done | `cargo package --list`: 34 files. |
| K3.7 Local feed; E1 (Rust); `cargo publish --dry-run` | done | Below. |
| K3.8 `samples/consumers/rust`; E4 | done | 10 checks. |

## Runs

| Run | Result |
| --- | --- |
| By hand, the built `suiterun`: `list --name` on `names.yml`, `run --name --progress` on `progress.yml`, `lint --binding-check --binding go` against `schema-core-import` | the three cases; the transcript's lines (after masking); E201 at 6:17 and 8:17 |
| `cargo test --features testing` | every test binary passed: lib 150, conformance 7, asserts 1, execute 1 (20 entries), expressions 1, generate 1, report 3, session 1 (20 entries), validate 2 (42 entries, library and program), example 6, packages 12, session 18, doctests 1 |
| `cargo build` (no features) | clean |
| `cargo package --allow-dirty` | packaged 34 files (120 KiB compressed); verified by compiling the packaged crate |
| `cargo publish --dry-run --allow-dirty` | packaged, verified, "aborting upload due to dry run" |
| `Test-PackageContents.ps1` on the crate, and again on the two NuGet packages and the Go zip after the rewrite | `suiterun-0.6.10.crate: 34 files as listed, version 0.6.10, MIT, README, LICENSE, repository`; the others as before |
| `npm run test:unit`; `check-versions` | 251 passed, 100% coverage; 13 files at 0.6.10 |
| `samples/consumers/rust/run-e4.ps1` (packing first) | **E4 passed**, 10 checks: `suiterun = { version = "0.6.10" ...` twice, no path; `cargo build`; `cargo metadata` shows suiterun 0.6.10 from `artifacts/feeds/cargo/suiterun-0.6.10`; `lint` clean through `bdd-suite:core`; `list --name '*hello'`; `run --name --progress`; `cargo test`: `Greeting::says-hello` and `Greeting::the-core-still-works` ok, `Loud::shouts-hello` ignored; all ok with `BDD_SUITE_ALLOW_GUARDED=1`; `--exact` selects one |
| `harness/corpus.mjs --provider rust` | 16 corpus entries and 9 sample suites, 0 differ (`worker-throws`, `core-import` through the harness; the name and progress entries command line only) |
| `samples/workspace/tests/rust/scenarios.mjs` | 5 of 5 |

## Open

* **CI**, including the new E1/E4 step and the publish dry run in
  `providers-rust` (Linux: the consumer's program path has no `.exe`, which
  the script does not add; untried until CI runs).
* **First publish**: crates.io accepts a trusted publisher only for a crate
  that exists, so the first `cargo publish` uses a token (plan section 6).
* TypeScript and PowerShell stay pending on the K0 entries until K4 and K5.
