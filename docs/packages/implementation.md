# Publishing the runtimes as packages: implementation plan

Status: **designed 2026-10-20; stages K0 to K3 built 2026-10-20 and in CI with the 0.7.0 release, K4 in CI with the 0.7.1 release, K5 built and run locally, not committed ([K0](../evidence/packages-k0.md), [K1](../evidence/packages-k1.md), [K2](../evidence/packages-k2.md), [K3](../evidence/packages-k3.md), [K4](../evidence/packages-k4.md), [K5](../evidence/packages-k5.md)); K6 to K9 not started. 0.7.0 is released to this repository and its GitHub Packages feed, not to the public registries (the user's choice, 2026-10-20).** The outcomes (O1–O6),
decisions (DEC-P01–DEC-P11) and scenarios (E1–E12) are in
[design.md](design.md). This plan says how each outcome is built, in what
order, and what evidence closes each step.

Working rules:

* **Statuses stay separate**: designed, built, unit-tested, locally accepted
  (a consumer passes from a local feed), published (E11, real registries),
  adopted (E12, update2). A step is ticked only with its evidence recorded in
  `docs/evidence/packages-<stage>.md`; a skipped, blocked or failed scenario
  stays open.
* **Nothing is published, pushed or changed in update2 unless the user asks.**
  Stages K0 to K7 never touch a registry; publish steps run in dry-run mode
  until stage K8, which needs the user's approval and registry setup.
* **A runtime's flags land before its package** (O3 before O1 in each
  language), so the first published version already carries what update2
  needs.
* **A manual check is labelled `manual`** and never ticks a scenario.
* **After a change to the VS Code extension** (D12, D13), run `npm run
  install:local` and reload the window before checking it by hand.

## Contents

* [1. Deliverables](#1-deliverables)
* [2. Order and dependencies](#2-order-and-dependencies)
* [3. Stages](#3-stages)
* [4. Acceptance index](#4-acceptance-index)
* [5. Effort](#5-effort)
* [6. Operator setup before the first release](#6-operator-setup-before-the-first-release)

## 1. Deliverables

Priority: **P0** is C# end to end, which is what update2 needs: the spec for
the new flags, C# with them, the two NuGet packages proved by a consumer, and
lockstep versions. **P1** is the other four languages, the core spec without a
checkout, the VS Code extension's defaults, the release pipeline and the first
publish. **P2** is update2's adoption, which is its repository's work.
Priority orders the work; it never weakens a completion condition.

### <a id="d1"></a>D1. Spec and corpus for `--name`, `--progress`, the observer, the worker rule and `bdd-suite:core` (P0)

* **Result.** The format says what the new flags do, what the progress lines
  look like, what an observer may not do, that a worker failure is a step
  failure, and how `bdd-suite:core` resolves and narrows; the corpus holds
  entries every runtime must pass.
* **How.** `spec/README.md` (command line), a new `spec/progress.md` (the line
  shape, standard output, masking of durations for comparison), the session
  spec (`--name` applies to a session's selection), the catalog schema
  (`imports` accepts `bdd-suite:core`) and a narrowing rule. Corpus:
  `execute/names.yml`, `execute/progress.yml` with
  `execute/progress.expected.txt`, `execute/worker-throws.yml`, a list entry,
  a validate entry for a catalog importing `bdd-suite:core`; manifest fields
  `names:` and `progress:`; the corpus catalog gains `fixture.throw` (kind:
  the language's unusual failure).
* **Files.** `spec/*.md`, `spec/actions.catalog.schema.json`,
  `conformance/run-manifest.yaml`, `conformance/execute/*`,
  `conformance/schema/*`, `conformance/README.md`.
* **Depends on.** Nothing.
* **Done when.** The spec job passes; the entries exist and each runtime's
  corpus test reports them as **expected failures until its stage**, through
  the manifest's per-runtime pending list (removed entry by entry in K1–K5).
* **Proved by.** E7, E8 (once the runtimes pass).

### <a id="d2"></a>D2. C#: `--name`, `--progress`, the observer, the worker rule, `bdd-suite:core` (P0)

* **Result.** update2's P2–P5 in `runtimes/csharp`, as specified, plus the
  core import.
* **How.** Port the patches (they are a few marked lines each, and update2's
  `Bdd.Suite.Patches.UnitTest` is their test) into `CommandLine`,
  `Composite` (core flags an extension may not take), `SuiteExpansion`
  (`NameMatches`), `Executor` (`RunOptions.Names`, `IRunObserver`, the worker
  catch-all), `SuiteSession`, `Runner.Running`, `Trace.Added`,
  `Run/ProgressPrinter.cs` (writing to standard output). Embed
  `spec/core.catalog.yaml` and resolve `bdd-suite:core` in the catalog loader.
  Port the patch tests into `Bdd.Suite.Tests`.
* **Files.** `runtimes/csharp/Bdd.Suite/**`, `Bdd.Suite.Tests/**`.
* **Depends on.** D1.
* **Done when.** The C# corpus, including D1's entries, passes; unit tests and
  coverage as today; the samples' providers still pass.
* **Proved by.** E7, E8 (C#).

### <a id="d3"></a>D3. Go: the same (P1)

* **Result.** D2's features in `runtimes/go`.
* **How.** Flags in `suite/cli`; `exec` options `Names`, an `Observer`
  interface and a progress printer; the worker goroutine recovers any panic
  into a step failure; `embed` the core catalog; the loader resolves
  `bdd-suite:core`.
* **Files.** `runtimes/go/suite/**`, `runtimes/go/internal/**`.
* **Depends on.** D1.
* **Done when.** `go test -race ./...` and the corpus pass, with D1's entries.
* **Proved by.** E7, E8 (Go).

### <a id="d4"></a>D4. Rust: the same (P1)

* **Result.** D2's features in `runtimes/rust`.
* **How.** Flags in the CLI; `RunOptions.names`, an `Observer` trait; the
  worker thread's `catch_unwind` reports a panic as the step's failure (panic
  strategy `unwind` is documented as required); `include_str!` the core.
* **Files.** `runtimes/rust/src/**`, `tests/**`.
* **Depends on.** D1.
* **Done when.** `cargo test --features testing` and the corpus pass.
* **Proved by.** E7, E8 (Rust).

### <a id="d5"></a>D5. TypeScript: the same (P1)

* **Result.** D2's features in `runtimes/typescript`.
* **How.** CLI flags; `RunOptions.names`, an observer interface; the bounded
  action catches any thrown value (`unknown`, not only `Error`) and turns a
  non-`Error` into a message; the core file shipped in the package and
  resolved by the loader.
* **Files.** `runtimes/typescript/src/**`, `test/**`.
* **Depends on.** D1.
* **Done when.** `npm test` (with its coverage gate) and the corpus pass.
* **Proved by.** E7, E8 (TypeScript).

### <a id="d6"></a>D6. PowerShell: the same (P1)

* **Result.** D2's features in `runtimes/powershell`; `--test-name` kept.
* **How.** `Cli.ps1` and `Invoke-BddSuite` take `--name`/`-Name` and
  `--progress`/`-Progress`; an observer scriptblock set; the runspace worker
  catches every error record and exception; the core file in the module
  folder, resolved by `Read-SuiteCatalog`.
* **Files.** `runtimes/powershell/BddSuite/**`, `tests/**`.
* **Depends on.** D1.
* **Done when.** `Invoke-Pester runtimes/powershell` and the corpus pass.
* **Proved by.** E7, E8 (PowerShell).

### <a id="d7"></a>D7. C# packages `Bdd.Suite` and `Bdd.Suite.Testing` (P0)

* **Result.** Two `.nupkg` (and `.snupkg`) that a consumer references by
  version, with no import and no path ([DEC-P01](design.md#dec-p01),
  [DEC-P04](design.md#dec-p04)).
* **How.** Package metadata in `runtimes/csharp/Directory.Build.props`
  (authors, license expression MIT, repository URL, README, SourceLink,
  `ContinuousIntegrationBuild`, `Deterministic`, symbols). `Bdd.Suite`: version
  ranges on its two dependencies. `Bdd.Suite.Testing`: packs the published
  `suiterun` of `Bdd.Suite.Cli` (framework-dependent, `net10.0`, no app
  host) under `tools/net10.0/`, and `build/Bdd.Suite.Testing.targets` (not
  `buildTransitive/`: a project that only references one that references the
  package must not start generating tests). The targets run the generator from
  the package's `tools/` unless `BddSuiteCliProject` is set; in a checkout they
  set it themselves when `Bdd.Suite.Cli` sits two folders up, so this
  repository's samples change nothing. `Bdd.Suite.Cli`, `Bdd.Suite.Tests` and
  `Bdd.Suite.Example` are `IsPackable=false`. An expected-contents list per
  package.
* **Files.** `runtimes/csharp/Directory.Build.props`, the three csproj,
  `Bdd.Suite.Testing/build/*.targets`, `packaging/*.files.txt`,
  `scripts/Test-PackageContents.ps1`.
* **Depends on.** D2 (so the first package has the flags), D14.
* **Done when.** E1 (C#) and E2 pass; the samples' providers pass unchanged.
* **Proved by.** E1, E2.

### <a id="d8"></a>D8. npm package `@bdd-suite/runtime` (P1)

* **Result.** A publishable tarball with the library, `suiterun`, the
  providers, the reporter and the core spec.
* **How.** Drop `private`; `files` (`dist/`, `spec/`, `README.md`, `LICENSE`);
  `license`, `repository`, `homepage`, `keywords`; `publishConfig.access:
  public` and `provenance: true`; a `prepack` that builds and copies the core
  spec. Exclude `dist-test`, `coverage`.
* **Files.** `runtimes/typescript/package.json`, `scripts/*`, `packaging/*`.
* **Depends on.** D5, D14.
* **Done when.** E1 (TypeScript), E5.
* **Proved by.** E1, E5.

### <a id="d9"></a>D9. Rust crate `suiterun` (P1)

* **Result.** A `.crate` that `cargo package` verifies.
* **How.** Remove `publish = false`; `license`, `repository`, `homepage`,
  `readme`, `keywords`, `categories`; `include` (src with the core copy,
  README, LICENSE); `[package.metadata.docs.rs] features = ["testing"]`; a
  `LICENSE` copy in the crate folder. `rust-version` is left out until a
  minimum toolchain is tested. `build.rs` users need nothing outside the crate.
* **Files.** `runtimes/rust/Cargo.toml`, `packaging/*`.
* **Depends on.** D4, D14.
* **Done when.** E1 (Rust), E4, `cargo publish --dry-run`.
* **Proved by.** E1, E4.

### <a id="d10"></a>D10. PowerShell module `BddSuite` for the Gallery (P1)

* **Result.** A module folder `Publish-PSResource` accepts, holding everything
  a consumer runs.
* **How.** `BddSuite.psd1`: `PrivateData.PSData` (tags, `LicenseUri`,
  `ProjectUri`, `ReleaseNotes`), `CompatiblePSEditions = 'Core'`; move
  `suiterun.ps1` and `Invoke-BddSuite.ps1` into the module folder (keeping
  thin forwarders at the old paths for this repository's users); the core spec
  inside; a `FileList`. A test that publishes to a file repository and
  installs it.
* **Files.** `runtimes/powershell/**`, `packaging/*`.
* **Depends on.** D6, D14.
* **Done when.** E1 (PowerShell), E6.
* **Proved by.** E1, E6.

### <a id="d11"></a>D11. Go module, ready to be consumed by version (P1)

* **Result.** The module a consumer `go get`s carries the features, its docs
  render on pkg.go.dev, and a local file proxy proves it before the tag.
* **How.** Package doc comments (every package had one but `cmd/suiterun`);
  `README.md`; a `LICENSE` copy in the module (pkg.go.dev shows docs only for a
  module whose zip holds one); a tool that writes a module version in the
  proxy's layout (`golang.org/x/mod/zip`) for a file `GOPROXY`; `retract` left
  for when a version needs it. The tag is still made by the release job
  ([D16](#d16)).
* **Files.** `runtimes/go/**`, `scripts/go-module-zip/*`.
* **Depends on.** D3, D14.
* **Done when.** E1 (Go), E3.
* **Proved by.** E1, E3.

### <a id="d12"></a>D12. The core spec without a checkout, in the VS Code extension too (P1)

* **Result.** A catalog imports `bdd-suite:core`; the extension bundles the
  spec and its default schema generator is the bundled `Build-Schema.ps1`
  ([DEC-P07](design.md#dec-p07)).
* **How.** `Build-Schema.ps1` resolves `bdd-suite:core` to the core beside
  it; the extension's catalog index resolves it to its bundled copy;
  `.vscodeignore` keeps `spec/core.catalog.yaml`, the schemas and the
  generator in the `.vsix`; `bddSuite.schemaGenerator` defaults to the bundled
  generator with `-Catalog ${catalogPath}`; a warning when the workspace's
  package version (read from `Directory.Packages.props`, `go.mod`,
  `Cargo.toml`, `package.json` or a `.psd1` requirement, when found) differs
  from the extension's.
* **Files.** `spec/Build-Schema.ps1`, `src/catalog/*`, `src/config/defaults.ts`,
  `package.json`, `.vscodeignore`, tests.
* **Depends on.** D1, D2–D6 (the runtimes resolve it too).
* **Done when.** E8 passes in all five runtimes and the extension; unit tests
  at 100%; `npm run install:local`.
* **Proved by.** E8, E9.

### <a id="d13"></a>D13. The VS Code extension's bundled linter (P1)

* **Result.** In-editor lint works in a workspace with no TypeScript binding
  ([DEC-P08](design.md#dec-p08)).
* **How.** esbuild bundles `runtimes/typescript` into the extension; the lint
  worker loads the workspace's library when the configured path exists, else
  the bundled one; the status bar says which. Size budget for the `.vsix`
  recorded.
* **Files.** `esbuild.mjs`, `src/lint/*`, tests.
* **Depends on.** D8 (the runtime is packable as one unit), D12.
* **Done when.** E9; unit tests at 100%; `npm run install:local`.
* **Proved by.** E9.

### <a id="d14"></a>D14. Lockstep versions (P0)

* **Result.** One command sets every manifest's version from `package.json`;
  CI fails when they differ ([DEC-P03](design.md#dec-p03)).
* **How.** `scripts/set-version.mjs` (csproj `Version` via
  `Directory.Build.props`, `Cargo.toml`, runtime `package.json` and lock,
  `BddSuite.psd1`); `scripts/check-versions.mjs` in the `build` job.
* **Files.** `scripts/*`, `.github/workflows/ci.yml`.
* **Depends on.** Nothing.
* **Done when.** The check passes after `set-version`, fails on a hand edit
  (unit test).
* **Proved by.** E10.

### <a id="d15"></a>D15. Consumer samples and local feeds (P0 for C#, P1 others)

* **Result.** `samples/consumers/{csharp,go,rust,typescript,powershell}`,
  each a small repository-shaped consumer that references **only** packages,
  and `scripts/pack-all.ps1` plus `scripts/local-feeds.ps1` that build every
  package and every local feed ([DEC-P09](design.md#dec-p09)).
* **How.** Each consumer: one extension with one action (`greet.say`), its
  binding program, two suites (one offline, one guarded), and tests through
  one provider (MSTest, `go test`, `cargo test`, `node:test`, Pester). C#
  uses central package management and a `nuget.config` naming the local feed.
  A script per language runs its E-scenario from the feed.
* **Files.** `samples/consumers/**`, `scripts/pack-all.ps1`,
  `scripts/local-feeds.ps1`.
* **Depends on.** D7 (C#), D8–D11 (others).
* **Done when.** E2–E6 each pass from a clean clone with only the feeds.
* **Proved by.** E2–E6.

### <a id="d16"></a>D16. The release pipeline (P1)

* **Result.** CI packs once, proves from feeds, and on a release publishes to
  the four registries, then makes the GitHub release and the Go tag
  ([DEC-P10](design.md#dec-p10)).
* **How.** A `packages` job (E1, uploads `artifacts/packages`), a
  `consumers` matrix (E2–E6 from the artifact), and `publish-*` jobs in the
  `release` environment: `dotnet nuget push --skip-duplicate` (OIDC login
  action for nuget.org trusted publishing), `npm publish --provenance` (npm
  trusted publishing), `cargo publish` (crates.io trusted publishing), and
  `Publish-PSResource -ApiKey` (secret `PSGALLERY_API_KEY`); each asks the
  registry first and skips an existing version. On pull requests every
  publish step runs in dry-run mode. The existing `release` job then needs the
  publish jobs; its notes list each package with its registry link.
* **Files.** `.github/workflows/ci.yml`, `scripts/publish/*.ps1`.
* **Depends on.** D7–D11, D14, D15.
* **Done when.** E10 on a pull request; actionlint clean; the dry-run report
  names every package at the version.
* **Proved by.** E10, E11.

### <a id="d17"></a>D17. Documentation (P1)

* **Result.** Each package's README (shown on its registry page) says how to
  install it, write an extension, build the binding program, generate tests
  and use the new flags; the root README gains "Install"; the CHANGELOG lists
  the packages and the new flags; a migration note "from a copy to the
  package" for consumers like update2.
* **Files.** `runtimes/*/README.md`, `README.md`, `CHANGELOG.md`,
  `docs/packages/migrating.md`.
* **Depends on.** D7–D13.
* **Done when.** Written; the user has reviewed them.
* **Proved by.** Review (manual), and E1's README check.

### <a id="d18"></a>D18. update2 moves from its copy to the packages (P2, other repository)

* **Result.** update2 references `Bdd.Suite` and `Bdd.Suite.Testing` by
  version; `runtime/`, `Bdd.Suite.Patches.UnitTest`, the core catalog copy and
  the `test/e2e/bdd` junction are gone ([E12](design.md#e12)).
* **How.** In an update2 worktree on a branch: add the two packages to its
  `Directory.Packages.props` (and nuget.org, or its internal feed with
  nuget.org upstream, to its sources); swap project references; import
  `bdd-suite:core`; point `bddSuite.schemaGenerator` at the default; update
  `UPSTREAM.md` and its design; run its unit and MSTest projects.
* **Files.** update2: `test/e2e/bindings/dotnet/**`, `test/e2e/schema/*`,
  `.vscode/settings.json`, `test/e2e/UPSTREAM.md`, `docs/bdd/*`.
* **Depends on.** E11 (a published version), D2, D7, D12.
* **Done when.** E12; the branch handed to the user, not pushed.
* **Proved by.** E12.

## 2. Order and dependencies

```text
D14 versions ─────────────────────────────────────────────────────┐
D1 spec + corpus ──┬─> D2 C# flags ──> D7 NuGet ──> D15 C# consumer ─┤
                   ├─> D3 Go flags ──> D11 Go module ─> D15 Go ──────┤
                   ├─> D4 Rust flags ─> D9 crate ────> D15 Rust ─────┤
                   ├─> D5 TS flags ──> D8 npm ──────> D15 TS ───────┼─> D16 pipeline ─> E11 publish ─> D18 update2
                   ├─> D6 PS flags ──> D10 module ──> D15 PS ───────┤        (remote)        (remote)
                   └─> D12 core import (needs D2–D6) ─> D13 bundled linter (needs D8)
D17 docs follow D7–D13.
```

Implementation dependencies run left to right. **Runtime prerequisites** are
separate: E11 needs the operator setup in [section 6](#6-operator-setup-before-the-first-release)
(accounts, trusted publishers, a key, the `release` environment); E12 needs
update2's restore sources to reach nuget.org. **When features may be enabled:**
a consumer may use `--name` and `--progress` from the first published
version; `bdd-suite:core` from the version whose five runtimes and extension
all resolve it (K6); the VS Code extension's bundled linter ships in the same
release.

## 3. Stages

Each stage closes on its exit evidence, recorded in
`docs/evidence/packages-<stage>.md`.

### Stage K0: shared foundations (P0)

Result: D1, D14. Entry: none. Exit evidence: the spec job passes; every
runtime's corpus lists D1's entries as pending; the version check passes and
its unit test proves it fails on a mismatch.

- [x] K0.1 `spec/README.md`: `--name` (run, list), `--progress`; `spec/progress.md` (line shape, standard output, duration masking).
- [x] K0.2 `spec/session.md`: a session's selection applies `--name` with the tag filter.
- [x] K0.3 Observer contract and the worker rule written into the spec, with the fatal-condition limit.
- [x] K0.4 Catalog schema: `imports` accepts `bdd-suite:core`; the narrowing rule written.
- [x] K0.5 Corpus: `execute/names.yml` and its expectations (names alone, names with tags, no match).
- [x] K0.6 Corpus: a `list` entry with names.
- [x] K0.7 Corpus: `execute/progress.yml` and `progress.expected.txt`.
- [x] K0.8 Corpus: `fixture.throw` in the corpus catalog; `execute/worker-throws.yml` and expectations.
- [x] K0.9 Corpus: a catalog importing `bdd-suite:core` with narrowed bindings, validate and execute entries.
- [x] K0.10 Manifest fields `names:`, `progress:`; the per-runtime pending list and each corpus test reading it.
- [x] K0.11 `scripts/set-version.mjs` and `scripts/check-versions.mjs`; unit tests.
- [x] K0.12 The version check in the CI `build` job.

### Stage K1: C# end to end (P0)

Result: D2, D7, D15 (C#). Entry: K0. Exit evidence: C# corpus with the new
entries; E1 (C#) and E2 from a local feed.

- [x] K1.1 `--name` in `CommandLine`, `Composite`, `SuiteExpansion.NameMatches`, `RunOptions.Names`, `SuiteSession`, `list`.
- [x] K1.2 `IRunObserver`, `Trace.Added`, `ProgressPrinter` on standard output, `--progress`.
- [x] K1.3 The worker catch-all.
- [x] K1.4 Embedded core; `bdd-suite:core` in the catalog loader with narrowing.
- [x] K1.5 update2's patch tests ported into `Bdd.Suite.Tests`; coverage as before.
- [x] K1.6 The C# corpus passes with D1's entries; its pending list emptied.
- [x] K1.7 Package metadata, SourceLink, symbols in `Directory.Build.props`; `IsPackable` per project.
- [x] K1.8 Dependency ranges in `Bdd.Suite`.
- [x] K1.9 `Bdd.Suite.Testing` packs `suiterun` under `tools/` and the targets under `build/` (not `buildTransitive/`; see D7).
- [x] K1.10 Targets find the generator in the package unless `BddSuiteCliProject` is set, which they set themselves in a checkout; the samples' providers still pass.
- [x] K1.11 Expected-contents lists and the pack check (E1, C#).
- [x] K1.12 `samples/consumers/csharp`: extension, binding program, MSTest project, central package management, `nuget.config`.
- [x] K1.13 The local NuGet feed script; E2 with MSTest.
- [x] K1.14 E2 with NUnit 4 and xUnit v3 (one project each).
- [x] K1.15 The C# README's package section (draft for D17).

### Stage K2: Go (P1)

Result: D3, D11, D15 (Go). Entry: K0. Exit evidence: Go corpus with the new
entries; E1 (Go), E3.

- [x] K2.1 `--name` and `--progress` in `suite/cli`; `Names` and the observer in `exec`.
- [x] K2.2 The progress printer.
- [x] K2.3 The worker recovers any panic into a step failure.
- [x] K2.4 Embedded core; `bdd-suite:core` in the loader.
- [x] K2.5 Unit tests; `go test -race ./...`; the corpus with D1's entries.
- [x] K2.6 Package docs and README for pkg.go.dev.
- [x] K2.7 The module zip script and a file `GOPROXY`; E1 (Go).
- [x] K2.8 `samples/consumers/go`; E3.

### Stage K3: Rust (P1)

Result: D4, D9, D15 (Rust). Entry: K0. Exit evidence: Rust corpus with the new
entries; E1 (Rust), E4, `cargo publish --dry-run`.

- [x] K3.1 `--name` and `--progress` in the CLI; `names` and the `Observer` trait.
- [x] K3.2 The progress printer.
- [x] K3.3 `catch_unwind` in the worker; panic strategy documented.
- [x] K3.4 `include_str!` core; `bdd-suite:core` in the loader.
- [x] K3.5 Tests; `cargo test --features testing`; the corpus with D1's entries.
- [x] K3.6 `Cargo.toml` metadata, `include`, docs.rs features; `publish = false` removed.
- [x] K3.7 The crate in a local feed (packed, checked, unpacked); E1 (Rust); `cargo publish --dry-run`.
- [x] K3.8 `samples/consumers/rust`; E4.

### Stage K4: TypeScript (P1)

Result: D5, D8, D15 (TypeScript). Entry: K0. Exit evidence: TypeScript corpus
with the new entries and its coverage gate; E1 (TypeScript), E5.

- [x] K4.1 `--name` and `--progress`; `names` and the observer interface.
- [x] K4.2 The progress printer.
- [x] K4.3 The bounded action catches any thrown value.
- [x] K4.4 Core spec file in the package; `bdd-suite:core` in the loader.
- [x] K4.5 Tests; `npm test` with the coverage gate; the corpus with D1's entries.
- [x] K4.6 `package.json`: not private, `files`, metadata, `publishConfig`, `prepack`.
- [x] K4.7 `npm pack`; E1 (TypeScript).
- [x] K4.8 `samples/consumers/typescript`; E5.

### Stage K5: PowerShell (P1)

Result: D6, D10, D15 (PowerShell). Entry: K0. Exit evidence: PowerShell corpus
with the new entries; E1 (PowerShell), E6.

- [x] K5.1 `--name`/`-Name` and `--progress`/`-Progress`; `--test-name` kept.
- [x] K5.2 The observer scriptblocks and the progress printer.
- [x] K5.3 The runspace worker catches every error.
- [x] K5.4 Core file in the module; `bdd-suite:core` in `Read-SuiteCatalog`.
- [x] K5.5 Pester tests; the corpus with D1's entries.
- [x] K5.6 `BddSuite.psd1` Gallery metadata and `FileList`; entry scripts inside the module with forwarders at the old paths.
- [x] K5.7 A file PSResource repository; E1 (PowerShell).
- [x] K5.8 `samples/consumers/powershell`; E6.

### Stage K6: the core spec and the VS Code extension (P1)

Result: D12, D13. Entry: K1–K5 (every runtime resolves `bdd-suite:core`), K4
(the runtime is packable). Exit evidence: E8 in five runtimes and the
extension; E9; unit tests at 100%; `npm run install:local`.

- [ ] K6.1 `Build-Schema.ps1` resolves `bdd-suite:core`; its tests.
- [ ] K6.2 The extension's catalog index resolves it; unit tests.
- [ ] K6.3 `.vscodeignore` and packaging keep the spec in the `.vsix`; the B9.1 file-count check updated.
- [ ] K6.4 `bddSuite.schemaGenerator` defaults to the bundled generator.
- [ ] K6.5 The version-mismatch warning; unit tests.
- [ ] K6.6 esbuild bundles the runtime; the lint worker falls back to it; the status bar says which.
- [ ] K6.7 Integration test: E9 in a scratch C#-only workspace.
- [ ] K6.8 E8 across runtimes and the extension; unit tests at 100%; `npm run install:local`.

### Stage K7: pipeline and documentation (P1)

Result: D16, D17. Entry: K1–K6. Exit evidence: E10 green on a pushed pull
request branch (pushed only when the user asks); the READMEs reviewed.

- [ ] K7.1 `scripts/pack-all.ps1` and `scripts/local-feeds.ps1` for all five.
- [ ] K7.2 CI `packages` job (E1 for all, uploads the artifact).
- [ ] K7.3 CI `consumers` matrix (E2–E6 from the artifact).
- [ ] K7.4 `publish-nuget`, `publish-npm`, `publish-crates`, `publish-psgallery` jobs, dry run on pull requests, `--skip-duplicate`/exists checks.
- [ ] K7.5 The `release` job needs them; release notes list each package and its registry link; the Go tag after them.
- [ ] K7.6 actionlint and the workflow parse check.
- [ ] K7.7 READMEs per package; root README "Install"; CHANGELOG.
- [ ] K7.8 `docs/packages/migrating.md` (copy to package; update2 as the worked example).
- [ ] K7.9 E10 on a pull request (needs a push: the user's call).

### Stage K8: the first public release (P1, remote)

Result: E11. Entry: K7; the operator setup in
[section 6](#6-operator-setup-before-the-first-release) done by the user; the
user's go-ahead for this version. Exit evidence: E11's run ID, each registry
URL, and the clean-install job's results.

- [ ] K8.1 The user completes the operator setup; recorded (no secrets in the record).
- [ ] K8.2 Version bump with `scripts/set-version.mjs`; merged to main by the user.
- [ ] K8.3 The user approves the `release` environment; the publish jobs run.
- [ ] K8.4 The clean-install job runs E2–E6's consumers from the public registries.
- [ ] K8.5 Evidence recorded; any failure fixed forward and the bad version handled as in design section 5.

### Stage K9: update2 adoption (P2, other repository)

Result: D18. Entry: K8. Exit evidence: E12 on an update2 branch, handed to the
user; nothing pushed unless asked.

- [ ] K9.1 An update2 worktree and branch; its restore sources reach nuget.org (or its internal feed's upstream).
- [ ] K9.2 `Directory.Packages.props` gains `Bdd.Suite` and `Bdd.Suite.Testing`; project references swapped; `runtime/` removed.
- [ ] K9.3 `Bdd.Suite.Patches.UnitTest` removed; its cases now live upstream (K1.5).
- [ ] K9.4 The catalog imports `bdd-suite:core`; the core copy and the junction instructions removed; `.vscode/settings.json` uses the default generator.
- [ ] K9.5 `UPSTREAM.md` and `docs/bdd/*` updated (requests 6.1–6.3, 6.6 closed with the version).
- [ ] K9.6 Its build, `Urp.Bvt.Suite.UnitTest`, `Urp.Bvt.Suite.MsTest`; its suiterun with `--name` and `--progress`; counts equal the copy's.
- [ ] K9.7 Evidence recorded in both repositories; the branch handed to the user.

## 4. Acceptance index

| Scenario | Proves | Deliverables | Stage(s) | Status |
| --- | --- | --- | --- | --- |
| [E1](design.md#e1) | O1 | D7–D11, D17 | K1–K5, K7 | not run |
| [E2](design.md#e2) | O1, O2 | D7, D15 | K1 | not run |
| [E3](design.md#e3) | O1 | D11, D15 | K2 | not run |
| [E4](design.md#e4) | O1 | D9, D15 | K3 | not run |
| [E5](design.md#e5) | O1 | D8, D15 | K4 | not run |
| [E6](design.md#e6) | O1 | D10, D15 | K5 | not run |
| [E7](design.md#e7) | O3 | D1–D6 | K1–K5 | not run |
| [E8](design.md#e8) | O4 | D1–D6, D12 | K1–K6 | not run |
| [E9](design.md#e9) | O6 | D12, D13 | K6 | not run |
| [E10](design.md#e10) | O5 | D14, D16 | K7 | not run |
| [E11](design.md#e11) | O1, O5 | D7–D11, D16 | K8 | not run; remote, needs the user's approval |
| [E12](design.md#e12) | O3, O4 | D18 | K9 | not run; other repository |

## 5. Effort

Engineer-days for one engineer who knows the runtimes; estimates for
planning.

| Stage | Days |
| --- | --- |
| K0 shared foundations | 2 |
| K1 C# end to end | 4 |
| K2 Go | 2 |
| K3 Rust | 2.5 |
| K4 TypeScript | 2 |
| K5 PowerShell | 2.5 |
| K6 core spec and VS Code extension | 3 |
| K7 pipeline and docs | 3 |
| K8 first release (excluding registry indexing waits) | 1 |
| K9 update2 adoption | 1.5 |
| **Total** | **23.5** |

## 6. Operator setup before the first release

Done once by the user, who owns the registry accounts; the plan records that
it was done, never the secrets.

| Registry | Setup |
| --- | --- |
| npmjs.com | Create the org `bdd-suite`; add a trusted publisher for `smartpcr/bdd-code-extension`, workflow `ci.yml`, environment `release`. |
| nuget.org | Add a trusted publishing policy for the same repository, workflow and environment; optionally request the ID prefix reservation `Bdd.Suite`. |
| crates.io | After the first manual or token publish of `suiterun` (crates.io needs the crate to exist), add a trusted publisher for the same workflow and environment. |
| PowerShell Gallery | Create an API key scoped to push `BddSuite`; store it as the `release` environment secret `PSGALLERY_API_KEY`. |
| GitHub | Create the environment `release` with the user as required reviewer; restrict it to `main`. |
| Go | Nothing: proxy.golang.org reads the tag. |
