# Stage B6 evidence

Recorded 2026-10-15. Plan: [implementation.md, stage B6](../implementation.md#stage-b6-running-suites-from-test-explorer).
Scenario: [E-B9](../design.md#e-b9-an-offline-suite-runs-under-each-binding-and-each-case-shows-the-corpus-result), four-binding part. [E-B10](../design.md#e-b10-the-portable-stage-0-cases-run-from-the-editor-against-a-real-lab) runs in B9.3.

## Identity

| What | Value |
| --- | --- |
| This repository | working tree on top of `77f0667` (stage B4) plus the uncommitted stage B5, not committed |
| `os-context` | `E:\work\os\os-context` at `e9da5ab5`, read only: every run wrote its trace and report under the extension's storage and `core.record` only to a temporary file; the cancellation and lab-path tests ran in a disposable worktree the harness removed |
| Programs | as in [stage B2](stage-b2.md); PowerShell `Invoke-LabTestSuite.ps1` through `pwsh` 7.6.7 |
| VS Code | Insiders `4c6cba1504` |

## Facts read before wiring (plan items that say "read and record")

* **`Invoke-LabTestSuite.ps1` lab parameters (B6.4 item 5):** `-ApiUrl`, `-LabId`, `-ConnectionFile` (also `-JumpConnectionFile`, not used); tags `-Tags` (comma-separated string); one case `-TestName`; dry run `-DryRun`; `-TraceFile`, `-ResultsFile`, `-ReportFormat` (NUnit3 by default).
* **The PowerShell runner refuses to start offline** without `-ApiUrl` or `-ConfigPath` ("Pass -ConfigPath for WSFC suites or -ApiUrl for lifecycle suites."), except for `-DryRun`. `os-context`'s own corpus harness (`Conformance.Tests.ps1`) passes the deliberately unreachable `http://conformance.invalid/api/v1`; the extension passes the same for a suite that is not a lab suite.
* **The trace carries outcomes, not messages.** `case` entries hold `status` (`passed`, `failed`, `error`, `skipped`) and `reason`; failed `step` and hook entries hold the step label (keyword, sentence, action). The NUnit report holds each case's failure message (`then it reads Paused, which it does not (core.noop): expected state equals 'Paused', got 'Up'`).
* **An outline has no `case` entry of its own,** only one per row, so the outline item's result is aggregated from its rows.
* **A dry run writes an empty trace (`[]`);** its NUnit report lists each case that would run as `Skipped`, which is what the dry-run profile shows.
* **`core.record` writes only when `HCI_SUITE_RECORD_PATH` is set,** in all four bindings, which is how B6.3-1 is checked.

## Unit gate

`npm run test:unit` with `OS_CONTEXT_ROOT` set, exit 0: __UNIT__. New for B6:
* `trace.test.ts`: `outlineRowName` with strings, numbers, booleans, null, arrays; `parseTrace` refusing every non-trace (B6.2-2); `parseNUnit` with entities, CDATA and self-closing cases; `mapTrace` over **every real expected trace of the execute corpus**, read at test time, giving each `case` entry's state; the gherkin failure message; suite setup and teardown failures on the file; hook failures named by hook; the report's message added once; a partial trace (B6.5); `mapDryRun`; `aggregate`; `selectionTags`; `isLabSuite`.
* `profiles.test.ts`: `runCommand` for suiterun and PowerShell, with dry run, tags, one case, and with and without each lab value; no timeout; output streamed.
* `runTool.test.ts`: a timeout of 0 is no limit; `streamOnly` passes output on without keeping or capping it.
* `suites.test.ts`: each examples row's values in written order; suite-level tags.

## Integration (real VS Code), final build

| Session | Result |
| --- | --- |
| `oscontext` | __OSCONTEXT__ |
| `worktree` | __WORKTREE__ |
| `empty` | __EMPTY__ |
| `untrusted` | __UNTRUSTED__ |

**E-B9** (`testing.test.ts`, `oscontext`), through the TestController's run profiles (`runHandler` with a `TestRunRequest`):
* **B6.1, B6.1-1:** __DISCOVERY__ The outline's rows are named exactly as the expected trace names them (`an-outline-named-by-its-columns [node=N1, expected=N1]`, `... [node=N2, expected=N2]`); suite-level tags are on each case; a refresh keeps each item object.
* **B6.2-1 and B6.3, for each of Go, Rust, C# and PowerShell as target:** a dry run of `gherkin.yml` with `HCI_SUITE_RECORD_PATH` set marks every case and row skipped "would run (dry run)" and **no record file appears** (B6.3-1); the normal runs of `gherkin.yml` and `case-setup-fails.yml` give every item (seven) the state of its `case` entry in the expected trace, and the normal run does write the record file (the control). The outline aggregates to passed; the failing case's message carries `then it reads Paused, which it does not (core.noop)` and the report's `got 'Up'`; the failed case setup names `case setup: step 1 (core.fail) failed (action)`. **The four bindings produce the same item results.**
* **B6.2-2:** with the Go tool replaced by a program that exits 1 and writes nothing, every item is errored "no trace".
* **B6.2 item 3:** one case under PowerShell runs that case only (`-TestName`) and only it gets a result; under Go the file runs and the other cases it reports get results too.

**Cancellation and the lab path** (`testingCancel.test.ts`, `worktree`, scratch suites removed afterwards):
* **B6.5-1, Go and PowerShell:** a case sleeping 600 s is cancelled three seconds in; __CANCEL__; the extension's live-child set is empty and the case is skipped "cancelled".
* **B6.4-1, B6.4-2 (local, fake program):** a suite using `lifecycle.get` is a lab suite; with the API URL and connection file in settings, only the lab id is asked; the confirmation shows binding Go, the lab id, the API URL and exactly the two lines the program's `list` printed; answering *Cancel* starts no run (the fake program's run log stays absent, no child) and both cases are skipped "not run: the lab run was not confirmed".
* **B6.4 item 4, B6.5-2 (local, fake program):** after *Run*, the program receives `--api-url`, `--lab-id` and `--connection-file`, and the command line is in the output channel; a cancel answered *No* leaves the run's process alive and the Test Explorer run active; a cancel answered *Stop* kills it within `KILL_GRACE_MS` and marks the cases skipped "cancelled".

These two lab-path tests drive the confirmation through `SuiteTesting.ui`, not the modal dialog, and use a fake program, not a lab. They are local evidence; the **manual check** the plan asks for (the real modal appears and *Cancel* starts nothing) is recorded separately below, and E-B10 against a lab is B9.3.

## Manual check (B6.4)

__MANUAL__

## Departures

* **Results come from the trace and the report together:** the trace gives each item's state (B6.2-1 compares exactly that), the NUnit report adds the failure detail the trace leaves out, and a dry run, whose trace is empty, is read from the report.
* **A run of some cases passes `--tags` only when one tag selects exactly those cases** (`selectionTags`); otherwise the file runs whole (Go, Rust, C#) and every case the run reports gets its result, or, under PowerShell with one case, `-TestName`.
* **A declined stop is final for that run.** VS Code's cancellation token fires once, so after *No* the lab run continues to its end (or until VS Code closes, when `deactivate` kills every child, INV-5); the output says so. A later "stop now" control is not part of B6.
* **Items are updated in place** by id on each refresh, not replaced: a replaced item held by a pending run request made `createTestRun` throw, found by the first run of `testingCancel.test.ts`.
* **`runTool` gained two options:** `timeoutMs: 0` is no limit (a run has none, plan 2.6), and `streamOnly` passes output to the Test Results view without keeping or capping it, so a long run is never killed for printing.

## Defects found while building, and the unstated decision behind each

| Found | Cause | Fix | The decision that was missing |
| --- | --- | --- | --- |
| `createTestRun` threw "reading 'parent'" after a settings change | each refresh replaced every test item, so an item fetched before the rebuild was detached | items are reused by id and updated in place | A test item's identity outlives a refresh |
| `python3` in a shell step hung the turn | on this machine `python3` is the Store stub, which waits for input | not used | Scripts use node |
