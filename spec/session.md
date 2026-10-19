# The suite session

A **session** runs one suite file a phase at a time, so a test framework can
call the suite setup, one case and the teardown at moments it chooses
(`[ClassInitialize]`, `[TestMethod]`, `[ClassCleanup]`, and their equivalents).
Every runtime implements this contract in its own idiom, and its whole-file run
(`suiterun run`) is built on it, so a native test run and a `suiterun` run of
the same file produce the same results and the same trace.

This page is the contract. The design that motivates it is
[docs/test-providers/design.md](../docs/test-providers/design.md); each rule
below names the corpus entry that pins it, under
[conformance/execute/](../conformance/execute/).

## Words

| Word | Meaning |
| --- | --- |
| **Run context** | What one test process shares: the composed extensions, started once (their `start` called once, their state shared by every session), the schema, the options, the parameters, the tag filter, the dry-run flag and the trace. `suiterun` makes one per invocation; a test process makes one when it starts. |
| **Session** | One suite file inside a run context: the parsed and expanded suite, its case list, the setup's capture bag, and which phases have run. |
| **Case** | One entry of the case list: a `tests` entry, or one row of its `examples`, named `<name> [<column>=<value>, ...]`. A case is always named by that exact text. |
| **Selected** | A case the run context's tag filter selects. A case that is not selected is reported `skipped` with reason `tag` and runs nothing (`tags.yml`). |

## Operations

| Operation | What it does |
| --- | --- |
| `open(file, context)` | Parses the file, resolves imports, meta steps, params and vars, and lists the cases with outline rows expanded. Fails, without running anything, if the file does not lint clean. |
| `cases()` | The case names in file order, rows in row order. |
| `setup()` | Runs the suite setup once, into the suite capture bag. Calling it again does nothing. |
| `beforeEach(case)` | Ensures `setup()` ran, takes the session's case lock, and runs `beforeEach` for this case. |
| `runCase(case)` | Runs the case's own setup, steps, case-level asserts and cleanup, from a copy of the suite bag, and returns the case's result so far. |
| `afterEach(case)` | Runs `afterEach` for this case, settles the case's result (adding an afterEach failure to it), writes the case's `case` trace entry, and releases the case lock. |
| `teardown()` | Runs the suite teardown once, on the suite bag, if `setup()` ran. Calling it again does nothing. |
| `trace()` | The trace entries so far, in the shape of `conformance/expectation.schema.json`. |

A **case result** has the same fields in every runtime: `name`, `status`
(`passed`, `failed`, `skipped`, `error`), `reason` (the trace's reason, when
not passed), `message`, `output` and `durationSec`. A **teardown result** has
`status` (`passed` or `failed`) and `message`.

## Rules

1. **Order.** For one case the phases run beforeEach, case setup, steps,
   case asserts, case cleanup, afterEach; the suite setup runs before the first
   case and the teardown after the last (`hooks.yml`). A framework calls the
   operations in this order; a session given another order for one case
   (`runCase` before `beforeEach`, say) refuses it with an error naming the
   operation, rather than running phases out of order.

2. **Setup is lazy and runs at most once.** `setup()` may be called by a
   class-level hook, by `beforeEach`, or not at all. It runs only if at least
   one selected case is about to run: a session in which no case was selected
   runs neither the setup nor the teardown, and reports every case `skipped`
   (`nothing-selected.yml`).

3. **Initialize hooks record, the case reports.** `setup()` and `beforeEach()` never throw
   for a step that fails; they record the failure, and the next `runCase()`
   reports it as that case's result, exactly as a whole-file run does:
   * a failed suite setup makes every selected case `error` with reason
     `suite-setup`, and none of their phases run (`setup-fails.yml`);
   * a failed beforeEach or case setup makes that case `failed` with reason
     `hook`; its case cleanup and afterEach still run; other cases are
     unaffected (`case-setup-fails.yml`).

   So a framework that skips its test body, or its cleanup hook, after an
   initialize hook throws cannot change a result: the initialize hooks do not
   throw.

4. **afterEach always follows beforeEach, and settles the case.** Once
   `beforeEach(case)` was called, `afterEach(case)` runs the afterEach block
   whatever happened in between. A failed case cleanup has already made the
   case `failed` with reason `cleanup`; a failed afterEach makes it `failed`
   with reason `hook`, its message appended, as a whole-file run does. The
   case's `case` trace entry is written here, after afterEach, which is where
   a whole-file run writes it (`hooks.yml`). If afterEach failed, `afterEach`
   reports it by throwing: it is the last per-case hook, so nothing a
   framework skips after it can change a result, and every framework shows a
   failure in its per-test cleanup hook as that test's failure.

5. **Each case starts from its own deep copy of the suite bag.** Nothing a case
   does, including an action changing in place a nested value it was given,
   reaches another case or the teardown (`capture-isolation.yml`).

6. **Teardown runs on the setup's bag, once, if setup ran,** after the last case
   the framework ran, whether cases passed (`setup-fails.yml`,
   `teardown-fails.yml`). Besides `afterEach` (rule 4), it is the only operation
   that reports a failure by throwing (or the language's equivalent), because a framework shows a
   class-level cleanup failure as a failure of the run, not of a case: a
   failed teardown fails the run and never turns a passed case into a failed
   one (`teardown-fails.yml`). The whole-file run still adds it to its report as
   the extra entry named `teardown`.

7. **Cases of one session never overlap.** The case lock is held from
   `beforeEach` to `afterEach`, so even a framework running test methods in
   parallel runs one case of a suite at a time. Different sessions may run in
   parallel; the trace and every counter they share are safe for that.

8. **Selection belongs to the run context and the framework.** A framework
   decides which cases it runs by name; the run context's tag filter
   (`BDD_SUITE_TAGS`, or `--tags`) additionally makes a case `skipped`. A case a
   framework never runs is neither reported nor traced.

9. **Guarded suites need an opt-in.** A session whose suite the test plan marks
   guarded ([test-plan.md](test-plan.md)) reports every case `skipped` with the
   message `guarded suite: set BDD_SUITE_ALLOW_GUARDED=1 to run it`, and runs no
   phase, unless the run context allows guarded suites. `suiterun` allows them;
   a test process allows them only when `BDD_SUITE_ALLOW_GUARDED=1`.

## Inputs a test process takes from the environment

`<prefix>` is the extensions' environment prefix, `BDD_SUITE_` by default.

| Variable | What it supplies | `suiterun` equivalent |
| --- | --- | --- |
| `<prefix>PARAM_<NAME>` | A suite parameter (already read by every runtime). | `--param NAME=value` |
| `<prefix>OPTION_<FLAG>` | An extension option: the flag without its leading dashes, upper-cased, `-` becoming `_` (`--api-url` is `BDD_SUITE_OPTION_API_URL`). | `--api-url value` |
| `<prefix>TAGS` | The tag filter, comma-separated. | `--tags` |
| `<prefix>DRY_RUN` | `1` for a dry run. | `--dry-run` |
| `<prefix>ALLOW_GUARDED` | `1` to run guarded suites (rule 9). | always allowed |
| `<prefix>TRACE_FILE` | Where the run context writes the trace when the process ends. | `--trace-file` |
| `<prefix>RECORD_PATH` | Where `core.record` appends (unchanged). | the same variable |

Generated test code never contains any of these values.
