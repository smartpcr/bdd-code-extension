## The Rust binding

`bindings/rust`: `src/actions.rs` (one registration per action and its
handler), `src/extension.rs` (`{{Namespace}}Extension`), `src/main.rs`
(suiterun), and `build.rs` with `tests/suites.rs` (the suites as `cargo test`
tests, listed at every build from `tests/bddsuite.tests.yaml`). The crate,
`suiterun` {{version}}, is a dependency in `bindings/rust/Cargo.toml`.

```powershell
cd bindings/rust
cargo build                                    # what Suite: Build lint tool runs; a lint finding fails it
cargo test --test suites                       # every case; guarded suites are ignored
cargo test --test suites -- --exact '{{Namespace}}::echoes-text'   # one case
cd ../..

$suiterun = 'bindings/rust/target/debug/suiterun.exe'
& $suiterun lint --path 'suites/*.yml' --schema-root schema --binding-check --binding rust --strict
& $suiterun run  --path 'suites/*.yml' --schema-root schema --progress --results out/results.xml --trace-file out/trace.json
```

Reports: `out/results.xml` (NUnit 3; `--format junit` for JUnit) and
`out/trace.json` (one entry per step). Under `cargo test`,
`BDD_SUITE_ALLOW_GUARDED=1` runs guarded suites and
`BDD_SUITE_TRACE_FILE=<path>` writes the trace.
