# Changelog

## 0.7.3

* **Release pipeline:** `verify-registries` (E11): after a release to the
  public registries, each consumer sample runs on a fresh runner with no
  local feed and no `runtimes/`, from its registry alone (`-FromRegistry`),
  once `scripts/publish/Wait-Published.ps1` finds the version served;
  `scripts/publish/Test-ReleaseSetup.ps1` says which part of the operator
  setup is missing (docs/packages, stage K8).
* **Release pipeline:** `PUBLIC_REGISTRIES` takes a list as well as `true`
  (`nuget,npm,crates`), so a registry whose setup is not done waits without
  blocking the others; the release notes link the registries published to.
  npm's and crates.io's first publish use the `release` environment's
  `NPM_TOKEN` and `CRATES_IO_TOKEN` until their trusted publishers are set.

## 0.7.2

* **VS Code extension:** lints with the TypeScript runtime it carries when the
  workspace has no TypeScript binding library, so a C#-only (or any) workspace
  gets live lint with default settings; the status bar says *lint bundled
  runtime* (docs/packages, stage K6).
* **VS Code extension:** `imports: [ bdd-suite:core ]` resolves to the core
  the extension carries, each core action's bindings cut to the catalog's own;
  the default `bddSuite.schemaGenerator` is the `Build-Schema.ps1` it carries
  (`${extension}` and `${catalogPath}` in the setting), and *Suite: Regenerate
  the schema* runs it; a warning when the workspace pins bdd-suite packages of
  another release.
* **Release pipeline:** every package is packed once (`scripts/pack-all.ps1`)
  and checked, and each language's consumer sample is built and run from
  those files alone (a `consumers` matrix, E2 to E6); publishing to nuget.org,
  npm, crates.io and the PowerShell Gallery (`scripts/publish`) runs as a
  dry run on every pull request and for real, in the `release` environment,
  once the repository variable `PUBLIC_REGISTRIES` is `true`; the release
  notes then link each registry page; actionlint checks the workflow
  (docs/packages, stage K7).
* **GitHub Packages:** a release also pushes the PowerShell module `BddSuite`
  to the NuGet feed (its nuspec given this repository's URL, so the package is
  linked to it) and the npm package as `@smartpcr/bdd-suite-runtime` (that
  registry takes only the owner's scope; `npm install
  @bdd-suite/runtime@npm:@smartpcr/bdd-suite-runtime@<version>` keeps the
  name), beside `Bdd.Suite` and `Bdd.Suite.Testing`
  (`scripts/publish/Publish-GitHubPackages.ps1`, dry-run on every pull
  request).
* **Docs:** "The runtime packages" in the README; moving a repository from a
  copy of a runtime to its package, update2 as the example
  (docs/packages/migrating.md).

## 0.7.1

* **PowerShell:** the `BddSuite` module as a package, attached to the GitHub
  release as `BddSuite.<version>.nupkg` (`Install-PSResource` from a folder
  repository), with `--name`/`-Name`, `--progress`/`-Progress` and its run
  observer, `bdd-suite:core`, `suiterun.ps1` and `Invoke-BddSuite.ps1` inside
  the module (forwarders at the old paths), and any error a step raises
  failing that step only (docs/packages, stage K5).

* **TypeScript:** `@bdd-suite/runtime` as a package, attached to the GitHub
  release as `bdd-suite-runtime-<version>.tgz` (`npm install <its URL>`), with
  `--name`, `--progress` and its run observer, `bdd-suite:core`, and a step
  that throws anything, an `Error` or not, failing without ending the run
  (docs/packages, stage K4).
* **TypeScript:** `npx suiterun` runs on Linux and macOS, where an installed
  package's bin is a symbolic link; it used to exit 0 having done nothing.
  The `node:test` JUnit reporter names each case after its own file's
  `describe` when files run at once.
* **PowerShell:** the Pester generator's `-Check` no longer calls a generated
  file stale for its line ends, which a Windows checkout with `core.autocrlf`
  changes.

## 0.7.0

### The runtimes as packages

The first release a project can take as packages rather than a copy
(docs/packages, stages K0 to K3):

* **C#:** `Bdd.Suite` and `Bdd.Suite.Testing` on this repository's GitHub
  Packages feed and as release assets. `Bdd.Suite.Testing` carries its test
  generator and its build targets, so a test project needs only the package
  reference, also under central package management.
* **Go:** the module at the tag `runtimes/go/v0.7.0`.
* **Rust:** the crate `suiterun`, as a git dependency on the tag `v0.7.0` and
  as a release asset.
* Every package carries the release's version (the VS Code extension's).

In C#, Go and Rust (TypeScript and PowerShell follow):

* **`--name glob[,glob]`** on `run` and `list` selects cases by name, with the
  tag filter; **`--progress`** prints live `StartGroup`/`EndGroup`/`Summary`
  lines while a run goes, and a library caller gets the same through a run
  observer (spec/progress.md).
* **An action that throws or panics with anything fails its step**; the run
  goes on to the cleanup, the next case and the teardown.
* **`imports: [ "bdd-suite:core" ]`** in a catalog reads the core the runtime
  carries, cut to the catalog's own `bindings`, with no copy of the spec; the
  spec's `Build-Schema.ps1` reads it too.

### Run suites with your test framework

Suites now run as ordinary tests of each language's test framework, with the
same results and trace as `suiterun run` (docs/test-providers):

* **C#:** MSTest 4, NUnit 4 and xUnit v3, through the `Bdd.Suite.Testing`
  package, which generates the tests at every build.
* **Go:** `go test`, from `go generate` (`*_bdd_test.go`, committed).
* **Rust:** `cargo test`, through a `harness = false` target and `build.rs`,
  with the crate's new `testing` feature.
* **TypeScript:** `node:test`, Vitest, Jest and Mocha (`*.bdd.test.ts`), and
  a `node:test` JUnit reporter that keeps a failed suite teardown.
* **PowerShell:** Pester 5 (`*.Bdd.Tests.ps1`).

The VS Code extension checks `bddsuite.tests.yaml` (and other `*.tests.yaml`)
as you type, marking a misspelled key (BDD070) and any other refusal of
`spec/tests.config.schema.json` (BDD071), and completes its keys and
providers. A suite run from the editor takes `offlineActions` from the
nearest config that selects the suite, else from `bddSuite.offlineActions`.

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
