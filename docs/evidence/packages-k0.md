# Stage K0 evidence: shared foundations

Plan: [docs/packages/implementation.md](../packages/implementation.md#stage-k0-shared-foundations-p0).
Recorded 2026-10-20 on Windows 11, on top of `3998301` ("publish runtime
language packages: plan"), uncommitted. **Status: built; every check below
run locally; CI not run** (nothing pushed).

K0 writes the contract every runtime implements in K1 to K5 and holds each
runtime to it as **pending**: the new corpus entries are listed with
`pendingIn: [powershell, csharp, go, rust, typescript]`, and each runtime
removes itself in its own stage. Nothing here implements `--name`,
`--progress`, `fixture.throw` or `bdd-suite:core` in a runtime.

## What was built

| Where | What |
| --- | --- |
| `spec/README.md` | **The command line** section: `--name glob[,glob]` (run, list; with the tag filter; reason `tag`; an extension may not take it; PowerShell's `--test-name` stays) and `--progress`; the `list` line shape. **`bdd-suite:core`** in `imports`: the reader's own core, its bindings cut to the importer's `bindings` list; a path import read as written. |
| `spec/progress.md` | **New.** The run observer (what it is told, four rules: it changes nothing, only selected cases, nothing in a dry run, its own exceptions are the caller's), the progress lines (shape, order, standard output), what the corpus masks (failure text, durations), and the action worker rule with its limit (fatal conditions). |
| `spec/session.md` | "Selected" is the tag filter **and** the name filter; rule 8 names `--name`; new rule 11 (observers, workers). |
| `spec/actions.catalog.schema.json` | `imports` says what `bdd-suite:core` means. |
| `spec/Build-Schema.ps1` | Resolves `bdd-suite:core` to the `core.catalog.yaml` beside it and cuts each core action's `bindings` to the importer's list (and adds none of the core's binding names). Taken forward from K6.1 because the corpus's new schema folder must be generated now. Every existing generated schema is unchanged. |
| `spec/Schema.Tests.ps1` | Three tests: `bdd-suite:core` with a cut, without one (no `bindings`), and a path import uncut. The helper now returns the reference page, where bindings show. |
| `conformance/execute/` | `names.yml`, `names-and-tags.yml`, `names-none.yml`, `progress.yml` (+ `progress.expected.txt`), `worker-throws.yml`, `core-import.yml`, each with its expectation. |
| `conformance/validate/core-import.yml` | E201 at both core actions for binding `go` under a catalog that supports only `csharp`. |
| `conformance/schema-core-import/` | **New.** A catalog importing `bdd-suite:core` with `bindings: [csharp]`, and its generated schema and reference (every core action reads `Bindings: csharp`). |
| `conformance/schema/actions.catalog.yaml` | `fixture.throw` (param `message`), which each runtime's corpus test extension implements in its stage; the schema regenerated. |
| `conformance/run-manifest.yaml` | Seven entries (six execute, one validate) and a new `lists:` section (two entries), all pending in all five runtimes; fields `names`, `progress`, `schemaRoot`. |
| `conformance/expectation.schema.json` | `names` and `schemaRoot`. |
| `conformance/README.md` | The new fields, the `lists` section, the progress comparison, `fixture.throw`, "a pending entry of any kind is neither run nor counted as passed". |
| Each runtime's corpus tests | **K0.10**, by one agent per runtime: every reader of every kind (validate, execute, session, report, generate, catalog-call checks) skips an entry pending for it and reports it as pending; the manifest coverage tests count `progress` as naming a file. C# and TypeScript raised a count of the corpus catalog's declared actions from 13 to 14 (`fixture.throw` is declared, not implemented); Go and C# also check that an entry's `schemaRoot` folder exists; Rust fails if a `lists` entry is not pending for it (no Rust test reads `lists` yet). |
| `samples/workspace/tests/{go,powershell,typescript/*}/corpus` | The committed generated tests for the six new execute suites (the sample configs select `conformance/execute/*.yml`); no existing generated file changed. |
| `src/tools/versions.ts`, `test/unit/versions.test.ts` | **K0.11.** The version of each kind of file (csharp props, Cargo.toml, Cargo.lock path entry, package.json, package-lock entries, psd1), read and written by text so nothing else in a file changes; the check and the stamp. |
| `scripts/set-version.mjs`, `scripts/check-versions.mjs`, `package.json` | `npm run set-version`, `npm run check-versions`. |
| `runtimes/csharp/Directory.Build.props` | `<Version>`, now stamped. |
| Ten manifests and locks | Stamped to the extension's 0.6.10: the C# props, the crate and three Cargo.lock entries, the npm package and three lock files, the PowerShell module. |
| `.github/workflows/ci.yml` | **K0.12.** The build job runs `node scripts/check-versions.mjs` after the unit tests; the spec job checks `conformance/schema-core-import`'s generated schema. |
| `docs/packages/design.md`, `implementation.md` | Progress lines go to **standard output** (update2's patch writes there and its tooling reads it; the design had said standard error); the cut applies through `bdd-suite:core` only (applied to every import, it would have changed the five example catalogs' references). |

**How the expected traces were made.** The six execute expectations were
produced by the TypeScript runtime, not written by hand: a copy of each suite
whose selected cases carry a marker tag, run with `--tags <marker>`, selects
exactly the cases the name filter selects and reports the others the same way
(`skipped`, reason `tag`, the spec's rule for both filters); for
`worker-throws.yml` the copy used `core.fail` in place of `fixture.throw` and
the action name was put back. Exit codes came from the same runs. The
validate expectation was written by hand, and its positions confirmed by
`suiterun lint --binding-check --binding nobody` on the same suite (E201 at
6:17 and 8:17, exit 2). `progress.expected.txt` was written from
`spec/progress.md`; the first runtime to implement `--progress` (C#, K1.2)
proves it against update2's code that it ports.

## Step by step

| Step | Status | Evidence |
| --- | --- | --- |
| K0.1 `spec/README.md` flags; `spec/progress.md` | done | The files above. |
| K0.2 `spec/session.md`: selection with `--name` | done | "Selected", rule 8. |
| K0.3 Observer contract and worker rule | done | `spec/progress.md`; session rule 11. |
| K0.4 `imports` accepts `bdd-suite:core`; narrowing | done | Catalog schema description; spec README; generator and its three tests. |
| K0.5 `execute/names.yml` and expectations | done | `names.yml`, `names-and-tags.yml`, `names-none.yml`. |
| K0.6 A `list` entry with names | done | `lists:` in the manifest (two entries). |
| K0.7 `execute/progress.yml` and transcript | done | With `progress.expected.json` for its trace. |
| K0.8 `fixture.throw`; `execute/worker-throws.yml` | done | Catalog, schema regenerated. |
| K0.9 `bdd-suite:core` validate and execute entries | done | `schema-core-import/`, `validate/core-import.yml`, `execute/core-import.yml`. |
| K0.10 Manifest fields; pending list; each corpus test reads it | done | The runs below. |
| K0.11 `set-version` and `check-versions`; unit tests | done | 251 unit tests, 100% coverage; the check failed on the ten 0.1.0 files before the stamp, passes after. |
| K0.12 The version check in CI | built; CI not run | The build job's new step. |

## Runs

| Run | Result |
| --- | --- |
| Every expectation file named by a new entry against `expectation.schema.json` (Ajv 2020) | 7 of 7 valid |
| `Invoke-Pester spec/Schema.Tests.ps1` | 53 passed, 0 failed |
| `Build-Schema.ps1 -Check` on the nine committed catalogs (the CI spec list plus the sample workspace) | all current |
| `npm run test:unit` (extension) | 251 passed; 100% of lines, branches, functions, statements |
| `node scripts/check-versions.mjs` before / after `npm run set-version` | exit 1 naming 11 values in 10 files / "10 files are at 0.6.10" |
| `npm ls @bdd-suite/runtime` in both TypeScript samples; `cargo metadata --locked` in the Rust runtime and sample | 0.6.10 linked; locks accepted |
| C#: `dotnet test Bdd.Suite.Tests` | 220 passed (5 failed before K0.10); 7 entries pending |
| Go: `go test -race ./...` | every package ok (3 failed before); validate 41 + 1 pending, execute 14 + 6 pending, reports 7 |
| Rust: `cargo test --features testing` | every binary 0 failed (lib 150, conformance 7, session 18, ...); 9 pending (6 execute, 1 validate, 2 lists) |
| TypeScript: `npm test` | 146 passed; coverage gate passed; 7 pending |
| PowerShell: `Invoke-Pester runtimes/powershell` | 117 passed, 0 failed, 13 skipped (the 7 pending entries under E2 and the 6 execute ones under E1) |
| `samples/workspace/tests/harness/corpus.mjs --provider <p>` and the language's `scenarios.mjs`, for all ten providers (MSTest, NUnit, xUnit, Go, Rust, `node:test`, Vitest, Jest, Mocha, Pester), after the stamp | 20 of 20 exit 0: each provider 14 corpus entries and 9 sample suites, 0 differ, the six new execute entries listed pending; scenarios 5 of 5 (Pester 4 of 4) |

The runtime suites ran before the version stamp; the stamp changed only
version strings, and the provider runs, which build every runtime and sample,
ran after it.

## Open

* **CI.** Not run; the new build-job step and the spec job's extra catalog run
  when the user pushes.
* **The pending entries** close stage by stage: K1 (C#) to K5 (PowerShell),
  each removing its runtime from `pendingIn` and implementing `fixture.throw`
  in its corpus test extension.
