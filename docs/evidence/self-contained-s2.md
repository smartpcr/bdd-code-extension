# Stage S2 evidence: the Go and Rust runtimes

Plan: [docs/self-contained/implementation.md](../self-contained/implementation.md#stage-s2-go-and-rust-runtimes-p0).
Recorded 2026-10-15, on Windows 11 with Go 1.26.4 and Rust 1.96.0 (cargo
1.96.0). Built by two parallel agents, one per language, following the
TypeScript runtime of stage S1 as the reference. **Every result below was
rerun by hand after the agents reported**, from this repository. Nothing has
run in CI yet (S2.12).

## Source

Both were copied from the os-context worktree `E:\work\os\os-context-ts`
(branch `typescript-binding`) at commit
`7633e176fb70140e94ddc7e9d96b07eb39c39b22`: Go with `git archive 7633e176
test/e2e/bindings/go`; Rust from the tracked files, last changed by `b41907ab`.
Neither binding had uncommitted changes there. os-context was not modified.

Baseline before the move, run in the worktree:
* `go vet ./... && go test ./...` passed every package.
* `cargo test` passed: 167 unit tests, plus every corpus target and the 13 stream tests.

## Go: `runtimes/go` (S2.1-S2.6, D4)

* **Module:** `github.com/smartpcr/bdd-code-extension/runtimes/go`.
* **Public packages, under `suite/`:** `actions`, `cli`, `diag`, `exec`, `expr`,
  `extension`, `model`, `run`, `schema`, `suiterun`, `trace`, `value`, `walk`.
  * `diag` and `schema` are public beyond D4's list: a lint rule returns
    diagnostics, and `exec.RunFile` takes a schema.
* **Internal:** `assertion`, `conformance`, `paths`, `report`, `spelling`,
  `suite`, `validate`, `where`.
* **Removed:** `internal/lifecycle` (and its tests) and `internal/run/lifecycle.go`.
* **Entry points:**
  * `suiterun.Main(args, stdout, stderr, extensions...) int`;
  * `cmd/suiterun` calls it with none;
  * `extension.Compose` uses the TypeScript refusal messages.
* **Example:** `example/`, with the extension and its own `cmd/suiterun`.

| Check (from `runtimes/go`) | Result |
| --- | --- |
| `gofmt -l .` | nothing to format |
| `go vet ./...` | clean |
| `go test -count=1 ./...` | **every package ok** (21 with tests; `cmd/suiterun`, `example/cmd/suiterun`, `internal/where` have none) |
| Validate corpus | **41 of 41** |
| Execute corpus | **11 of 11** |
| Expression table | **276 of 276** rows |
| Assertion table | **96 of 96** rows |
| Reports | **7 of 7**, three runs each |
| Core catalog against registered actions | **6**: `core.fail`, `core.noop`, `core.record`, `core.set`, `core.sleep`, `wait` |
| E3 (`go test ./example`) | with the extension the run passes and lint is only `E205 5:17`; without it lint is only `E301 9:15`, `--region` is refused, the run fails, and a suite that skips `${region}` fails with "No extension of this runtime registers it"; two extensions with one action are refused; the example's program builds and imports public packages only |

## Rust: `runtimes/rust` (S2.7-S2.11, D5)

* **Crate:** `suiterun`, library and binary.
* **Removed:**
  * `src/lifecycle/*`;
  * `tests/stream_loopback.rs`;
  * `src/test_secrets.rs`, which only the lifecycle code used;
  * the `reqwest` and `getrandom` dependencies. `reqwest` is still built
    indirectly, by `jsonschema`'s default features.
* **The extension API, in `suiterun::extension`:**
  * `Extension` is a trait whose methods default to adding nothing.
  * `Action { name, handler }` holds a public `Handler`.
  * `Registry::compose` uses the TypeScript refusal messages.
  * The plan said "Action trait"; the trait ended up on the extension instead, a smaller change with the same reach.
* **Entry points:** `run::execute_with(&Options, &Registry)`;
  `main_with(args, stdout, stderr, &extensions) -> i32`.
* **Example:** `examples/echo.rs` and `tests/example.rs` compile
  `example/src/extension.rs` from outside the crate, so only the public API
  is reachable.

| Check (from `runtimes/rust`) | Result |
| --- | --- |
| `cargo build --all-targets` | 0 warnings |
| `cargo test`: lib | **137 passed, 0 failed** |
| `conformance` | 6 / 0 (core catalog against registered: exactly the 6 core actions) |
| `conformance_validate` | 2 / 0: **41 of 41** entries through the library, **39 of 39** through the program |
| `conformance_execute` | 1 / 0: **11 entries run, 0 differ** |
| `conformance_report` | 3 / 0: **7 of 7** stored reports |
| `conformance_expressions`, `conformance_asserts` | 1 / 0 each: every row |
| `example` (E3) | **6 / 0**: the same outcomes as Go and TypeScript, plus the example binary runs and passes |
| doc-tests | 1 / 0 |

## The os-context scan

A search for the following found nothing in either runtime outside two kinds of exception:
* the words: os-context, `HCI_`, `cluster.state`/`suspend`, `test/e2e/conformance`, lifecycle, `labId`/`apiUrl`, `--api-url`/`--lab-id`, `reqwest`/`getrandom`;
* the exceptions: (a) tests proving the old rule and flags are gone, and comments saying where they went; (b) the corpus's own context keys (`cluster`, `target`, `labId`, `apiUrl`) in each runtime's corpus test extension, as DEC-S02 records.

## Generated schemas

`pwsh -File spec/Build-Schema.ps1 -Catalog <catalog> -Check` is current for all five:
* the core;
* the corpus;
* the TypeScript, Go and Rust example workspaces.

## S2.12: CI (built, open)

`ci.yml` gained `runtime-go` (`go vet`, `go test`) and `runtime-rust`
(`cargo test`, cached). The `spec` job's staleness check now covers the Go and
Rust example schemas, and the release job waits for both runtimes. The file
parses. **Not run:** it runs on GitHub after a push.

## Notes for later stages

* `runtimes/rust/Cargo.lock` is untracked, as it was in os-context. Committing it gives reproducible builds.
* An empty `<prefix>RECORD_PATH` counts as unset in Rust. The other runtimes read an empty value as "no record file", so the behaviour is the same.
* The divergence check (`conformance/Assert-DivergenceIsCaught.ps1`) points at `runtimes/go` and `runtimes/typescript`; it runs in S4.
