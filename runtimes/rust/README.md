# The Rust runtime

The crate `suiterun`: the suite model, lint, the run (`exec`, `session`),
reports and the `suiterun` command line, extensible by an outside crate
(`extension::Extension`). It is held to the conformance corpus in
`../../conformance/` like every runtime.

## Install

```toml
[dependencies]
suiterun = { git = "https://github.com/smartpcr/bdd-code-extension", tag = "v0.7.3", features = ["testing"] }   # "testing" only for suites as cargo test tests

[build-dependencies]
suiterun = { git = "https://github.com/smartpcr/bdd-code-extension", tag = "v0.7.3", features = ["testing"] }   # build.rs generates the suite list
```

The crate is not on crates.io yet: Cargo finds `suiterun` inside the repository
at the release tag, and each GitHub release carries `suiterun-<version>.crate`
too. Once it is on crates.io, `version = "0.7.3"` replaces `git` and `tag`.

The crate carries the release's version, the VS Code extension's, so every
runtime of one release agrees. A workspace adds its own actions in a type that
implements `suiterun::Extension` and builds its own `suiterun` from it:

```rust
// src/main.rs
let extensions: Vec<Arc<dyn suiterun::Extension>> = vec![Arc::new(MyExtension)];
std::process::exit(suiterun::main_with(std::env::args().skip(1).collect(), &mut std::io::stdout(), &mut std::io::stderr(), &extensions));
```

Its catalog imports the core this crate carries by name, with no copy of the
spec (`imports: [ "bdd-suite:core" ]`); the core's actions are cut to the
catalog's own `bindings` list. Besides `lint`, `run`, `list` and `actions`,
`run` and `list` take `--name glob[,glob]` (cases whose names match, with the
tag filter) and `run` takes `--progress` (live `StartGroup`/`EndGroup`/`Summary`
lines for long runs; spec/progress.md). An action that panics fails its step;
the run goes on, as long as the binary keeps Rust's default unwinding panics
(`panic = "abort"` ends the process). A library caller gets the same through
`exec::Options::names` and an `exec::Observer`.

A working consumer that uses only the crate, with its own extension,
`suiterun` and harness:
[samples/consumers/rust](https://github.com/smartpcr/bdd-code-extension/tree/main/samples/consumers/rust).

## Run suites with your test framework

With the `testing` feature, a test crate runs its suites under `cargo test`:
one trial per case and examples row, named `<SuiteId>::<case name>`, and one
`<SuiteId>::teardown` trial per suite (docs/test-providers, D10 and DEC-T11).

**1. A config**, `bddsuite.tests.yaml`, beside the crate's `Cargo.toml` or in
a folder of it (spec/test-plan.md):

```yaml
suites: [ "../suites/*.yml" ]
schemaRoot: ../schema
provider: rust
contextKeys: [ store ]                         # what the extensions add, for linting before they load
offlineActions: [ "core.*", "wait", "shop.*" ] # a suite using anything else is guarded
```

**2. The crate:**

```toml
[dev-dependencies]
suiterun = { path = "...", features = ["testing"] }
[build-dependencies]
suiterun = { path = "...", features = ["testing"] }

[[test]]
name = "suites"
harness = false
```

```rust
// build.rs: generates at every build into $OUT_DIR; a suite that does not
// lint clean stops the build with its findings.
fn main() { suiterun::testing::build("bddsuite.tests.yaml", "suites.rs"); }

// tests/suites.rs
fn main() -> std::process::ExitCode {
    suiterun::testing::main(vec![std::sync::Arc::new(my_actions::Shop)], include!(concat!(env!("OUT_DIR"), "/suites.rs")))
}
```

Nothing generated is committed: Cargo runs `build.rs` again when the config, a
suite folder or the schema changes, so the tests cannot go stale.
`suiterun generate --config bddsuite.tests.yaml --plan` prints the test plan.

**3. Run:**

```text
cargo test --test suites                                     # every suite
cargo test --test suites -- --exact 'Orders::places an order' # one case: setup and teardown run once around it
cargo test --test suites -- --list                           # every trial
cargo test --test suites -- --format json                    # works on stable for this target
```

The run context comes from the environment, under the extensions' prefix
(`BDD_SUITE_` by default): `BDD_SUITE_TAGS` (cases it does not select are
ignored with "tag filter"), `BDD_SUITE_OPTION_<FLAG>`, `BDD_SUITE_PARAM_<NAME>`,
`BDD_SUITE_DRY_RUN=1`, `BDD_SUITE_TRACE_FILE` and `BDD_SUITE_RECORD_PATH`.

**Guarded suites** are ignored with "guarded suite: set
BDD_SUITE_ALLOW_GUARDED=1 to run it" unless that variable is `1`. **A failed
suite teardown** fails the `<SuiteId>::teardown` trial; when that trial is
filtered out, the last case that ran does the teardown, prints the failure and
the harness exits 101. A suite's cases run in order and never overlap, while
different suites run on parallel threads. The harness pins `libtest-mimic` at
`=0.8.2`: it relies on that version handing trials to its threads in order.

A working crate: `../../samples/workspace/tests/rust`. The contract the
harness drives is `../../spec/session.md`.
