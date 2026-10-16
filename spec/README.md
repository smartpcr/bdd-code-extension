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
| `Schema.Tests.ps1` | The schema and import rules, asserted (Pester). |

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
