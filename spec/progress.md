# Run progress and the run observer

What `suiterun run --progress` prints while a run is going, and what a library's
**run observer** may see and do. Both exist for runs that take hours (a lab
run of many suites), where the people and tools watching need to know which
case is running and how the finished ones went before the report is written
at the end (docs/packages, DEC-P05).

## The run observer

Every runtime's library lets a caller attach an observer to a run. It is told:

* **a case started**: the suite's name (its `suite:` key, else the file's name
  without its extension) and the case's name;
* **a trace entry was recorded**: the entry, exactly as the trace holds it, as
  soon as it is recorded;
* **a case finished**: the suite's name and the case's result (name, status,
  reason, message, duration).

Rules:

1. **An observer sees the run; it cannot change it.** A run with an observer
   produces the same results, the same trace and the same report as one
   without. A runtime calls the observer outside any lock the trace holds, so a
   slow observer delays the run but never corrupts it.
2. **Only selected cases are reported.** A case the tag or name filter leaves
   out was never part of the run: no "started" or "finished" for it. Its
   `skipped` trace entry still exists, and the observer is told of it like any
   entry.
3. **A dry run reports no case.** It traces nothing (session rule 10), so the
   observer hears nothing either.
4. **An exception an observer throws** is the caller's defect; a runtime need
   not catch it.

## The progress lines

`run --progress` attaches an observer that writes one line per event to
**standard output**, as it happens, flushing after each line. Run output that
was already on standard output (the closing summary of failed tests) is
unchanged and comes after the progress lines. The shape is TAEF's console
shape, which existing lab tooling parses:

```text
    suite-setup   step 1 (core.record) passed
StartGroup: progress::the-passing-case
    step          when it records (core.record) passed
EndGroup: progress::the-passing-case [Passed] (0s)
StartGroup: progress::the-failing-case
    step          when it fails (core.fail) failed [action]
    failure: the case failed on purpose
EndGroup: progress::the-failing-case [Failed] (0s)
    suite-teardown step 1 (core.noop) passed
Summary: Total=2, Passed=1, Failed=1, Blocked=0, Not Run=0, Skipped=0
```

| Line | When | Shape |
| --- | --- | --- |
| Step line | every trace entry whose phase is not `case`, including suite setup and teardown | four spaces; the phase padded on the right to 13 characters; a space; the entry's `step`; then ` (<action>)` unless the step already contains `(<action>)` or the entry has no action; a space; the entry's `status`; then ` [<reason>]` when the entry has a reason |
| `StartGroup` | a selected case starts | `StartGroup: <suite>::<case>` |
| `failure` | a selected case finished `failed` or `error` with a message | four spaces, `failure: `, the message with every line ending replaced by a space |
| `EndGroup` | a selected case finished | `EndGroup: <suite>::<case> [<verdict>] (<seconds>s)`; the verdict is `Passed`, `Skipped`, or `Failed` for any other status; seconds are the case's duration rounded to a whole number |
| `Summary` | once, after the last file of the run | `Summary: Total=<t>, Passed=<p>, Failed=<f>, Blocked=0, Not Run=0, Skipped=<s>`, counting the selected cases of every file, `t = p + f + s` |

The order is the run's: a file's suite-setup lines come before its first
`StartGroup`, each case's lines between its `StartGroup` and `EndGroup`, and its
teardown lines after its last `EndGroup`. Without `--progress` nothing of this
is printed.

**What the corpus compares.** `conformance/execute/progress.expected.txt` holds
the lines for `execute/progress.yml`. A runtime compares its lines with it
after masking what the contract leaves free: the text after `failure: ` becomes
`*` and every `(<n>s)` becomes `(*s)`, because message wording and durations
are not part of the contract (diagnostics.md).

## The action worker

Where a runtime runs an action on a worker (a thread, a goroutine, a
runspace) under a time limit, **anything the action throws or panics with is
that step's failure**, with its message, reason `action`; it never ends the
process, and the run goes on to the case's cleanup, the next case and the
teardown as for any failed step (docs/packages, DEC-P06). That includes a
thrown value that is not an exception object (TypeScript), a panic (Go,
Rust), an exception type the runtime does not name (C#) and an exception of
any .NET type thrown from a PowerShell action. A condition no runtime can
catch reliably (out of memory, a stack overflow, a Rust panic under
`panic = "abort"`) still ends the process. `conformance/execute/worker-throws.yml`
proves it with `fixture.throw`, which each runtime's corpus test extension
implements with the most unusual failure its language has.
