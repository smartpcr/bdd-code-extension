# Suite diagnostics

Every finding a suite validator reports carries a code from this table. A code
never changes meaning. Codes and positions are the contract between the four
bindings; the wording of a message is not, so a binding may phrase a message
differently and still conform.

The machine-readable shape of a finding is
[diagnostic.schema.json](diagnostic.schema.json). The format of a suite file is
[suite.schema.md](suite.schema.md), generated from
[suite.base.json](suite.base.json) and
[actions.catalog.yaml](actions.catalog.yaml).

## The three levels

Validation is layered because the three levels need different inputs and
produce different messages (DEC-Y05).

| Level | Codes | Input | Catches |
| --- | --- | --- | --- |
| Structure | `E1xx` | the file and `suite.schema.json` | a misspelled key, a missing key, a wrong type, an unknown action, an unknown parameter |
| Semantics | `E2xx` | the parsed model and the catalog | things a schema cannot see: duplicates, ceilings, meta steps, imports, parameters |
| Dataflow | `E3xx` | the expanded model and the catalog | a reference that resolves to nothing, a path that is not in a capture's shape, an expression that does not parse |

A validator runs all three levels over one parse and reports everything it
finds. It does not stop at the first error, because an author fixing four
typos should see four diagnostics.

## The codes

### Structure

| Code | Severity | Meaning |
| --- | --- | --- |
| `E100` | error | The file is not valid YAML, or does not hold a mapping, so nothing below can be checked. The position is the start of the file: four YAML parsers stop in four places on the same broken file, so where one stopped is not something two bindings can be held to. The message may say where, and messages are not compared. |
| `E101` | error | Unknown key. The nearest legal key at that position is suggested. This is the code that catches `assert:` for `asserts:` and `timeout:` for `timeoutSec:`. |
| `E102` | error | A required key is missing. The position is the object that should carry it. |
| `E103` | error | A key has the wrong type: a string where a list belongs, an object where a number belongs. |
| `E104` | error | Unknown action name. The nearest action in the catalog is suggested. |
| `E105` | error | Unknown parameter for a known action. The action's own parameters are what the suggestion is drawn from. |

### Semantics

| Code | Severity | Meaning |
| --- | --- | --- |
| `E201` | error | The selected binding does not implement this action. The message names the action, the selected binding and the bindings that do implement it. Reported only under `--binding-check`. |
| `E202` | error | Two cases in one suite have the same name. A report cannot tell them apart. |
| `E203` | error | Two steps in one case capture the same name. The second would silently replace the first. |
| `E204` | error | An assertion names a subject and no comparison. This is what catches `equal:` being accepted as a key and then asserting nothing. |
| `E205` | error | A limit is missing where one is required, zero, negative, or above its ceiling. The message names the limit, where it was declared and the ceiling it broke. |
| `E206` | error | A case uses a meta step the suite does not declare. |
| `E207` | error | Meta steps form a cycle, or nest deeper than five. |
| `E208` | error | A meta step use site omits a required parameter or passes one the definition does not declare. |
| `E209` | error | A local declaration reuses an imported name without `override: true`. The message names the library it came from. |
| `E210` | error | A parameter has no value and no default at any level, or a `--param` names a parameter the suite does not declare. |
| `E211` | error | An imported library declares `tests` or a hook. A library declares `params`, `vars`, `metaSteps` and `defaults`, and nothing that runs. |
| `E212` | error | Gherkin keywords are misused: two on one step, an `and` with nothing before it to continue, or a keyword that goes backwards through the `given`, `when`, `then` order. |
| `E213` | error | A table or an `examples` block is empty, has rows whose columns differ, repeats a column, repeats a row, or is a step table inside a case that is already an outline. |

### Dataflow and expressions

| Code | Severity | Meaning |
| --- | --- | --- |
| `E301` | error | A `${...}` reference resolves to nothing. The legal roots are `capture`, `param`, `var`, `row` inside a table or an outline, and the bare context keys. A bare capture name is this code, with `${capture.<name>}` as the suggestion, and so is a `row` column the table does not declare. |
| `E302` | error | A dotted path is absent from the declared capture shape of the action that produced it. Only shapes the catalog closes are checked; an action whose capture shape is open, such as an API response, cannot be checked this way and is not. |
| `E303` | error | A capture is read before any step, hook or import produces it. |
| `E304` | error | A meta step exports a name that none of its steps captures. |
| `E305` | error | Syntax error inside `${ }`. The message names the offending token. |
| `E306` | error | Unknown function. The nearest function in the closed list is suggested. |
| `E307` | error | A function is called with the wrong number or type of arguments. |
| `E308` | error | A regular expression uses a construct outside the subset the four bindings share: a backreference, a lookahead or a lookbehind. |
| `E309` | error | A non-deterministic function (`env`, `uuid`, `nowIso`) is used where the value has to be stable, which is a `vars:` block the conformance corpus compares. |

### Warnings

A warning does not fail a lint. `--strict` promotes every warning to an error.

| Code | Severity | Meaning |
| --- | --- | --- |
| `W301` | warning | A capture is produced and never read, by a later step, an assertion or a cleanup. Either the step is doing nothing or an assertion is missing. |
| `W302` | warning | The action is marked deprecated in the catalog. |
| `W303` | warning | A parameter is declared and never read. |
| `W304` | warning | A step list labels some of its steps with a Gherkin keyword and not others, so the report reads half as a scenario and half as a list of calls. A suite can be labelled a case at a time, which is why this is a warning. |

## What a limit's ceiling is

`E205` needs one number to compare against. These are the core ceilings; a
runtime extension may add a stricter rule (for example a lower, required
ceiling for suites with a given tag), which it documents with its own codes.

| Limit | Where | Ceiling |
| --- | --- | --- |
| `timeoutSec` | a case, or `defaults` | 14400 seconds |
| `cleanupTimeoutSec` | a case, or `defaults` | 14400 seconds |
| `setupTimeoutSec`, `teardownTimeoutSec`, `beforeEachTimeoutSec`, `afterEachTimeoutSec` | the suite | 14400 seconds |

## The two output formats

A human line is `file:line:column  CODE  message`, with the suggestion
indented on the following line when there is one:

```
suites/orders.yml:38:15  E301  ${origOwner} resolves to nothing.
    Captures are read as ${capture.origOwner}. Did you mean that?
```

`--json` writes the array defined by `diagnostic.schema.json`, sorted by file,
then line, then column, then code, then message. The sort is total, so two
bindings that find the same set of problems write byte-identical documents
apart from their message wording. Paths are relative to the workspace root
and use forward slashes, for the same reason.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | no diagnostics, or warnings only without `--strict` |
| 2 | at least one error, or at least one warning under `--strict` |

Exit 1 is never a lint result. It means a case failed, which only a run can
discover.
