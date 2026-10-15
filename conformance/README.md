# The conformance corpus

Five runtimes run these suites, one per language, under `runtimes/`
(PowerShell, C#, Go, Rust and TypeScript; the editor extension lints through
the TypeScript one). This directory is what "the same behaviour" means. It is data, not code, so a
binding's test can read it without any glue written in that binding's language.

Nothing here needs a lab. Every suite calls only `core.*` actions, which are
pure and which every runtime implements, so a disagreement found here is a
disagreement about the format rather than about an environment. The validate
suites also name fixture actions, which only need to be declared: they are
linted, never run.

## What is in the contract

Codes, positions, phases, actions, statuses and exit codes. A binding that
finds the same problems at the same places conforms, whatever wording it uses
to describe them, which is why no expectation in this directory holds a message.
The same rule is stated for diagnostics in
[diagnostics.md](../spec/diagnostics.md) and it applies to traces too.

## The layout

| Path | What it holds |
| --- | --- |
| `schema/` | The corpus's catalog (`actions.catalog.yaml`: the core, imported, plus fixture actions), its suite-schema extension (`fixture.suite.json`: the fields `requires`, `cluster` and `target`), and the `suite.schema.json` generated from them. A runtime validates the corpus against this folder, never a workspace's. |
| `rename.json` | How the corpus became product-neutral when it moved here from os-context: the action and value renames, all of the same length so no expected position changed, and the entries handed back to os-context. |
| `run-manifest.yaml` | Every entry, and what it is for. A binding enumerates this rather than a directory, so an entry cannot be skipped quietly. |
| `expectation.schema.json` | The shape of an expectation file. Every `*.expected.json` here validates against it. |
| `validate/` | Suites that must not lint clean, each beside the diagnostics it must produce. |
| `validate/_lib/` | Libraries the validate suites import. Support files: they have no expectation of their own. |
| `execute/` | Suites that run, each beside the trace the run must emit. |
| `expressions/` | The expression language as a table: a fixed context and one row per expression. |
| `asserts/` | The assertion operator table: one row per operator per interesting pair of operands. |
| `report/` | How two reports are compared, and the canonical form of three of them. |

## An expectation

Every entry is a suite file and an expectation file beside it with the same
stem: `validate/typos.yml` and `validate/typos.expected.json`. The expectation
says which family it belongs to, what the entry is for, and what the run must
produce.

A **validate** expectation holds the whole sorted diagnostic array. The whole
one: a binding that reports the four expected findings and a fifth of its own
has not conformed, so the comparison is equality and not containment.

```json
{
  "kind": "validate",
  "suite": "validate/typos.yml",
  "description": "A misspelled key, a misspelled action and a misspelled block.",
  "exitCode": 2,
  "diagnostics": [
    { "code": "E101", "severity": "error", "line": 4, "column": 5 }
  ]
}
```

An **execute** expectation holds an ordered trace. One entry per thing the
runner did, in the order it did it, ending with the result of each case.

```json
{
  "kind": "execute",
  "suite": "execute/hooks.yml",
  "description": "The six phases run in order, once each, around two cases.",
  "exitCode": 0,
  "trace": [
    { "phase": "suite-setup", "step": "record the suite setup", "action": "core.record", "status": "passed" },
    { "phase": "case", "case": "first", "status": "passed" }
  ]
}
```

## How a binding runs the corpus

1. Read `run-manifest.yaml`.
2. For each `validate` entry, validate the suite and compare the diagnostics
   and the exit code with the expectation.
3. For each `execute` entry, run the suite with the tags and parameters the
   expectation names, and compare the emitted trace and the exit code.
4. For the expression and assertion tables, evaluate every row and compare the
   value, the type or the diagnostic code the row states.
5. For the report entries, canonicalise the report the run produced by the
   rules in `report/canonicalise.md` and compare it with the stored document.

A runtime's corpus test registers a test extension supplying the context keys
the expression table reads (`cluster`, `target`, `labId`, `apiUrl`, with the
values in `expressions/context.yaml`), because the core defines none of its
own. Each runtime's own folder says how to run its corpus test.

## Adding an entry

Add the suite, add the expectation, add both to the manifest. A file in
`validate/` or `execute/` that the manifest does not name fails the corpus
test, because an entry no binding runs is worse than no entry at all: it looks
like coverage and is not.
