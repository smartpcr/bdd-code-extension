# Changelog

## Unreleased

### Run suites with your test framework

Suites now run as ordinary tests of each language's test framework, with the
same results and trace as `suiterun run` (docs/test-providers):

* **C#:** MSTest 4, NUnit 4 and xUnit v3, through the `Bdd.Suite.Testing`
  package, which generates the tests at every build.
* **Go:** `go test`, from `go generate` (`*_bdd_test.go`, committed).
* **Rust:** `cargo test`, through a `harness = false` target and `build.rs`,
  with the crate's new `testing` feature.
* **TypeScript:** `node:test`, Vitest and Jest (`*.bdd.test.ts`), and a
  `node:test` JUnit reporter that keeps a failed suite teardown.
* **PowerShell:** Pester 5 (`*.Bdd.Tests.ps1`).

Every runtime gains:

* The **suite session** (`spec/session.md`): setup, each case and teardown as
  separate operations a framework calls. `suiterun run` now runs every file
  through it.
* **`suiterun generate`**, with `--config`, `--plan`, `--check`, `--provider`
  and `--out`. The test plan is the same in every runtime
  (`spec/test-plan.md`, `conformance/generate/`).
* **Guarded suites.** A suite that uses an action the config does not list as
  offline skips unless `BDD_SUITE_ALLOW_GUARDED=1`.

### Behaviour changes

* **Each case starts from a deep copy of the suite setup's captures**
  (DEC-T04), in C#, Go, TypeScript and PowerShell; Rust already did. Before,
  the copy was one level deep: a case that changed a nested captured value in
  place changed it for the cases after it and for the teardown. A suite that
  relied on that leak depended on its cases' order; it now sees the setup's
  value in every case. `conformance/execute/capture-isolation.yml` pins the
  rule.
* **PowerShell: a dry run traces nothing.** `-DryRun` used to write a `case
  skipped` entry per case to the trace; it now writes none, as every other
  runtime (`spec/session.md`, rule 10). The report still lists each case as
  skipped.

### Fixes

* **PowerShell lint:** E202 (a case declared twice) compared case names
  ignoring case, so it refused `places an order` beside `PLACES AN ORDER`, which
  every other runtime accepts. Names now compare exactly.
* **C# and Rust:** `core.record` appends a whole line at a time, so suites
  running in parallel in one process no longer merge or lose markers.
