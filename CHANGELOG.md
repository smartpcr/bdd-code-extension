# Changelog

## 0.8.0 (unreleased)

* **Step events** (spec/events.md, C# runtime first). `suiterun run --events
  <file>` writes what the run does as it does it, one JSON object per line:
  run, suite and case boundaries, and each step's start and finish. A step is
  named by a stable **step id**
  (`steps/1/stage-update-payload/0#row2`) and the **file and line** it is
  written on, the library's for a step from an imported meta step, so a host
  can draw a run on the YAML itself. A finish carries the status and reason,
  the start time and duration, the message, a failing action's structured
  detail, the captured value and each assertion's operator, expected and
  actual. Texts are redacted like the report's; a value over 8192 characters
  is cut to a preview. The trace, `--progress` and the reports are unchanged.
  `spec/events.schema.json` is the shape of a line; `conformance/events/` holds
  the expected events, masked, for the `gherkin`, `meta` and
  `meta-from-library` suites and a cancel run, read by the C# runtime's tests
  only, so no other runtime's corpus changes.
* **In process**: an `IRunObserver` that also implements `IStepObserver` is
  told of each step; `ActionRequest.Ref` is the step being run,
  `ActionRequest.Note(text)` sends a `note` event, and
  `ActionException.WithDetail(value)` attaches evidence to a failure.
* **Cancel** (spec/events.md, "Cancel"; session rule 13).
  `--cancel-on-stdin-close` (opt-in) and `--cancel-file <path>` let a host stop
  a run: the running step's action is cancelled and the step fails with reason
  `cancelled`, the case's remaining steps do not run, its cleanup and
  afterEach and the suite's teardown still run and are never cancelled, no
  later case starts (each is `skipped` with reason `cancelled`), and the exit
  code is 1. `RunOptions.Cancel` is the same for a library caller.
* **The language core for browsers**: `@smartpcr/bdd-suite-language`
  (`packages/language`), an ESM bundle of `src/core` with no Node built-ins,
  for a web editor that reads and writes suites as the extension does: suite
  parsing with positions, catalog resolution through a read callback with the
  core catalog built in (`CORE_CATALOG_TEXT`, so `imports: [bdd-suite:core]`
  needs no file system), the workspace index, scope and shape queries,
  completion contexts and the required-parameter snippet, the expression
  cursor, hover text, the schema check and semantic tokens. `src/core` reads
  paths through a new `portablePath` (Node's `path.win32` or `path.posix` rules
  on a Node host, POSIX in a browser), so the extension behaves as before.
  `npm run build:language`, `npm run test:language`.

## 0.7.13

* **Ctrl+click reaches a handler declared in another file.** A C# registry
  written as update2's and the skeleton's are, `["a.b"] = Actions.AB,` with the
  method in `Actions.cs`, used to send Go to Definition to the registration
  line only: a handler was looked for in its registration's file alone. The
  index now also records what each binding source file declares, and finds a
  handler in the binding's other files, the one declaring the class a
  qualified handler names first. Find References and the "suite steps"
  CodeLens work on that method too.
* **Add parameter, a quick fix.** On a step key its action does not take
  (`E105`, or the schema's "Property ... is not allowed here"), the lightbulb
  now offers *Add parameter `<key>` to `<action>`* beside removing it: the key
  becomes an item of the action's `params:` in the workspace catalog, typed
  from the step's value (`string`, `integer`, ...; a `${...}` value gets a
  `# TODO type`), and the schema is regenerated so the finding clears. An
  action from an imported catalog, or whose params are a flow list, is not
  offered or is refused with the reason.
* **Suite: Create suites workspace skeleton...** A new command, in any window
  with or without a catalog: given a folder, the binding languages (any of C#,
  PowerShell, Go, Rust and TypeScript) and a name, it writes
  `.vscode/settings.json`, an action catalog with a first action, a first suite
  and each language's binding, pinned to the extension's release, then
  generates the schema. C#: extension, suiterun and MSTest projects on the
  `Smartpcr.BddSuite` packages. PowerShell: extension module, `suiterun.ps1`,
  Pester runner and `packages.psd1`/`restore.ps1` for the `BddSuite` module.
  Go: a module requiring the Go runtime, `cmd/suiterun` and `go test` tests
  from `go generate`. Rust: a crate on `suiterun`, a `suiterun` binary and
  `cargo test` tests listed by `build.rs`. TypeScript: a package on
  `@bdd-suite/runtime`, built with `tsc`, with a suiterun, the lint library and
  `node:test` tests. Each binding's registry is where *Declare action* adds the
  next action. Existing files are kept; a folder with a catalog is refused. The
  templates are `templates/skeleton/<part>/`, and
  `bddSuite.templatesDir/skeleton/<part>/` overrides them file by file.

## 0.7.12

* **TAEF skips, fixed.** 0.7.11 looked for the TAEF result enum as
  `WEX.Logging.Interop.TestResults`; it is `TestResult`, so the lookup failed and
  the case fell back to Inconclusive, which TAEF still counted as Failed. The
  generated code also loads `Wex.Logger.Interop.dll` from the host's folder
  (`te.processhost.exe`) when it is not loaded yet.
* **TAEF test names follow the case names** (DEC-T14). TAEF names a test by its
  method and ignores DisplayName, so under `output.host: taef` a case's method is
  its name's words, each capitalized, joined with an underscore: `cache-stats` is
  `Cache_Stats`, `get-cache [type=Update]` is `Get_Cache_Type_Update`. The other
  providers' identifiers are unchanged.

## 0.7.11

* **A skipped case is Skipped under TAEF** (DEC-T14). TAEF's CoreCLR host
  counts MSTest's `Assert.Inconclusive` as a failure, so the `taef` host's
  generated code logs TAEF's own Skipped result
  (`WEX.Logging.Interop.Log.Result`, found at run time) for a case that skips
  itself or is skipped by a guard. Outside TAEF the case stays Inconclusive.

## 0.7.10

* **Step lines live in a test process** (docs/test-providers/design.md
  DEC-T15, spec/session.md). `<prefix>PROGRESS=1` (`BDD_SUITE_PROGRESS=1`)
  makes the run context write each hook and step line to standard output as
  it is traced, in the shape `suiterun --progress` prints, so TAEF and other
  test hosts show what a long case is doing instead of nothing until it ends.
  No `StartGroup`/`EndGroup` lines: the test framework prints its own. C#
  runtime; off unless set.

## 0.7.9 (not published; its changes ship in 0.7.10)

* **MSTest code TAEF can host** (docs/test-providers/design.md DEC-T14).
  `output.host: taef` in `bddsuite.tests.yaml` (mstest only) generates
  classes that never take MSTest's `TestContext`, which TAEF's CoreCLR host
  refuses in any fixture and which blocked every test of the assembly. The
  run starts on the first test from the environment, each suite opens on its
  first test, and each test runs its own beforeEach and afterEach; a failed
  afterEach fails that test. Without the key the generated code is unchanged.
* **Suites are found beside the assembly under TAEF too** (DEC-T13, DEC-T14).
  TAEF's CoreCLR host leaves `AppContext.BaseDirectory` empty, and every
  suite failed to open with "The path is empty". The runtime now falls back
  to the folder of `Bdd.Suite.Testing`, which a test package deploys beside
  the test assembly (`RepositoryPaths.AssemblyDirectory`), and a host that
  gives no folder at all gets the generated paths back instead of a throw.

## 0.7.8

* **A case may skip itself** (spec/session.md rule 12, conformance
  `execute/case-skips.yml`). A new core action, `core.skip`, and a skip signal
  in every runtime's action API (C# `ActionException.Skipped`, TypeScript
  `skipped`, Go `actions.Skipped`, Rust `ActionError::skipped`, PowerShell
  `New-StepSkip`) end a case as `skipped` with reason `skip` and the action's
  message, for a case that finds its environment cannot run it. The rest of the
  case's setup, steps and asserts do not run; its cleanup and afterEach do, and
  either failing still fails it. A skip inside `wait` ends the case rather than
  being polled again; in any other hook it is that hook's failure. Guarded with
  `ifCapture`, a suite skips only when a capture says so. The test-framework
  providers show such a case as skipped (Jest, which cannot skip a running
  test, shows it passed; its trace says skipped).

## 0.7.7

* **A catalog outside `test/e2e/schema`.** A workspace may keep its catalog,
  suites and bindings in its own layout (update2:
  `src/.../EnvironmentTest/BVT/{schema,suites,bindings}`) and name the catalog
  in `bddSuite.catalogPath`. When no folder above the catalog holds
  `test/e2e/schema`, the root is the folder above the catalog's folder (it was:
  no layout at all, so the extension stayed inert), and every binding program is
  given `--schema-root <catalog folder>` on `lint`, `actions`, `list` and `run`,
  since its own root search would find nothing. The schema watcher follows the
  catalog's folder, and the extension activates on any
  `**/actions.catalog.yaml`. A workspace in the usual layout runs exactly
  the command lines it did.
* **Every path is a setting.** `bddSuite.root` names the suites' root (where
  binding programs run; `tool`, `build.cwd`, `library` and `stubFile` are
  relative to it), overriding the search; `--schema-root` is passed whenever
  the catalog is not `<root>/test/e2e/schema`. The live lint (a workspace's
  TypeScript library or the runtime the extension carries) reads the schema
  from the catalog's folder too, where it used to read
  `<root>/test/e2e/schema` only. `bddSuite.bindings.<name>.stubFile` says where
  *Declare action* writes a stub (PowerShell: `${action}` in the file name). A
  suite file is served by the layout whose root holds it, unless a
  `test/e2e/schema` tree nearer the file does. `bddSuite.root` is ignored in an
  untrusted folder, like `bindings`.

* **Generated C# tests run away from the machine that built them.** The
  generated `BddSuiteRun.Open` names the suite and the schema by their paths on
  the build machine, so a test assembly packaged and run elsewhere (a lab VM
  under TAEF) failed to open every suite. When those paths are not there, the
  runtime now looks for the schema and suite in their build-time layout (e.g.
  `schema` and `suites/orders.yml`) in the test assembly's folder or one above
  it, or under `test/e2e` there (`RepositoryPaths.Locate`, docs/test-providers
  DEC-T13). Run in place, nothing changes.
* **CI installs Pester 5 and retries the PowerShell Gallery.** The Pester job
  failed on a Gallery download, and `-MinimumVersion 5.5.0` now resolves to
  Pester 6.

## 0.7.6

* **The index survives a start-up burst of "too many open files".** When the
  extension host starts, every extension opens files at once, and a read could
  fail with `EMFILE`. The initial scan read every suite and binding source at
  once and never read a failed file again, so a workspace could open with no
  catalog actions, few suites or no registration sites: every action then
  showed as undeclared (red) until its file changed. Reads that fail with
  `EMFILE`, `ENFILE`, `EBUSY` or `EAGAIN` are now retried (50 ms doubling to
  800 ms), the scan reads 8 files at a time, files still unread are read once
  more 3 s later, and the log names any that stayed unread. The same retry
  covers the catalog's imports and the `bindingSources` read at activation.

## 0.7.5

* **C#: the packages are `Smartpcr.BddSuite` and `Smartpcr.BddSuite.Testing`.**
  nuget.org reserves the ID `Bdd.Suite` for another owner, so every push of
  `Bdd.Suite` was refused (nuget.org answered 409, which `--skip-duplicate`
  reported as "already exists"). The assemblies and namespaces stay
  `Bdd.Suite` and `Bdd.Suite.Testing`: a consumer renames its
  `PackageReference`s and nothing else. 0.7.4 is on nuget.org under the new
  IDs (uploaded by hand); GitHub Packages has the old IDs up to 0.7.4 and the
  new ones from 0.7.5. The extension's version warning reads both.
* **Release pipeline:** a nuget.org push that nuget.org refuses fails with
  nuget.org's reason (no `--skip-duplicate` once the version is known to be
  absent); the npm wait watches the document `npm install` reads; the
  TypeScript consumer's registry check reads the lock file correctly.

## 0.7.4

The first release to the public registries: `Bdd.Suite` and
`Bdd.Suite.Testing` on nuget.org, `@bdd-suite/runtime` on npm, `suiterun` on
crates.io. 0.7.3 was published to crates.io and GitHub Packages only (npm
asked for a one-time password, and the release was stopped there); it has no
GitHub release.

* **Release pipeline:** a version nuget.org refuses as a duplicate is
  reported as skipped, not published; the setup check finds `NUGET_USER` on
  the `release` environment.

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
