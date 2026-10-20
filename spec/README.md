# The core suite format

What a BDD suite may contain and what every finding means, for any workspace.
This folder holds only the core; a workspace adds its own actions and fields by
importing it (DEC-S10 in `docs/self-contained/design.md`).

| File | What it is |
| --- | --- |
| `suite.core.json` | The suite structure, hand-written: suite, defaults, parameters, variables, imports, meta steps, hooks, cases, assertions, and the fields every step has. No product fields. |
| `core.catalog.yaml` | The core actions every runtime implements: `core.noop`, `core.set`, `core.fail`, `core.sleep`, `core.record` and `wait`. |
| `actions.catalog.schema.json` | What a catalog may contain, including `imports`, `suiteSchema` and `bindingSources`. |
| `suite.extension.schema.json` | What a suite-schema extension may contain: fields added to the suite, its defaults, a case or a step, and the definitions they use. It can add; it can never redefine. |
| `diagnostic.schema.json` | The JSON every runtime's `lint --json` writes. |
| `diagnostics.md` | Every finding code, its meaning, the limit ceilings and the output formats. |
| `Build-Schema.ps1` | Generates a workspace's `suite.schema.json` and `suite.schema.md` from the core, its catalog and what that imports. |
| `suite.schema.json`, `suite.schema.md` | The generated schema and reference for the core catalog alone, committed so `-Check` keeps them current. |
| `progress.md` | What `run --progress` prints, what a run observer may see and do, and the rule that an action's worker turns any failure into a failed step. |
| `session.md` | The session contract: how a runtime runs one suite a phase at a time (setup, one case, teardown), so a test framework can drive it; the whole-file run is built on it. |
| `test-plan.md` | What `suiterun generate` builds before it writes test code for a framework: the plan, its identifiers and guards, the config and the command line. |
| `tests.config.schema.json` | What a test project's `bddsuite.tests.yaml` may contain. |
| `test-plan.schema.json` | The JSON `suiterun generate --plan` prints. |
| `Schema.Tests.ps1` | The schema, import, config and plan rules, asserted (Pester). |

## Extending the core in a workspace

A workspace catalog imports the core catalog and declares its own actions:

```yaml
# <workspace>/test/e2e/schema/actions.catalog.yaml
catalogVersion: 1
imports:
  - ../../../bdd/spec/core.catalog.yaml   # wherever this repository is checked out or pinned
suiteSchema:
  - shop.suite.json                       # optional: fields this workspace adds
bindings: [go, typescript]
actions:
  - name: shop.order
    summary: Place an order.
    bindings: [go]
    interruptible: true
    params:
      - { name: item, type: string, required: true }
    captures: { type: any }
```

* `imports` are other catalogs, resolved relative to the importing file, depth
  first in listed order; a catalog may import one that imports the core. An
  action declared twice is an error naming both files, and so is an import
  cycle.
* `bdd-suite:core` in `imports` names **the core of the runtime or generator
  reading the catalog**, instead of a path: each runtime carries the
  `core.catalog.yaml` of its own version, and `Build-Schema.ps1` reads the one
  beside it. A workspace that installs a runtime as a package needs no copy of
  this folder. The core lists every built-in runtime in its `bindings`; through
  `bdd-suite:core`, each core action's `bindings` is cut to the importing
  catalog's own `bindings` list when it has one, so a workspace that supports
  `[csharp, powershell]` sees the core that way too. A path import is read as
  written, without that cut, because it is the workspace's own file
  (docs/packages, DEC-P07):

  ```yaml
  imports: [ "bdd-suite:core" ]
  bindings: [csharp]          # the core's actions read bindings: [csharp] here
  ```
* `suiteSchema` lists suite-schema extensions. One that adds an `owner` field to
  every suite and a `region` to cases and steps:

  ```json
  {
    "$schema": "../../../bdd/spec/suite.extension.schema.json",
    "suite": { "owner": { "type": "string" } },
    "case": { "region": { "$ref": "#/$defs/region" } },
    "step": { "region": { "$ref": "#/$defs/region" } },
    "$defs": { "region": { "enum": ["eu", "us"] } }
  }
  ```

* Binding names are open: the built-in runtimes are `powershell`, `csharp`,
  `go`, `rust` and `typescript`, and a workspace may name its own.
* `bindingSources` (optional) says where the registrations of the catalog's
  actions are, per binding, as globs relative to the catalog, for tools that
  index them; the Suite Authoring extension reads it over its
  `bddSuite.bindings.<name>.sources` setting, merging the workspace catalog's
  with those of every catalog it imports (a core copied into the workspace can
  name the runtime that registers it). Runtimes ignore it:

  ```yaml
  bindingSources:
    csharp: [../bindings/dotnet/Shop.Suite/**/*.cs]
  ```

## The command line

Every runtime's `suiterun` takes the same verbs, flags and exit codes
(docs/design.md, section 2.2). Two flags select and observe a run; neither
changes a case's result, the trace or a report:

| Flag | Verbs | Meaning |
| --- | --- | --- |
| `--name glob[,glob]` | `run`, `list` | Selects a case when its name matches any of the globs (`*` any run of characters, `?` one character, the whole name, case-sensitive) **and** the tag filter. A case it leaves out is reported `skipped` with reason `tag`, exactly as one the tag filter leaves out, and a session's selection applies it the same way (session.md). Repeatable; empty selects every case. PowerShell's `--test-name <case>` (one exact name) stays. |
| `--progress` | `run` | Prints live lines while the run goes, in the shape `progress.md` specifies. |

An extension may not take either flag name. `list` prints one line per selected
case, `<file name>  <case name>`.

## Generating a workspace's schema

Generate the workspace's schema and reference beside its catalog, and check in
CI that they are current:

```powershell
pwsh -File <this folder>/Build-Schema.ps1 -Catalog test/e2e/schema/actions.catalog.yaml
pwsh -File <this folder>/Build-Schema.ps1 -Catalog test/e2e/schema/actions.catalog.yaml -Check
```

The generator needs PowerShell 7 and the `powershell-yaml` module.

## Tests

```powershell
Invoke-Pester spec/Schema.Tests.ps1
```

They assert that the core schema closes every object an editor relies on, holds
exactly the core actions and no product field, matches a fresh generation, and
that imports, duplicates, cycles and extensions behave as above.
