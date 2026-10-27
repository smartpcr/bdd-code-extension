# Step events and cancel

What `suiterun run --events <file>` writes while a run is going, what a
library's **step observer** sees, and how a run is asked to stop. Both exist
for hosts that show a run live and keep its history, such as a dashboard that
draws each step's status on the line of YAML that declares it.

The trace (the conformance contract) names a step only by a label such as
`when the order is placed (shop.order) row 2 (sku=PEAR)`, with no start time,
duration, value or message, and two steps with one sentence, or one meta step
used twice, share a label. The events add what a host needs: a stable **step
id**, the **file and line** the step is written on, timings, the message, the
captured value and each assertion's operands. The trace and `--progress` are
unchanged by them.

Implemented by the C# runtime first; the schema of a line is
[events.schema.json](events.schema.json).

## The step reference

Every step event carries a reference:

| Field | What it is |
| --- | --- |
| `id` | the step's address, below |
| `phase` | the trace's phase: `suite-setup`, `before-each`, `case-setup`, `step`, `case-cleanup`, `after-each`, `suite-teardown` |
| `case` | the case the step ran for, named as the report names it (an examples row carries its row in the name); absent for the suite's setup and teardown |
| `examplesRow`, `tableRow` | the examples row of the case and the table row of the step, from zero; absent when none |
| `keyword`, `sentence` | the Gherkin keyword (an `and` resolved to the keyword it continues) and the sentence, when the step has one |
| `action` | the action that ran |
| `label` | what the trace calls the same step, so the two can be joined |
| `file` | the file the step is written in, as the runner opened it: the suite, or the library a meta step was imported from |
| `line`, `column` | where the step begins in `file`, one-based; absent when unknown |

### The step id

```text
<list>/<index>[/<meta>/<index>]...[/forStep]...[#row<n>][@table<n>]
```

* `<list>` is the list the step is in: `suiteSetup` (the suite's `setup`),
  `beforeEach`, `setup` (the case's), `steps`, `cleanup`, `afterEach`,
  `teardown`.
* `<index>` counts the list's items from zero, as written, before anything is
  expanded.
* For a step that came from a meta step, `/<meta>/<index>` follows the use
  site's index: the meta step's name (a `/` in it written `%2F`) and the step's
  index in the meta step's `steps`. Nested meta steps repeat it.
* `/forStep` is the step a `wait` polls, once per level.
* `#row<n>` is the case's examples row; `@table<n>` is the step's table row.

`steps/1/stage-update-payload/0#row2` is the first step of meta step
`stage-update-payload`, used as the second step of the case, in the case's
third examples row.

An id is stable for one file: rewording a sentence does not change it;
inserting a step before it does. It is unique within one case of one run,
except for the polled step of a `wait`, which runs once per poll under the
same id.

## The events

One JSON object per line, UTF-8, `\n`-terminated, flushed as it is written, in
the order things happened. Every line has `event` and `at` (an ISO 8601 UTC
timestamp). Fields:

| `event` | Fields besides `event` and `at` |
| --- | --- |
| `runStarted` | `version` (1), `files` (the suite files, in run order) |
| `suiteStarted`, `suiteFinished` | `suite`, `file` |
| `caseStarted` | `suite`, `case` |
| `stepStarted` | `suite`, `step` (the reference) |
| `note` | `suite`, `case`, `stepId`, `text`: what a long action says it is doing |
| `stepFinished` | `suite`, `step`, `status` (the trace's), `reason` (the trace's, when not passed), `started`, `durationMs`, `message` (when failed or skipped), `detail` (a failing action's structured evidence, when it gave one), `value` (what the action returned, when it returned), `asserts` (below) |
| `caseFinished` | `suite`, `case`, `status`, `reason`, `durationMs`, `message`, `afterEachFailed` |
| `runFinished` | `status` (`passed`, `failed`, `cancelled` or `refused`), `exitCode` |

Each item of `asserts` is one comparison: `var`, `operator`, `expected`,
`actual` (absent when the var named nothing), `present`, `holds`. They are in
order, up to and including the first that did not hold.

Rules:

1. **Every step the run reaches is started and then finished**, a step its
   guard skips included. A step the run never reaches, because an earlier one
   failed, has no events: a host shows it as not run.
2. **Only selected cases** have `caseStarted` and `caseFinished`, as with the
   run observer (progress.md). A dry run writes no event file.
3. **Every text is redacted** by the extensions' redaction, as the report's
   texts are. A redacted value that is no longer JSON is written as a string.
4. **A long value is cut.** A `value`, `detail`, `expected` or `actual` whose
   JSON is longer than 8192 characters is written as `<field>Preview` (the
   first 8192 characters) and `<field>Truncated: true`.
5. **The events never change the run.** A run with `--events` produces the same
   results, trace and report as one without.

## The step observer

A library caller gets the same events in process. In C#, an
`IRunObserver` that also implements `IStepObserver` (`StepStarted`,
`StepFinished`, `Note`) is told of each step; an observer that does not is
told nothing new. `ActionRequest.Ref` is the step being run, so an action can
key per-case state by `Ref.Case`; `ActionRequest.Note(text)` sends a `note`;
`ActionException.WithDetail(value)` attaches the `detail` a `stepFinished`
carries.

## Cancel

A host that started a run may ask it to stop:

* `--cancel-on-stdin-close`: the run is cancelled when its standard input
  reaches its end (the host closes the pipe). Opt-in, because a runner started
  with no standard input would otherwise cancel itself at once.
* `--cancel-file <path>`: the run is cancelled when that file appears. It is
  looked for four times a second; a file that is there when the run starts
  cancels it at once.

What a cancel does:

1. **The running step is cancelled.** Its action's cancellation token is
   cancelled; an action that honours it stops, and the step fails with reason
   `cancelled`. An action that does not honour it is given up on: an
   interruptible one after a moment, a non-interruptible one at once, reported
   as abandoned, its work on the far side continuing. A `wait` stops polling.
2. **The case's remaining steps do not run.** Its `cleanup` and the suite's
   `afterEach` run, each within its own limit, and are never cancelled: a
   cancel stops work; it does not stop the clean-up of work already done.
3. **No case starts after it.** Each later selected case ends `skipped` with
   reason `cancelled`; its beforeEach, steps, cleanup and afterEach do not run.
4. **The suite's teardown runs**, if its setup ran, and is not cancelled.
5. **The exit code is 1**, and `runFinished` says `cancelled`.

A cancel during the suite's setup fails the setup (every case errors) and the
teardown still runs.
