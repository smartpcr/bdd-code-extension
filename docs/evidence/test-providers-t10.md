# Stage T10 evidence: editor support and Mocha

Plan: [docs/test-providers/implementation.md](../test-providers/implementation.md#stage-t10-editor-support-and-mocha-p2).
Recorded 2026-10-19 on Windows 11, Node.js 24.16.0, Mocha 11.8.0, on top of
commit `e1c4c89` with T10 uncommitted. **Status: built; locally
accepted (E14, E7 for Mocha); CI not run.** The Mocha CI loop is added to
`providers-typescript`, which has not run because nothing has been pushed.

## What was built

| Where | What |
| --- | --- |
| `src/core/testsConfigSchema.ts` | **New.** The extension's copy of `spec/tests.config.schema.json`; a unit test fails if the two differ. |
| `src/core/testsConfig.ts` | **New (D16).** `checkTestsConfig` checks a config's text against the schema: a key the schema does not have is BDD070 at the key, with the nearest spelling when one is near ("providr is not a config key ... Did you mean provider?"); every other refusal (an unknown provider, a missing `suites`, a bad pattern, YAML that does not parse) is BDD071 at the value. `testsConfigCompletion` offers the providers after `provider:`, the top-level keys a config lacks, and `output:`'s keys inside it. `offlineActionsFor` finds the nearest `bddsuite.tests.yaml` in the suite's folder or an ancestor, up to the workspace root, and returns its `offlineActions` when its globs select the suite and it lists them. |
| `src/features/testsConfig.ts` | **New.** Diagnostics (source `bdd-suite tests config`, 250 ms after typing stops, on unsaved text) and completion for every `*.tests.yaml` file. |
| `src/features/testing.ts` | A Test Explorer run takes `offlineActions` from the nearest config when there is one (and logs "offline actions from <config>"), else from `bddSuite.offlineActions`, as before. |
| `src/extension.ts` | Registers the above. |
| `runtimes/typescript/src/generate/template.ts` | **D17.** The `mocha` framework: imports `describe`, `it`, `before`, `after` from `mocha` and passes them to D12's one adapter; a skip is `it.skip`. `detectProvider` picks Mocha after Vitest and Jest when `package.json` depends on it. Golden files in `test/golden/mocha`. |
| `samples/workspace/tests/typescript` | `mocha/shop` (9 suites) and `mocha/corpus` (14 suites), generated and committed; `npm run test:mocha`; `mocha` 11.8.0 pinned. |
| `samples/workspace/tests/harness/corpus.mjs`, `samples/workspace/tests/typescript/scenarios.mjs` | `--provider mocha`: runs `mocha --reporter xunit`; reads a failed suite teardown from Mocha's `"after all" hook for "<last test>"` row; decodes numeric XML entities, which Mocha's `xunit` reporter writes. E9 lists with `--dry-run`; E11 runs with `--parallel`. |
| `.github/workflows/ci.yml` | `providers-typescript` loops over `node vitest jest mocha`. |
| Docs | The TypeScript README (Mocha's command, skip and teardown), the README's table, `CHANGELOG.md` (Mocha and the editor support), design.md (Mocha out of the non-goals, the teardown table, E7's Mocha row, E14's real config path and ten providers). |

**Why the nearest config, and only when it selects the suite.** E14 asks that
the editor and the generated tests share one offline list. A config decides
only for the suites it generates, so a config elsewhere in the tree cannot
change a suite it does not select; with no such config the setting applies
exactly as before. This keeps the B6.4 lab tests, whose scratch suites have no
config, unchanged.

## Step by step

| Step | Status | Evidence |
| --- | --- | --- |
| T10.1 Config schema contribution and validation in the extension | built; unit-tested; E14 passes | `test/unit/testsConfig.test.ts`; E14's first test. The extension validates with its own validator instead of contributing the schema to a YAML extension, so it needs no other extension and its findings carry BDD codes. |
| T10.2 `offlineActions` read from the nearest config | built; unit-tested; E14 passes | `offlineActionsFor` unit tests (nearest config decides; not selecting, not listing, an empty list, outside the root, another drive); E14's second test. |
| T10.3 Unit tests at 100%; `npm run install:local`; E14 | done | `npm run test:unit`: 245 tests pass, every covered file at 100% of lines, branches, functions and statements. E14: 2 of 2. The whole integration suite: every test passed except one unrelated flake, below. Installed with `npm run install:local`. |
| T10.4 Mocha template and sample; E7 for Mocha | built; locally accepted; CI not run | The harness and the scenarios below. |

## Runs

| Run | Result |
| --- | --- |
| `npm run test:unit` (extension) | 245 pass; c8 `--100` gate passes |
| `BDD_SESSIONS=worktree BDD_FILES=testsConfig.test.js node out-test/test/integration/runTest.js` | E14: 2 of 2 pass |
| `npm run test:integration` (extension, whole) | sample 28 pass (1 pending), empty 1, worktree 62 pass and 1 fail, untrusted 5; E14 2 of 2 inside it. The one failure: B2.4-4 (Build lint tool for Go), `EBUSY` renaming the test profile's stored `go/suiterun.exe`, so a process from an earlier test still held the file. Rerun alone (`BDD_SESSIONS=worktree BDD_FILES=lintFailures.test.js`): 9 of 9 pass, B2.4-4 included. T10 changes neither linting nor the Go program. |
| `node samples/workspace/tests/harness/corpus.mjs --provider mocha` | 14 corpus entries and 9 sample suites, 0 differ (results and traces equal the corpus's) |
| `node samples/workspace/tests/typescript/scenarios.mjs --provider mocha` | 5 of 5: E7 (a `--grep` filter runs setup and teardown once around it; the whole corpus keeps every trace entry), E9 (the `--dry-run` list names every case and row exactly), E10 (a guarded suite skips without the opt-in, runs with it), E11 (`--parallel`, ten rounds, no two cases of one suite overlap; 90 cross-suite overlaps seen, so the runs were parallel), E12 (`--check` fails until generate runs; a lint error stops generation) |
| `npm test` in `runtimes/typescript` | passes; coverage gate holds (100% of lines, statements and functions; `template.ts` 100% of branches) |
| `npm run generate:check` in the sample | every generated file up to date, Mocha's included |
| `npm run install:local` | installed `asz.bdd-suite@0.6.10` (sha256 `55603f78...902c`); open windows load it on reload |

## Not re-run

`scenarios.mjs` for `node`, `vitest` and `jest` were not re-run after the
Mocha edits. What changed for them is the numeric-entity decoding, which
changes only a name or reason that holds such an entity, and a refactor of
`every()` that gives the same paths. CI's loop runs all four.

## Open

* **CI.** The `providers-typescript` job with Mocha has not run; it runs when
  the user pushes.
* B2.4-4 can fail in a whole run on Windows when the stored Go program is still
  held by a process; it passed alone. Not fixed here.
* Still open from earlier stages: T8's CI, T9 (E13, no lab).
