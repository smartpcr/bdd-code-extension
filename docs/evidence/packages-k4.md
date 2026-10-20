# Stage K4 evidence: TypeScript

Plan: [docs/packages/implementation.md](../packages/implementation.md#stage-k4-typescript-p1).
Recorded 2026-10-20 on Windows 11, Node.js 24, on top of `c415f0d` (the 0.7.0
release commits), uncommitted. **Status: built; locally accepted (E1 and E5
for TypeScript, E7 and E8 for TypeScript); CI not run for K4** (nothing pushed;
nothing published).

## What was built

| Where | What |
| --- | --- |
| `src/cli.ts`, `src/extension.ts` | **D5.** `--name glob[,glob]` (repeatable) and `--progress` in `Options` (`names`, `progress`), the usage and the header comment; both among the core flags an extension may not take. |
| `src/suite.ts`, `src/session.ts`, `src/run.ts` | `nameMatches` (the `--path` glob over the whole name); a session selects by tags and names; `list` applies both. |
| `src/exec.ts`, `src/trace.ts`, `src/progress.ts` (new) | `RunObserver` (`caseStarted`, `caseFinished`, `entry`) and `RunOptions.names`/`observer`; `Trace.added`, called as each entry is recorded; `runFile` attaches the observer for the file, setup to teardown, and puts the previous hook back, never in a dry run, and reports only selected cases; `ProgressPrinter` and `setProgressWriter` (standard output by default); the summary after the last file. |
| `src/exec.ts` | **K4.3.** A step whose action throws anything fails with a message: `thrownMessage` reads an `Error`'s message, a string as it is, and anything else as JSON or text. Before, a thrown string reached `(e as Error).message.startsWith`, which threw a `TypeError` of its own. |
| `src/schema.ts`, `src/coreCatalog.ts` (generated), `scripts/sync-core.mjs` | `bdd-suite:core` with the cut; `CORE_IMPORT`. The core is a generated module (`npm run sync-core` writes it from `spec/core.catalog.yaml`), so it travels with any bundle of the package, the VS Code extension's included (K6); a test fails when it differs from the spec's. |
| `src/index.ts` | Exports `RunObserver`, `ProgressPrinter`, `setProgressWriter`, `nameMatches`, `thrownMessage`, `CORE_IMPORT`, `CORE_CATALOG`. |
| `test/where.ts`, `samples/workspace/tests/typescript/shared/corpus-extension.mjs` | `fixture.throw`: a bare string thrown. |
| `test/conformance/*.test.ts` | Entries' `names`, `schemaRoot` (library and program validate paths, execute, session) and `progress` honoured (the progress lines read from the program's standard output, masked, compared; none without `--progress`); a `lists` test; counts 20 execute. |
| `test/unit/packages.test.ts` (new) | The unit tests the other runtimes have for the same features (13), with the lines the coverage gate needs: the default writer, the hand-back, every fallback of `thrownMessage`, the license copy. |
| `conformance/run-manifest.yaml` | `typescript` removed from `pendingIn`: only PowerShell is pending on the K0 entries now. |
| `package.json`, `LICENSE` (new) | **K4.6.** Not private; `license`, `repository` (with `directory`), `homepage`, `bugs`, `keywords`; `files` = the compiled `.js` and `.d.ts` under `dist/`, `README.md`, `LICENSE` (no source maps: they point at sources the package does not ship); `publishConfig` with `access: public` and `provenance`; `prepack` builds; `sync-core`. `npm pack`: 69 files, 82 KB, down from 195 files with tests, sources and coverage. |
| `README.md` | "Install", the one-line `suiterun`, `bdd-suite:core`, the new flags, the library form, the consumer sample by its GitHub URL. |
| `scripts/Test-PackageContents.ps1`, `packaging/bdd-suite-runtime.files.txt` | An npm tarball (`<scope>-<name>-<version>.tgz`, entries under `package/`): the 69 listed files and a `package.json` naming the package, the version, MIT, the repository, a description, and not private. |
| `scripts/local-feeds.ps1` | `-Language typescript`: `npm pack` into `artifacts/feeds/npm`, checked. |
| `samples/consumers/typescript/` (new) | **K4.8.** The greeter in TypeScript: `@bdd-suite/runtime` at the release version, `greeter.mjs`, `bin/suiterun.mjs`, `bddsuite.tests.yaml` (`node:test`), the catalog importing `bdd-suite:core`, the suites, `run-e5.ps1`, a README. |
| `src/tools/versions.ts`, `test/unit/versions.test.ts` | An `npm-dependency` kind: `set-version` moves the TypeScript consumer's pin too (14 files). |
| `.gitignore` | The consumers' `node_modules/`. |
| `.github/workflows/ci.yml` | `providers-typescript` runs `run-e5.ps1` (E1 and E5). |

## Step by step

| Step | Status | Evidence |
| --- | --- | --- |
| K4.1 `--name`, `--progress`; `names` and the observer | done | Unit tests; corpus. |
| K4.2 The progress printer | done | Unit test; corpus `progress.yml` against the transcript. A by-hand run first showed no `suite-teardown` line: the observer was detached before the teardown; fixed. |
| K4.3 Any thrown value fails its step | done | Unit test; corpus `worker-throws.yml`. |
| K4.4 Core in the package; `bdd-suite:core` | done | Unit tests; corpus `core-import`. |
| K4.5 Tests with the coverage gate; the corpus | done | Runs below. |
| K4.6 `package.json` publishable | done | 69 files. |
| K4.7 `npm pack`; E1 (TypeScript) | done | Below. |
| K4.8 `samples/consumers/typescript`; E5 | done | 11 checks. |

## Runs

| Run | Result |
| --- | --- |
| By hand, the built `suiterun`: `list --name` on `names.yml`, `run --name --progress` on `progress.yml`, `lint --binding-check --binding go` against `schema-core-import` | the three cases; the transcript's lines (after the teardown fix); E201 at 6:17 and 8:17 |
| `npm test` (runtime: build, every test, c8, the branch gate) | 160 passed; every file at 100% of lines; `progress.ts`, `trace.ts`, `coreCatalog.ts` at 100% of branches too |
| `npm run test:unit` (extension, for `versions.ts`); `check-versions` | 251 passed, 100% coverage; 14 files at 0.7.0 |
| `scripts/local-feeds.ps1 -Language typescript` | `bdd-suite-runtime-0.7.0.tgz: 69 files as listed, version 0.7.0, MIT, README, LICENSE, repository` |
| `samples/consumers/typescript/run-e5.ps1` | **E5 passed**, 11 checks: the pin and no path; `npm install` of the tarball; `node_modules` holds the packed 0.7.0, not a link, no `src/`; `suiterun generate` writes `Greeting` and `Loud`; `lint` clean through `bdd-suite:core`; `list --name '*hello'`; `run --name --progress`; `node --test` with the runtime's JUnit reporter: `says-hello` and `the-core-still-works` passed, `shouts-hello` skipped; all passed with `BDD_SUITE_ALLOW_GUARDED=1`; `--test-name-pattern` selects one |
| `npm ci --dry-run` in both TypeScript samples | both locks still agree with the linked runtime's new `package.json` ("up to date") |
| `harness/corpus.mjs` and `typescript/scenarios.mjs`, for `node`, `vitest`, `jest`, `mocha` | 8 of 8 exit 0: each 16 corpus entries and 9 sample suites, 0 differ (`worker-throws` and `core-import` through each framework; the name and progress entries command line only); scenarios 5 of 5 each |

## Open

* **CI** for K4, including the new E1/E5 step in `providers-typescript`.
* **The `node:test` E9 listing on Linux** failed once in CI (run 39504203288,
  44 listed and 44 planned, so names, not counts, differed) and passed on the
  next run (39505087947) with the same corpus; it passes here at test
  concurrency 1, 2 and 4. An intermittent order dependence, most likely in the
  runtime's `node:test` reporter, which keeps one stack of open describes for
  every file; the E9 message now names the differing entries, so the next
  failure says which. Not fixed in K4.
* **Publishing** is not part of K4. `provenance` needs npm's registry and a
  GitHub Actions publish; GitHub Packages' npm registry takes only packages
  scoped to the repository's owner (`@smartpcr`), so `@bdd-suite/runtime` goes
  to npmjs.com when the public registries are chosen.
* PowerShell stays pending on the K0 entries until K5.
