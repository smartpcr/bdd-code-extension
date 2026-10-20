# Stage T6 evidence: TypeScript

Plan: [docs/test-providers/implementation.md](../test-providers/implementation.md#stage-t6-typescript-p1).
Recorded 2026-10-19 on Windows 11 with Node.js 24.16.0, TypeScript 5.9, Vitest
5.0.4, Jest 30.5.2 with jest-junit 17.0.0 (the versions the T0 spike tested).
Nothing here has run in CI.

## What was built

| Where | What |
| --- | --- |
| `runtimes/typescript/src/session.ts` | **New.** `RunContext` with `createRunContext` (for `suiterun`) and `runContextFromEnv` (for a test process: `<prefix>OPTION_<FLAG>`, `TAGS`, `DRY_RUN`, `ALLOW_GUARDED`, `TRACE_FILE`, `RECORD_PATH`). `Session` (`openSession`, `openLinted`) has `cases`, `indexOf`, `isSelected`, `skipOf`, `setup` (lazy, once, shared by concurrent callers), `beforeEach`, `runCase`, `afterEach`, `recordSkipped` and `teardown`. The case lock is a promise chain: `beforeEach` waits for the case before it to be settled, `afterEach` releases it, and `teardown` waits for the last one. `flushTrace` appends the entries traced since the last flush to the trace file under a lock folder. |
| `runtimes/typescript/src/exec.ts`, `value.ts` | `runFile` keeps its signature and is now the session's operations in order. The case body is `runCaseBody`. `CaseResult` gained `reason` and `afterEachFailed` (optional on the type, always set by the session). The one-level `cloneScope` gave way to `deepClone` (rule 5). |
| `runtimes/typescript/src/generate/` | **New.** `config.ts`, the schema's checks; `globs.ts`; `plan.ts`, with identifiers, the offline-action guard over expanded steps, and plan JSON; `template.ts`, one `<Id>.bdd.test.ts` per suite for `node`, `vitest` or `jest`. The writer rewrites only what changed and removes only files with its header. `detectProvider` reads the nearest `package.json` (DEC-T10). |
| `runtimes/typescript/src/cli.ts`, `run.ts` | The `generate` verb: `--config` (repeatable), `--plan`, `--check` (exit 1 naming each stale file), `--provider`, `--out`. Its flags belong to it alone. A suite that does not lint clean refuses with its findings and exit 2. |
| `runtimes/typescript/src/testing/index.ts` | **New**, exported as `@bdd-suite/runtime/testing`. `suite(framework, extensions, import.meta.url, planned)` takes the framework's `describe`, `it`, before-all, after-all and a skip declaration, so one module serves all three frameworks. Each suite becomes a describe holding one test per case and row; a failed teardown fails the after hook. The run context belongs to the module: one per test file in each framework's default isolation, one per worker where module state is shared (DEC-T08). |
| `runtimes/typescript/src/testing/node-reporter.ts` | **New**, `@bdd-suite/runtime/testing/node-reporter`. A JUnit reporter for `node:test` that keeps a describe's own failure (a failed after hook) as a test case named after the describe; node's own JUnit reporter drops it (T0). |
| `runtimes/typescript/package.json`, `src/index.ts` | Exports `./testing` and `./testing/node-reporter`. The package root exports the session API, `runFile` and the result types. |
| `runtimes/typescript/test/` | `unit/session.test.ts` (one test per rule, the environment, `flushTrace` with its lock, `openLinted`), `unit/generate.test.ts` (golden files `test/golden/{node,vitest,jest}`), `unit/testing.test.ts` (the adapter on a fake framework, the reporter on events), `conformance/session.test.ts` (E1), `conformance/generate.test.ts` (E3). The corpus extension (`test/where.ts`) implements `fixture.append`, changing its list in place. |
| `samples/workspace/tests/typescript/` | **New** package. `shared/` holds the two configs (the sample workspace's suites, extension `@bdd-suite-sample/shop-suiterun#shop`; the corpus, extension `./corpus-extension.mjs#corpusExtension`) and the corpus extension. `generate.mjs` writes each config once per provider into `node/`, `vitest/` and `jest/`; the generated files are committed, and `generate:check` fails when one is stale. `vitest.config.mjs`, `jest.config.mjs` (ES modules, no transform) and `scenarios.mjs` (E7, E9 to E12). |
| `samples/workspace/tests/harness/corpus.mjs` | Adapters `node`, `vitest` and `jest`, each running one generated file and reading its JUnit report. `runSuite` now also receives the planned suite (Vitest names a test `<describe> > <test>`). |
| `conformance/run-manifest.yaml` | typescript removed from `pendingIn` of `capture-isolation` and of both `generate` entries; powershell is now the only runtime still pending. |

## Differences from D11, D12 and DEC-T05 as written

* **Hooks.** beforeEach, the case and afterEach run inside each test, not in the frameworks' `beforeEach`/`afterEach` hooks (the DEC-T05 row). Each framework exposes the current test's name differently in its hooks. Inside the test the outcome is the same: a test fails exactly when its case did not pass, and an afterEach failure is that test's failure (rule 4). Go and Rust do the same.
* **Skips at load time.** A case the tag filter does not select, every case of a guarded suite without the opt-in, and a dry run's cases are declared skipped when the file loads, in all three frameworks, not only Jest. One code path, and `node:test` shows the reason. Their trace entries are written in the describe's after hook, before the teardown's. If nothing in the suite will run, they are written at load, when no setup can follow. Limit: such a case is traced when its describe runs, even if a name filter would have excluded it.
* **The trace file.** In these frameworks each test file is its own run context, and several run at once. So each context appends its entries to `BDD_SUITE_TRACE_FILE` under a lock rather than writing the file whole. A run of many files gives one trace; the caller starts from no file.
* **`openSession`.** The signature is `openSession(file, suite, schema, context, guarded)`, beside `openLinted(file, shown, schema, context, guarded)`, rather than `openSession(file, context)`: the testing module reads, lints and caches schemas itself.
* **Vitest's per-worker context.** It works: the context belongs to the module, so `--no-isolate` with one worker shares it. The sample's Vitest config does not set it for guarded suites, as DEC-T08 suggests; it uses the default isolation.
* **Listing.** `node:test` has no list. E9 for it uses a dry run's JUnit report, which names every test without running one. Vitest 5's `vitest list` finds tests by parsing the source, which cannot see tests declared in a loop, so it needs `--staticParse=false` (the sample's `list:vitest` script). It also leaves out tests declared skipped, so E9 lists a guarded suite with the opt-in.
* **Jest.** The generated files carry no types, so Jest runs them as ES modules with `--experimental-vm-modules` and no transform; jest-junit's name templates are set so a test's name is its case's.
* **The reporter.** It keeps one stack of describe names for every file, because a describe's own events name the file that called `describe` (the testing module). This relies on node reporting each file's events together, as it does.
* **Mocha.** `--provider mocha` is refused; it is P2 (T10).

## Step by step

| Step | Evidence |
| --- | --- |
| T6.1 `createRunContext`, environment options | `session.test.ts`: "a test process takes its options, tags and switches from the environment under the prefix". |
| T6.2 Session with recorded failures and a case lock | `session.test.ts`, rules 1 to 10. Rule 7 starts three cases at once and the markers come out in turn, with each case's trace entries one group. The teardown waits for the last case. |
| T6.3 Deep copy; `runFile`; exports; E1, E2; `fixture.append` | E1: `conformance/session.test.ts`. E2: below. `capture-isolation` passes (14 execute entries, none pending); typescript removed from its `pendingIn`. |
| T6.4 Plan, `generate --plan`, E3 | `conformance/generate.test.ts` runs both `generate` entries; typescript removed from their `pendingIn`. |
| T6.5 Testing adapter | `unit/testing.test.ts` with a fake framework: passing and failing cases, tag and guard skips, a failed teardown, a suite that does not lint, one context per set of extensions. |
| T6.6 `node:test` template, reporter, sample, E7 | Golden files; `unit/testing.test.ts` (reporter); the corpus harness and `scenarios.mjs --provider node`. |
| T6.7 Vitest template, per-worker context, sample, E7 | Golden files; the harness and `scenarios.mjs --provider vitest`. |
| T6.8 Jest template, load-time skips, sample, E7 | Golden files; the harness and `scenarios.mjs --provider jest`. |
| T6.9 `--check`; E9 to E12 | `generate.test.ts` (writer, `--check`); `scenarios.mjs` E9 to E12 for each provider. |

## Scenarios

| Scenario | What ran | node:test | Vitest | Jest |
| --- | --- | --- | --- | --- |
| E1 | every execute entry through the session, file order and reversed, results equal to `runFile`'s | pass (runtime) | | |
| E2 | the runtime's `npm test` (unit and corpus, coverage gate); the TypeScript divergence check; `npm run test:integration` | see Runs | | |
| E3 | the manifest's `generate` list through `suiterun generate --plan` | pass (runtime) | | |
| E7 | **The corpus harness:** 14 corpus entries and 9 sample suites, one generated file per run, each outcome and the trace compared with the corpus's, and a teardown failure reported where DEC-T05 says. That is the runtime's reporter for `node:test`, a test case named after the describe for Vitest, and jest-junit's made-up "Test execution failure" case for Jest. **Name filter:** `--test-name-pattern` or `-t first` on `hooks` runs one test, one suite setup and one suite teardown, and nothing of `second`. **Default workers:** the whole corpus folder at the framework's defaults gives one trace holding every planned case exactly once. | pass | pass | pass |
| E9 | the list names every case and row of both configs exactly (`<describe> > <case>`) | pass (dry run) | pass (`vitest list --staticParse=false --json`) | pass (`--json` with a filter that matches nothing) |
| E10 | **Without the opt-in:** the three `order-placement` cases skip and its setup and teardown markers are never written, while `shipping` passes; `node:test` shows the reason with `BDD_SUITE_ALLOW_GUARDED=1`. **With it:** all three pass, with setup and teardown once. `BDD_SUITE_OPTION_STORE=outlet-7` was set, and neither the value nor any `BDD_SUITE_OPTION` name is in the generated files. | pass | pass | pass |
| E11 | the three overlap suites ten times: `node:test` with a process per file, Vitest with `--sequence.concurrent` (a file's tests start at once, so only the case lock keeps them apart), Jest at its default workers. Each case's markers are `before`, its own `start`, `end`, `after`; 12 per suite per run. | pass; 88 cross-suite overlaps | pass; 90 | pass; 72 |
| E12 | A case added to `order-placement.yml`: `generate.mjs --check` exits 1 with `stale: OrderPlacement.bdd.test.ts`; after `generate` it exits 0 and the case runs. Renamed: the new name replaces the old. An unknown action: generation exits 2 with `order-placement.yml:<line>:<col>  E104`. Afterwards the suite and the generated files are byte for byte as they were. | pass | pass | pass |

## Runs

| Run | Result |
| --- | --- |
| `npm test` in `runtimes/typescript` | tests 146, pass 146, fail 0; 14 execute entries, 0 differ, none pending; coverage gate: every file at 100% of lines, `expr.ts` and `assertion.ts` at 100% of branches |
| `node samples/workspace/tests/harness/corpus.mjs --provider node`, `vitest`, `jest` | each: 14 corpus entries and 9 sample suites checked; 0 differ |
| `node samples/workspace/tests/typescript/scenarios.mjs --provider node`, `vitest`, `jest` | each: 5 of 5 pass (E11 cross-suite overlaps in the last run: 88, 90, 72) |
| `pwsh -File conformance/Assert-DivergenceIsCaught.ps1 -Binding typescript` | PASS: a divergent TypeScript binding fails the conformance job (`equals [Up] [up]`, `equals [true] [True]`) |
| `npm run test:integration` (the sample's TypeScript binding links this runtime) | exit 0: node:test 14 of 14; extension host 28, 1, 61 and 5 passing, 0 failing |

## Open

* E10's "options missing" clause, as in T2 to T5 (the extension API has no required options).
* A guarded suite under Vitest does not share one extension start across files (`isolate: false`, one worker), as DEC-T08's tradeoff suggests; the sample uses the default isolation.
* CI has not run any of this.
