# Stage B7 evidence

Recorded 2026-10-14. Plan: [implementation.md, stage B7](../implementation.md#stage-b7-the-typescript-binding-in-os-context).
Scenarios: [E-B12](../design.md#e-b12-the-typescript-binding-passes-the-whole-conformance-corpus) (local half passed; CI half waits for a push) and [E-B13](../design.md#e-b13-the-typescript-binding-runs-the-portable-stage-0-cases-on-a-lab-with-the-same-report-as-go) (not run: no lab). The TypeScript halves that B1, B4 and B6 deferred to this stage are recorded at the end.

## Identity

| What | Value |
| --- | --- |
| `os-context` | a new worktree `E:\work\os\os-context-ts`, local branch `typescript-binding`, from `main` at `7633e176`. **Nothing is committed or pushed**: the binding is untracked and 19 tracked files are modified (`git diff --stat`: 318 insertions, 153 deletions). The main checkout `E:\work\os\os-context` was not touched. |
| The binding | `test/e2e/bindings/typescript`: 59 files outside `node_modules`, `dist`, `dist-test` and `coverage`; 4,373 lines of source under `src`, 2,539 of tests and scripts |
| Toolchain | Node 24.16.0, npm 11.13.0; `typescript` 5.9.3, `yaml` 2.9.1, `ajv` 8.20.0, `c8` 10.1.3, `@types/node` 24.19.1 (from `package-lock.json`; `npm ci` from the lock file succeeds) |
| This repository | `087dc40` plus uncommitted changes to the integration tests (below) and the plan |
| Other programs (for the extension's scenarios) | Go through `go run`; Rust `target/debug/suiterun.exe` and C# `artifacts/bin/.../suiterun.exe` built in the worktree for this stage (build output only, ignored by git) |

## What changed in `os-context` (all in the worktree)

| Step | Files |
| --- | --- |
| B7.1 admission | `test/e2e/schema/actions.catalog.schema.json` (both enums, the description), `scripts/e2e/SuiteLint.psm1` (`ValidateSet`), `test/e2e/conformance/expectation.schema.json` (`powershell, csharp, go, rust, typescript`), `actions.catalog.yaml` top-level `bindings`, `suite.schema.md` regenerated |
| B7.1 to B7.7 | the package `test/e2e/bindings/typescript/` (new) |
| B7.5, B7.7 | `actions.catalog.yaml`: `typescript` on the 6 core actions and `wait`, then on the 18 lifecycle actions (24 in all), `suite.schema.md` regenerated |
| B7.7 item 7 | `docs/e2e/yml_suite_implementation.md`: open question 5's pause wording corrected; open questions 6 to 10 added |
| B7.8 | `.github/workflows/{suite-conformance,e2e-tests,suite-lint}.yml`, `test/e2e/conformance/Assert-DivergenceIsCaught.ps1`, `docs/e2e/Docs.Tests.ps1`, `scripts/e2e/{LifecycleBudgetSupport.psm1,LifecycleBudgetSupport.Tests.ps1,LifecycleSetSegment.psm1}`, `CLAUDE.md`, `.claude/context/tests.md`, `docs/e2e/yml_suite_design.md` (intro, 3.1, 3.2, 6.1, 6.2), `test/e2e/conformance/README.md`, `test/e2e/schema/README.md` |

All of these were checked to be ASCII only.

## The package gate (`npm test`)

`npm test` builds, runs every unit and conformance test under `c8`, and then `scripts/check-branches.mjs`, which fails below 100 % of lines for any file or below 100 % of branches for `expr.ts` and `assertion.ts`. Final run, exit 0:

* **126 tests, 126 passed.**
* All files: 100 % of lines (statements 100 %, functions 99.65 %, branches 97.38 % overall); `expr.ts` and `assertion.ts` at 100 % of branches.
* The last gap closed was one line in `src/lifecycle/stream.ts`: the closing brace after an infinite retry loop, which no input reaches. The loop became a recursive retry with the same pauses rather than an ignore comment.

## E-B12, local half (B7.1 to B7.6, and B7.7's catalog check)

| Family | Result | Test |
| --- | --- | --- |
| Command line (B7.1-1, B7.1-2) | every verb and flag; each refusal exit 2 with the usage; `actions --json` printed `[]` until B7.5 and now the 24 names | `test/unit/cli.test.ts` |
| Manifest | every file the manifest names exists; every file under `validate/` and `execute/` is an entry or support | `test/conformance/manifest.test.ts` |
| Validate (B7.2-1, B7.4-1) | **48 of 48** entries through `createLinter()`, **46 of 46** through the program (the two catalog-overlay entries are library-only, as in Go): codes, severities, order, lines, columns, exit code | `test/conformance/validate.test.ts` |
| Expressions (B7.3-1) | **276 of 276** rows: value and type, int and float distinct, or code | `test/conformance/tables.test.ts` |
| Assertions (B7.3-1) | **96 of 96** rows | `test/conformance/tables.test.ts` |
| Execute (B7.5-1) | **11 of 11** entries: trace and exit code; `hung-step.yml` inside its `maxSeconds` | `test/conformance/execute.test.ts` |
| Reports (B7.6-1) | **7 of 7** stored reports canonicalise equal; three runs canonicalise identical | `test/conformance/report.test.ts` |
| Catalog (TS-6, B7.5-2, B7.7-2) | the registered names equal the catalog's `typescript` set: 6 at B7.5, **24** at B7.7 | `test/conformance/catalog.test.ts` |
| Coverage | as above | `scripts/check-branches.mjs` |

**`os-context`'s own gates after the admission edits (B7.1-3).** `Schema.Tests.ps1`: 14 passed. `Build-Schema.ps1 -Check`: exit 0. `SuiteLint.Tests.ps1` and `Conformance.Tests.ps1` **fail on the clean tree** at `7633e176` (the PowerShell 7.6.7 `Test-Json` defect, [stage B2](stage-b2.md)), and after the edits they fail with the same tests and no others. So B7.1-3 is **blocked, not passed**, for those two files.

## B7.7, lifecycle actions (loopback, no lab)

Every test runs against `http.createServer` on port 0 (`test/unit/lifecycle/`):

* **One test per action** (18): route, method, body and capture shape, as the table in the plan says. A missing `runId` fails "This step needs a captured runId."; a run id that is not 32 lowercase hex characters is refused before any request.
* **`request()`**: the `{success, data}` envelope; a byte-order mark stripped; `expectedStatus` as a number, as a list (DEC-B17) and refused; the route guard (`/labs` then end, `/` or `?`, no `..`); credentials re-read on every call.
* **Stream**: drop and resume from the cursor, `lagged`, an `error` frame, an unknown frame, the quiet window; `Last-Event-ID` sent when known.
* **Retry window (DEC-B18)**, under an injected clock scoped to each test: a server that refuses for 12 s and then accepts is resumed from the cursor; one that refuses past the window fails with the attempt count (pauses `min(30, 5 x n)`, 75 s in total for the first five); an HTTP 500 is not retried.
* **TS-3** (`redact.test.ts`): a run with a connection file holding three passwords, against an API that echoes them back once as captured data and once in a refusal. None of the three appears in stdout, the trace or either report (NUnit 3 and JUnit); `[redacted]` appears in their place.

**B1.4-1 re-run** (the extension's unit test against the worktree, `OS_CONTEXT_ROOT=E:\work\os\os-context-ts npm run test:unit`): `typescript: 26 files, 24 declared, 24 found`; 179 tests, 179 passed. (At B7.5 it found 6 of 6.)

**E-B13: not run.** No lab was available for this stage; the user chose to build without one (2026-10-14). The local half (TypeScript and Go runs of `lifecycle-stage0.yml --tags portable` against a lab, reports compared, passwords searched for) and the workflow half both stay open. Nothing in this stage touched a lab.

## B7.8, CI and documentation

* **Workflows** (parsed with `yaml` after editing): `suite-conformance.yml` jobs `powershell, rust, go, csharp, typescript, divergence`; the `typescript` job is checkout, `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (v4.4.0, the SHA read with `git ls-remote` on 2026-10-14) with Node 24 and the npm cache keyed on the package's lock file, `npm ci`, `npm test`. The `divergence` job installs Node and runs the check for `go` and then `typescript`. `e2e-tests.yml` offers `powershell, rust, go, csharp, typescript`.
* **B7.8-2, locally.** `Assert-DivergenceIsCaught.ps1 -Binding typescript`: the assertion table was green before; with `equals` made case-sensitive it failed on `equals [Up] [up]` and `equals [true] [True]`; the script printed `PASS`, and `src/assertion.ts` had the same SHA-256 before and after. `-Binding go` (the default, unchanged for the existing job) also passed. This is a local run, not the CI job.
* **B7.8-3.** `Docs.Tests.ps1`: 14 passed after the prose edits. `LifecycleBudgetSupport.Tests.ps1` and `Docs.Tests.ps1` together: 101 passed, including a new assertion that a budget exclusion left in `test/e2e/bindings/typescript/src/exec.ts` is refused.
* **B7.8-1 and B7.8-4: open.** Both need the changes pushed (the user's step; nothing was committed, pushed or dispatched), and B7.8-4 also needs a lab.

**Found, not changed.** In `e2e-tests.yml` the Rust, Go and C# branches run from inside their binding directory but pass the suite glob, which the input describes as relative to the repository root, unchanged. Go's `paths.Resolve` joins a relative pattern to the working directory, so those branches appear to look for the suite under the binding directory. The TypeScript branch makes the glob absolute. The others were left alone because they are outside this stage and were not run on a runner here; this belongs to the `os-context` owners.

## Open questions filed in `os-context` (B7.7 item 7)

Added to `docs/e2e/yml_suite_implementation.md`, each checked against the source before it was written:

| # | Finding | Where it was read |
| --- | --- | --- |
| 5 (corrected) | PowerShell pauses `min(30, 5 x n)` s (5, 10, 15, 20, 25, 30), not "5, 10, 20, 30 s"; TypeScript retries the same way | `LifecycleStream.psm1` line 144 |
| 6 | Go reads a list `expectedStatus` as the default, so `[200, 202]` on a submit expects 202 | `statusOf` in `internal/lifecycle/actions.go` |
| 7 | Go redacts only request errors; `Secrets()` has no caller outside tests, so an echoed secret a step captures reaches the trace and report | `internal/lifecycle/lifecycle.go` |
| 8 | Go's `wait` with `seconds` is a bare `time.Sleep` and cannot be cancelled | `internal/exec/exec.go` |
| 9 | Go refuses `\0` to `\9` as a backreference, PowerShell and TypeScript `\1` to `\9`; a `\0` row in the assertion table would decide it | `assertion.go` line 28, `Assertions.psm1` line 26 |
| 10 | Integer arithmetic past 2^53 is not pinned by the corpus; three rows proposed | (the arithmetic decision below) |

## Departures and decisions recorded

* **Go-faithful where the corpus is silent:** the whole step is expanded before it runs; the row stays in scope across steps; `and` and `or` evaluate both sides; a meta's exports are recorded at the later use (open question 4); `W301` for an unread export is at 1:1; `until` takes one assertion.
* **Not copied from Go:** a list `expectedStatus` (DEC-B17), redaction of the trace and reports (TS-3), the stream retry window (DEC-B18), a cancellable `wait`.
* **Arithmetic.** Integers stay exact `bigint` within plus or minus 2^53; beyond that, results follow Go, Rust and C# (computed in 64-bit floats, an integer when whole and below 9.2e18), so `9223372036854775807 + 1` is a float. `int()` of an out-of-range float is `E307`.
* **`unportable()`** follows PowerShell's list (open question 9) plus inline flag groups, which no suite uses.
* **Lifecycle handlers** take `(request)` and read the context from `request.lifecycle`, so every handler has the one shape the extension's recognizer `\baction\(\s*'name'\s*,\s*handler\)` finds, and the anchor `export const lifecycleActions: readonly Registration[] = [` that B5.5 inserts after is kept.
* **`lab()`** refuses a lab id that is not 32 lowercase hex characters, with the friendly-name hint.
* **Lock file:** `package-lock.json` is part of the package (reproducible CI), unlike Rust's `Cargo.lock`, which the repository ignores.
* **`npm ci` warning:** `glob@10.5.0` is deprecated; it comes in through `c8`, a dev dependency, and is not in what the program loads.

## The TypeScript halves deferred to B7 (this repository)

The scenarios still run against a checkout without the TypeScript binding: each test adds the TypeScript expectation only when `test/e2e/bindings/typescript/src` exists (`hasTypeScript()` in `test/integration/suite/helpers.ts`). The `worktree` session builds its disposable checkout from `HEAD`, which does not hold the uncommitted binding, so the harness gained an opt-in `BDD_WORKTREE_INCLUDE_CHANGES=1` that copies the checkout's modified and untracked files (not ignored ones) over the disposable worktree. It creates no commit and no ref.

Run: `OS_CONTEXT_ROOT=E:\work\os\os-context-ts BDD_WORKTREE_INCLUDE_CHANGES=1 BDD_SESSIONS=oscontext,worktree BDD_FILES=navigation,coverage,testing.test npm run test:integration`, exit 0. The node-level E-B1 and B2.5 tests that run first in that script passed for Go, Rust and C#; PowerShell's E-B1 stayed **blocked, not passed** (the `Test-Json` defect, [stage B2](stage-b2.md)).

| Session | Result |
| --- | --- |
| `oscontext` | **19 passing**, none failing or pending |
| `worktree` | **2 passing**; the disposable worktree was removed afterwards |

* **E-B3, TypeScript half (B1.4, closed by B7.5 and B7.7).** Go to Definition on `action: lifecycle.get` in `lifecycle-stage0.yml` gives six locations: the catalog entry, PowerShell, C#, Go, Rust, and `action('lifecycle.get', lifecycleGet)` in `test/e2e/bindings/typescript/src/lifecycle/actions.ts`. On `action: wait` it gives six, the TypeScript one `action('wait', wait)` in `src/actions/core.ts`. `cluster.state` still gives exactly the catalog entry and PowerShell.
* **E-B7, TypeScript row (B4.1, B4.2, B4.3, closed by B7.1, B7.5 and B7.7).** With five bindings:
  - the binding table's rows were `PowerShell 100/100, C# 24/24, Go 24/24, Rust 24/24, TypeScript 24/24`, with no drift;
  - every program's `actions --json` equals the catalog's set and Found (`TypeScript 24`);
  - a failing C# program leaves the other four, TypeScript included, agreeing.
  - **Drift:** deleting `action('lifecycle.get', lifecycleGet),` showed "declared, not registered" **82 ms** after save, and restoring it cleared the drift (Rust in the same run: 157 ms).
  - *Copy binding table* read the table back from the system clipboard on this run. That closes the clipboard check that [stage B6](stage-b6.md) recorded as blocked by the environment.
* **E-B9, TypeScript run (B6.2, B6.3, closed by B7.6).**
  - Under `typescript` as the target, the dry run of `gherkin.yml` marked every case skipped "would run (dry run)" and wrote no record.
  - The normal runs gave all 7 items their expected trace's state, with the failing step's sentence and `got 'Up'` in the message and `case setup: step 1 (core.fail) failed (action)` for the hook.
  - **The 5 bindings produce the same item results.**

E-B1's TypeScript half (B8.3) and B5.5 are not part of this stage. B5.5 is now unblocked: B7.5 and B7.7 are in place in the worktree.
