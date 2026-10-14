# Stage B3 evidence

Recorded 2026-10-14. Plan: [implementation.md, stage B3](../implementation.md#stage-b3-completion-that-knows-the-scope).

## Identity

| What | Value |
| --- | --- |
| This repository | working tree on top of `67c34e8` (stage B2), not committed |
| `os-context` | `E:\work\os\os-context` at `1d0f0e40` with local changes; the worktree session ran on a clean worktree of `1d0f0e40` |
| Programs | as in [stage B2](stage-b2.md); `Build-Schema.ps1` run by the E-B8 test in the worktree |
| VS Code | Insiders `4c6cba1504` with `redhat.vscode-yaml` |

## Unit gate

`npm run test:unit`, exit 0: 137 tests, 100 % of statements (1750), branches (844), functions (140) and lines over `src/core`, `src/config` and `src/tools`. New for B3:

* `exprCursor.test.ts`: the B3.2-1 table, 47 rows: root positions after every operator kind, `and`/`or`/`not`, ternaries and calls; paths with numeric segments; string literals holding `.` and `}`; cursors outside any expression.
* `scope.test.ts`: every scope rule and position (suite setup, `beforeEach`, `afterEach`, `teardown`, case setup, case steps, a step's own `asserts`, case `asserts`, `cleanup`, inside a meta step); nested meta exports, the depth limit and import cycles; `shapeAt` for closed, nested, list, open and table shapes; `capturePathAt`; the line contexts for `action:`, `meta:` and `with:`; `metaCompletions` with a shadowed import; the capture hover text.

## Integration (real VS Code), final build

| Session | Result |
| --- | --- |
| `oscontext` | 20 passing, 1 pending (PowerShell E-B1, blocked as recorded in stage B2) |
| `worktree` | 24 passing |
| `empty` | 1 passing |
| `untrusted` | 4 passing |

The B3 scenarios, all in the `worktree` session on a scratch suite `test/e2e/suites/_scratch-b5.yml` (removed afterwards):

* **E-B5**:
  * After `${` come the namespaces, context keys and all 21 functions, with `row` only in the table step and the outline case.
  * After `${capture.` in the second step come exactly `agent` and `cs`, never the later `later`. In the other case, only `agent`.
  * After `${capture.cs.` come exactly the `cluster.state` capture properties.
  * After `${param.` come `node` and the parameters `_lib/lifecycle.yml` declares. After `${row.` come the two table columns.
  * After `meta:` come exactly the meta steps `_lib/lifecycle.yml` declares. Inside `with:` of `select-lab` come exactly its parameters.
  * After `action:`, each of the 100 actions is offered once.
* **B3.1 item 1 record**: after `action:`, `redhat.vscode-yaml` adds **no** items on the current schema (`action` has no enum), so the extension's list is the only one. After `meta:`, the YAML extension offers its root-level key suggestions; the test separates the extension's items by their `.yml` detail.
* **E-B2 completion order**: with target `rust`, the first 24 of the 100 actions in sort order are exactly the ones Rust implements.
* **B3.4 hover**: `${capture.cs.Nodes}` names `cluster.state` at `_scratch-b5.yml:15` and type `array`.
* **E-B8 completion half**: after the catalog edit and `Build-Schema.ps1` in the worktree, key completion inside the `cluster.resume` step offers `reason` **once**, 533-559 ms after the request began. It comes from `redhat.vscode-yaml` reading the regenerated schema; the extension does not complete step parameter keys, so nothing doubles it.

## Departures

* Open capture shapes **with** declared properties (for example `lifecycle.select`, an open object declaring `id`) offer those properties. Only an open shape with nothing declared offers nothing and is "open" in hover. B3.4-3 is kept for that case; offering declared keys is strictly more useful and never wrong.
* `StepInfo` gained `withRange` and `assertsRange`, and `MetaStepDef` gained `required`. Completion uses them for the `with:` keys and for a step's own `asserts`, where its own capture is in scope.
* The `with:` key context is line-based (`withKeyPrefix`) so it works for a key being typed before the YAML parses into a map.

## Defects found while building, and the unstated decision behind each

| Found | Cause | Fix | The decision that was missing |
| --- | --- | --- | --- |
| An empty `action:`, `meta:` or `captureAs:` was indexed as the string `"null"` | the scalar check accepted a null scalar | values are taken only when not null (unit test) | A key with no value names nothing |
| After a settings change, findings showed under the old tool's name (`suiterun:powershell` while linting with Go) | a controller replaced by a rebuild finished an in-flight lint and published into the shared results and collection | a disposed controller never writes results, publishes or sets the status | Only the current controller may publish |
| Two quick settings changes could interleave two rebuilds | `onDidChangeConfiguration` started `build()` without waiting for the one already running | rebuilds are chained, one after another | Rebuilds are serialised |
| Requests made during a rebuild got empty answers | providers answered from an index whose initial scan had not finished | every provider awaits its indexer's `ready`, which exists from construction and also resolves on dispose | Providers answer from a complete index or wait for one |
| Fixture lines with only trailing spaces lost them | the file writer trims trailing whitespace | the fixture types a partial key instead of relying on spaces | Test fixtures carry no meaningful trailing whitespace |
