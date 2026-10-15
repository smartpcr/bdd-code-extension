# Stage B8 evidence

Recorded 2026-10-15. Plan: [implementation.md, stage B8](../implementation.md#stage-b8-lint-while-typing-through-the-typescript-binding).
Scenarios: [E-B11](../design.md#e-b11-a-missing-slow-or-broken-lint-tool-is-reported-not-hidden) (typescript half), [E-B14](../design.md#e-b14-an-unsaved-buffer-gets-the-same-diagnostics-the-saved-file-would), [E-B15](../design.md#e-b15-in-an-untrusted-workspace-no-binding-code-runs) (worker half), and [E-B1](../design.md#e-b1-the-editor-shows-exactly-what-the-corpus-says-lint-must-find) with the `typescript` tool.

## Identity

| What | Value |
| --- | --- |
| This repository | `584ed29` ("stage B7: wip", committed by the user) plus the uncommitted B8 changes listed below |
| `os-context` | the B7 worktree `E:\work\os\os-context-ts` (branch `typescript-binding`, `7633e176` plus the uncommitted binding); every editing scenario ran in a disposable worktree of it, with `BDD_WORKTREE_INCLUDE_CHANGES=1` so the uncommitted binding is present, and the harness removed it afterwards |
| The library | `test/e2e/bindings/typescript/dist/index.js`, `apiVersion` `1.0.0`; in each disposable worktree it was built by *Build lint tool* (`npm ci && npm run build`) |
| Node | 24.16.0 for the unit and node-level tests; the editor's own Node (24.21.0) for the worker in VS Code |
| VS Code | Insiders, as in earlier stages |
| Machine | 13th Gen Intel Core i9-13900K, 32 logical CPUs, Windows 11 |

## What was built

| Step | Files |
| --- | --- |
| B8.1 | *new*: `src/lint/protocol.ts` (message types only), `src/lint/worker.ts` (bundled as `dist/lintWorker.js`), `src/lint/workerHost.ts`, `test/fake-library/index.mjs`, `test/unit/workerHost.test.ts`, `test/integration/node/workerParity.test.ts`, `test/integration/suite/worker.test.ts`; *edit*: `esbuild.mjs` (second entry), `src/features/lintController.ts` (`ProgramBackend` and `WorkerBackend` behind `LintBackend`), `src/extension.ts` (one host per window, `TestApi.lintWorker`, `deactivate()` disposes it), `package.json` (`workerHost.js` in the 100 % gate), `test/integration/suite/trust.test.ts` |
| B8.2 | *edit*: `src/core/diagnostics.ts` (`selectOverlays()`), `src/core/workspaceIndex.ts` (`importersOf()`), `src/features/lintController.ts` (live trigger, overlays, importers); *new*: `test/integration/suite/liveLint.test.ts` |
| B8.3 | *new*: `test/integration/suite/latency.test.ts`; *edit*: `src/config/defaults.ts` and `package.json` (`lintTool` default `typescript`), `test/integration/suite/lint.test.ts` (E-B1 with `typescript`), `docs/design.md` (DEC-B04) |

`profiles.ts` and `defaults.ts` needed nothing for B8.1: the `typescript` binding already had its build command and `library` setting (B1).

## Decisions made while building

* **The library is loaded with a dynamic `import()` that `tsc` cannot rewrite.** `worker.ts` is compiled to CommonJS for the unit tests, where `import()` becomes `require()`, which cannot load the library's ES module by file URL. It uses `new Function('specifier', 'return import(specifier)')`; esbuild's bundle keeps the same.
* **The test library reads `workerData` itself.** The plan said the worker would set `globalThis` flags from `workerData`; instead `test/fake-library/index.mjs` imports `workerData` directly, so the shipped worker carries no test hook.
* **A library change reloads the worker (added).** A loaded worker keeps the library it imported, so a rebuild, or E-B11 breaking `dist/index.js`, would otherwise go unseen. The controller watches `**/*.js` beside the library and calls `host.reload()`, which marks the loaded copy old: requests already running finish on it, and the next lint starts a new worker. A lint waiting on a worker that another start replaced waits on the new one rather than failing. The first version terminated the worker at once; a late watcher event from a build then killed a starting worker, and E-B11 reported "worker stopped" (found by the integration run, fixed, and covered by a unit test).
* **"Paused until the next save" is "until the next lint that is not live".** Three failures in a row refuse live lints with "Lint paused after 3 failures; save to retry"; a lint on open or save still runs, and any answer resets the count.
* **Every failure has its own status:** `Lint: typescript not built`, `... library did not load`, `... library speaks API 2.0.0; this extension speaks 1.x`, `Lint timed out after 5 s`, `... worker stopped`, `... library failed`, `Lint paused ...`.
* **Overlays use the index's lint-candidate test,** so a dirty file that does not parse is still sent and gets its `E100`.

## Unit gate

`npm run test:unit` with `OS_CONTEXT_ROOT` set to the worktree, exit 0: **197 tests, 197 passed, none skipped; 100 % of statements, branches, functions and lines** over `src/core`, `src/config`, `src/tools` and `src/lint/workerHost.ts`.

* `workerHost.test.ts` drives a real `Worker` running the compiled `worker.ts` and the test library: an answer and reuse; untrusted (no worker, INV-11); a missing library; `apiVersion` `2.0.0` and none (B8.1-3, both versions in the status); a library that throws while loading and one that never loads; a library that throws, and the next lint starting a new worker; a looping library terminated within the timeout plus 1 s (B8.1-2, here with a 500 ms timeout: 1,058 ms including the second attempt); a worker that exits and one that throws outside a lint; three failures pausing live lint and an answer resuming it; newest-request-wins (INV-4), while starting and while linting; another library path; reload and invalidate; dispose during a start; a stale message from a replaced worker; and **INV-12**: with every `fs` write function wrapped, a lint with an overlay never names the overlay path, and no such file appears.
* **`worker.ts` coverage (plan 3.3):** measured separately with `c8 --include out-test/src/lint/**` over the same tests: **100 % of lines and branches**, reached through `NODE_V8_COVERAGE` in the worker threads. It is not in the gated include, because a terminated worker can drop its coverage file.
* `workspaceIndex.test.ts`: `importersOf()` direct, transitive, through a cycle, and none. `diagnostics.test.ts`: `selectOverlays()`.

## B8.1-1 (node level): the worker equals the program

`test/integration/node/workerParity.test.ts`, against the worktree: for **each of the 45 E-B1 validate entries**, the bundled `dist/lintWorker.js` loading the real library gives **exactly** the diagnostics the `typescript` program prints, field for field (code, severity, file, line, column, message, suggestion). One worker served all 45.

## Integration (real VS Code), final run

`OS_CONTEXT_ROOT=E:\work\os\os-context-ts BDD_WORKTREE_INCLUDE_CHANGES=1 npm run test:integration`, **exit 0**:

| Session | Result |
| --- | --- |
| node-level (`corpusTools`, `workerParity`) | 10 passing; PowerShell's corpus check **blocked, not passed** (the `Test-Json` defect, [stage B2](stage-b2.md)) |
| `oscontext` | 34 passing, 1 pending (PowerShell E-B1, blocked as above) |
| `empty` | 1 passing |
| `worktree` | 48 passing |
| `untrusted` | 5 passing |

**E-B11, typescript half** (`worker.test.ts`, worktree): *Build lint tool* built the library in the disposable worktree (B8.1 item 4), and opening a suite linted through one worker, `E301` shown with source `suiterun:typescript`. Then, each time after typing one character:

| The library | Status | Notes |
| --- | --- | --- |
| renamed away | `Lint: typescript not built` | the "not built" prompt, as for a program |
| `apiVersion` `2.0.0` | `Lint: the typescript library speaks API 2.0.0; this extension speaks 1.x` | B8.1-3 |
| `lint()` loops | `Lint timed out after 5 s` | failed 5.5 s after the edit (400 ms debounce + 5 s); no worker left (B8.1-2) |
| `lint()` throws | `Lint: the typescript library failed` | its message in the output channel |

Each time the earlier `E301` stayed, prefixed `[stale]`, no set was replaced by an empty one, the output channel had the failure and the library path, and restoring the library and saving published again without stale marks.

**E-B15, worker half** (`trust.test.ts`, a genuinely untrusted window): with the `typescript` tool, opening, typing and linting gave "Suite: untrusted, lint and run disabled"; the controller started no lint and **the host created no worker** (`workersStarted` 0). The buffer was reverted, never saved. Granting trust then linted as in B2.6.

**B8.2 and E-B14** (`liveLint.test.ts`, worktree):
* **B8.2-1:** typing `${capture.nosuch}` into the scratch suite (which imports `_lib/lifecycle.yml` and uses its `select-lab`) showed `E301` at 9:16 **407 ms after the edit**, with the buffer unsaved and no "meta not found".
* **B8.2-2:** an unsaved rename in the imported scratch library showed `E206` at 7:15 in the open suite; undoing it cleared it.
* **B8.2-3:** with Go as the lint tool, typing for 2 s started no lint.
* **E-B14:** each of the 45 E-B1 entries' text replaced the scratch buffer, unsaved. 39 gave exactly the corpus diagnostics. The other 6 (`shared-checks-missing`, `shared-checks-complete`, `shared-checks-all-five`, `imports`, `from-library`, `bad-import`) depend on their own directory's imports, and gave exactly what the `typescript` program reports for the same text saved at the scratch path. Edit to published: p50 416, p95 420, max 426 ms. Afterwards `git status` was what it was after the scratch files were first saved, and both still held their first-saved text (INV-12).

**B8.3** (`latency.test.ts`, worktree), `lifecycle-stage1.yml`:

| Run | p50 ms | p95 ms | max ms | Cold first lint ms |
| --- | --- | --- | --- | --- |
| 1 (focused) | 419 | 429 | 440 | 198 |
| 2 (full suite) | 418 | 430 | 452 | 209 |
| 3 (final full suite) | 425 | 430 | 460 | 209 |

p95 is under O10's 1 s, so `bddSuite.lintTool` now defaults to `typescript` (DEC-B04). **E-B1 with the `typescript` tool** (`lint.test.ts`, `oscontext`): all 45 entries at the corpus positions, through the worker.

**Also passing with five bindings in this run:** E-B9 under `typescript`, E-B7 drift for the TypeScript registration (136 ms), and the scaffold scenario with `typescript` as the default lint tool.

## Test fixes this stage needed outside B8's own files

Running the whole suite against a checkout with the TypeScript binding exposed tests that assumed four bindings or the old default. Each now holds for both kinds of checkout:

* `hover.test.ts`: the label map lacked `typescript`, and `cluster.state`'s "not implemented" list now includes TypeScript when present.
* `target.test.ts`: `core.noop`'s inlay hint is `PS C# Go Rs TS` when TypeScript is present.
* `scaffold.test.ts`: sets `lintTool: go` explicitly (its E104 quick fix was written against Go's lint), and restores files that were already changed when it started by content. In a worktree with copied-in changes, `git checkout` would restore `HEAD`, and their status line does not change.
* `trust.test.ts`: restores the session's own `lintTool: rust` rather than the default.

## What this does not prove

* Everything ran against the **uncommitted** B7 binding in the `os-context` worktree. Until B7 is committed in `os-context`, a checkout without it gets the new default and shows "Lint: typescript not built"; *Choose lint tool* switches.
* One machine, Windows only. The worker, the library watcher and the latency are not measured on Linux or macOS.
* The E-B11 breakages are edits to the built library, not every way a library can fail.
* E-B14's timing is at this machine's speed; the 400 ms debounce is most of it.
