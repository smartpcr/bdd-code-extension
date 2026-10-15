# Comparing two reports

Two runs of the same suite produce two reports that differ in ways nobody cares
about and, if they differ at all, in one way everybody does. This page defines
the form both are reduced to before they are compared, so that the comparison
fails for the second reason and never for the first.

Each binding implements this in its own tests, from this definition. The
PowerShell one is `scripts/e2e/ReportCompare.psm1`.

## What is dropped

Anything that says when the run happened, how long it took, or which machine it
ran on. None of it is behaviour.

| Attribute | On | Why |
| --- | --- | --- |
| `start-time`, `end-time` | `test-run`, `test-suite`, `test-case` | When, not what. |
| `duration` | `test-run`, `test-suite`, `test-case` | How long, not what. |
| `time` | `testcase`, `testsuite` | The same, in JUnit. |
| `timestamp` | `testsuite` | The same, in JUnit. |
| `hostname` | `testsuite` | Which machine. |
| `id` | `test-run`, `test-suite`, `test-case` | A counter, and four bindings number from four places. |
| `clr-version`, `engine-version` | `test-run` | Which runtime ran it. |

Two elements go as well, for the same reason.

| Element | On | Why |
| --- | --- | --- |
| `stack-trace` | `failure` | The host runtime's, not the suite's. It names an absolute path and a line number inside the runner, so adding a comment above a `throw` changes it, and four bindings would produce four unrecognisably different ones for the same failing assertion. |
| the text of `failure` | JUnit's `testcase` | JUnit has no `stack-trace` element and puts the same thing here. The `message` attribute, which says what went wrong, is kept. |

Nothing else is dropped. In particular the counts stay: a report that says two
cases passed and one that says three have not agreed, whatever the cases were
called. So does every failure message: two runs of one suite must give the same
one, and a binding that stops saying why a case failed has changed its
behaviour.

## What is normalised

1. **Attribute order.** Attributes are written in ascending order of name,
   compared as text. XML says attribute order is not significant; four
   serialisers say four different things about it.
2. **Line endings.** Every CR LF becomes LF, everywhere, including inside text
   and CDATA. This is the difference between a report written on Windows and
   the same report written anywhere else.
3. **Trailing whitespace.** Removed from the end of every line, and the trailing
   blank lines at the end of the document are removed too. A serialiser that
   ends its output with a newline and one that does not have not disagreed.
4. **Empty text.** An element whose text is only whitespace is written as an
   empty element. `<system-out></system-out>` and `<system-out>` with a newline
   inside it are the same report.
5. **Indentation.** Two spaces per level, one element per line. The
   canonical form is a document, not a stream, so that a difference can be read
   as a diff rather than found in one long line.
6. **JSON inside a text block.** A line of captured output that parses as a
   JSON object is rewritten with its keys in ascending order. What a step
   captured is behaviour; the order a hash map happened to enumerate it in is
   not, and four bindings enumerate in four orders. The values, and the order of
   anything in an array, are untouched.

## What is not touched

Case names, class names, results, failure messages and captured output. Those
are what the comparison is for.

A message is the one place where four bindings are allowed to differ, so a
report comparison that includes messages is comparing one binding with itself
across two runs. Comparing two *bindings* is what the execute corpus is for,
and a trace holds no messages at all.

## What a suite that mints an identifier can be held to

A case that creates something gets a new identifier and a new timestamp every
time it runs, and captures them. Two runs of the *same* binding differ there,
so two bindings certainly do. Comparing such a suite means comparing everything
except the captured output: the cases that ran, their results, the counts and
the messages. `Test-ReportsEqual -IgnoreOutput` is that comparison, and it is
the honest one for a lifecycle suite. A suite whose captures are stable, which
is every suite in this corpus, is compared whole.

## The stored documents

`report/*.expected.xml` holds the canonical form of three execution fixtures in
both formats. They are regenerated the same way the expectations are, by setting
`HCI_CONFORMANCE_DUMP`, and they are read by `Conformance.Tests.ps1`.
