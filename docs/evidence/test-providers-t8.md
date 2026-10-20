# Stage T8 evidence: CI and documentation

Plan: [docs/test-providers/implementation.md](../test-providers/implementation.md#stage-t8-ci-and-documentation-p1).
Recorded 2026-10-19 on Windows 11. **Status: built; CI not run.** The stage's
exit evidence is every job passing on a pushed branch, and nothing has been
pushed: that waits for the user. No Linux machine is available locally (no
WSL, no Docker), so the Linux jobs are untried until then.

## What was built

| Where | What |
| --- | --- |
| `.github/workflows/ci.yml` | **The runtime jobs (T8.1)** already ran each runtime's unit tests and whole corpus, which since T1 to T7 include E1 (the session), E2 (the whole-file run rebuilt on it) and E3 (the manifest's `generate` list). Changed: Go runs with `-race` (sessions share a trace and counters); Rust runs `cargo test --features testing` (the harness's own tests) and also builds without the feature; job names say they cover E1 to E3. **Five provider jobs (T8.2):** `providers-csharp` (Windows: MSTest, NUnit, xUnit), `providers-go` (Linux), `providers-rust` (Linux), `providers-typescript` (Linux: `node:test`, Vitest, Jest) and `providers-powershell` (Windows: Pester). Each checks the committed generated tests are current where they are committed (Go, TypeScript, PowerShell), runs the corpus harness (the corpus and the sample suites through each framework) and the language's scenarios (E4 to E12), and uploads `out/providers` (every framework report and trace the harness wrote) as `provider-reports-<language>`, also when a step failed. C# on Linux stays the runtime job. The release job now also waits for the five provider jobs. |
| `samples/workspace/tests/harness/corpus.mjs` | `--out <folder>` writes the reports and traces there and keeps them (the artifact). The Go and Rust adapters now also save their JSON reports (`go test -json`, `cargo test -- --format json`), which they read from stdout. |
| `runtimes/{csharp,go,rust,typescript}/README.md` | **New**, each with a "Run suites with your test framework" section: the config, how to generate, how to run, filter and list, the environment inputs, guarded suites, where a failed teardown shows, and the sample project. |
| `runtimes/powershell/README.md` | The same section, and the new files in its layout table. |
| `README.md` | "Running suites with your test framework": what it is, a table of the five languages and their frameworks, guarded suites, and links to each runtime's section; the design and plan are listed under "Design and plan". |
| `CHANGELOG.md` | **New.** The feature, the behaviour changes (DEC-T04's deep copy in C#, Go, TypeScript and PowerShell; PowerShell's dry run tracing nothing) and the fixes found on the way (PowerShell's E202, `core.record` in C# and Rust). |
| `.vscodeignore` | **A packaging defect found:** the `.vsix` held all of `spikes/` (8291 files locally, with the JavaScript spike's `node_modules`) since T0 added the folder. `spikes/**` is excluded now, and `CHANGELOG.md` too (it describes the runtimes, not the extension). The package is 13 files again. |

## Step by step

| Step | Status | Evidence |
| --- | --- | --- |
| T8.1 CI jobs for E1 to E3 per runtime | built; CI not run | The jobs' commands were all run locally in T1 to T7: `dotnet test` (C#, Windows only), `go test -race ./...`, `cargo test --features testing` and `cargo build`, `npm test` (TypeScript), `Invoke-Pester runtimes/powershell`. |
| T8.2 A CI job per provider, with report and trace artifacts | built; CI not run | Every harness and scenario command was run locally in T2 to T7 and passed (see each stage's evidence). New in T8 and run here: `--out` (Go and Rust, reports and traces kept), and the generated-tests-are-current checks: `go tool suiterun generate --check` in `shop` and `corpus` (exit 0), `npm run generate:check` (exit 0), `generate.ps1 -Check` (exit 0). |
| T8.3 READMEs | written; for the user's review | The five runtime READMEs and the repository README. |
| T8.4 CHANGELOG and release notes | written | `CHANGELOG.md`, with DEC-T04 listed under behaviour changes. |

## Runs

| Run | Result |
| --- | --- |
| The workflow parsed with the `yaml` package; every job has `runs-on`; every step has `uses` or `run` | 16 jobs; the release needs 15 |
| `npm run package` | B9.1-1 passes: 13 files under `extension/`, 193071 bytes (8291 files before `spikes/**` was excluded) |
| `npm run install:local` | installed 0.6.10 into VS Code; open windows load it on reload |
| `node samples/workspace/tests/harness/corpus.mjs --provider go --only Hooks --out <folder>`, and the same for `rust` | each: 1 corpus entry, 0 differ; the folder holds the trace and the JSON report |

## Open

* **CI.** T8 closes when every job passes on a pushed branch; push when the
  user asks. The Linux provider jobs (Go, Rust, TypeScript) and the C# runtime
  job on Linux have never run on Linux with these changes.
* The READMEs await the user's review (D15, "Done when").
