# Inventory suites with a PowerShell binding

A self-contained workspace that writes behaviour-driven test suites in YAML and
runs them with a PowerShell binding, laid out the way update2's
`src/UpdateResourceProvider/UpdateService/EnvironmentTest/BVT` is. It depends on
nothing in the bdd-code-extension repository: the runtime is the `BddSuite`
module, restored as a package from the version `packages.psd1` names, and the
editor support comes from the **Suite Authoring** extension. Copy this folder
anywhere and it works the same.

The [C# sample](../csharp/README.md) is the same suites with a C# binding.

## What is here

| Path | What it is |
| --- | --- |
| `schema/actions.catalog.yaml` | **The action catalog**: every action a step may name, with its parameters and what it returns. It imports `bdd-suite:core` (the built-in `core.*` and `wait`) and declares six inventory actions. |
| `schema/suite.schema.json`, `suite.schema.md` | Generated from the catalog. The editor, `suiterun lint` and the runtime check suites against the schema; the `.md` is a reference page listing every action. Never edited by hand. |
| `suites/*.yml` | **The suites**: one file per feature area, one case per scenario. |
| `suites/_lib/inventory.yml` | A **library**: the `a-store-holding` meta step the suites share. |
| `bindings/powershell/Inventory/Inventory.psm1` | **The extension**: a module whose `Get-SuiteExtension` names its action files, its helper module and its options. |
| `bindings/powershell/Inventory/actions/*.ps1` | **The handlers**, one `Register-SuiteAction -Name '<action>'` each. |
| `bindings/powershell/Inventory/InventoryStore.psm1` | The system under test, and the helpers the handlers share. |
| `bindings/powershell/suiterun.ps1` | **suiterun**: the module's command line plus the extension. The editor runs it to lint, list and run suites. |
| `bindings/powershell/bddsuite.tests.yaml` | What `suiterun.ps1 generate` turns into **Pester tests** (`bindings/powershell/tests/`, not committed). |
| `bindings/powershell/Invoke-Tests.ps1` | Runs the generated Pester tests and writes the NUnit3 report. |
| `packages.psd1` | **The package references**: `BddSuite` 0.7.12 (its `.nupkg`), `powershell-yaml` and `Pester`, each at an exact version. |
| `restore.ps1` | Restores them into `.modules/`, this workspace's own module path. |
| `.vscode/settings.json` | Points the Suite Authoring extension at this workspace's catalog, suites and binding. |
| `warehouse.connection.json` | The stand-in "environment" the guarded suite targets. |

### The words used below

| Term | Meaning |
| --- | --- |
| **Suite** | A YAML file with a `suite:` key and a list of `tests:` (cases). |
| **Case** | One scenario, a list of steps. It passes or fails as a whole, and is what a report lists. |
| **Step** | One `given` / `when` / `then` / `and` sentence, the **action** that does the work, and the action's parameters. `captureAs` keeps what the action returned for later steps (`${capture.store.path}`) and assertions (`var: level.onHand`). |
| **Action** | A named operation such as `stock.ship`. Suites only name actions; a binding implements them. |
| **Catalog** | The list of actions, their parameter types and return shapes. It is the contract between suite writers and binding authors. |
| **Binding** | The code, in one language, that implements the actions: here a PowerShell module with one `Register-SuiteAction` per action. |
| **Guarded suite** | A suite using an action not listed as offline (`offlineActions`). Generated tests skip it unless `BDD_SUITE_ALLOW_GUARDED=1`, and the editor asks before running it, so a routine test run never reaches a real environment by accident. Here `warehouse-sync.yml` is guarded. |

The system under test is deliberately small: a **store** is a JSON file of stock
levels by SKU. `store.open` creates one in the temp folder (`bdd-inventory/`),
and each suite's `afterEach` deletes it, whether the case passed or failed.
Every case owns its own store, so cases never share state. The state lives in
the file rather than in a PowerShell variable because handlers run in the
runtime's own step runspace, not in the session that loaded them.

## Prerequisites

* PowerShell 7.4 or later (`pwsh`), with `Microsoft.PowerShell.PSResourceGet`
  (built in from 7.4).
* Network access to github.com (the `BddSuite` package) and the PowerShell
  Gallery (`powershell-yaml`, `Pester`). Offline, see `restore.ps1 -Source`.
* VS Code with the **Suite Authoring** extension (`asz.bdd-suite`) 0.7.12, the
  same release as `BddSuite`. It is the `.vsix` asset of the
  [v0.7.12 release](https://github.com/smartpcr/bdd-code-extension/releases/tag/v0.7.12):
  `code --install-extension bdd-suite-0.7.12.vsix`.

## Step 1: open the workspace, restore the packages, configure it

Open **this folder** as the VS Code workspace (`code samples/e2e/powershell`),
not the repository around it: the settings apply to the folder that is open,
and the extension does nothing in a folder without a catalog. A workspace with
several binding projects gives each its own folder and settings like this one.

Restore the packages once, from this folder:

```powershell
pwsh -File restore.ps1
```

`packages.psd1` is this workspace's package reference list. `BddSuite` is not on
the PowerShell Gallery yet, so its entry names the `.nupkg` of the release;
`restore.ps1` downloads it into `.packages/`, registers that folder as a
temporary PSResource repository, and saves the module into `.modules/` with
`Save-PSResource`. `powershell-yaml` and `Pester` come from the Gallery. Nothing
is installed into your own module path: `suiterun.ps1` and `Invoke-Tests.ps1`
put `.modules/` first on `PSModulePath` for their own process only, so the
versions `packages.psd1` names are the ones loaded. With no access to GitHub,
put `BddSuite.0.7.12.nupkg` in a folder (from the release, or the GitHub
Packages NuGet feed) and run `pwsh -File restore.ps1 -Source <folder>`.

`.vscode/settings.json` holds what the extension needs:

| Setting | Value here | Why |
| --- | --- | --- |
| `bddSuite.root` | `.` | The **suites' root**: suiterun runs in it, and the binding's `tool` and `stubFile` paths are relative to it. |
| `bddSuite.catalogPath` | `schema/actions.catalog.yaml` | The catalog. Its folder holds the generated schema and is passed to suiterun as `--schema-root`. |
| `bddSuite.suiteGlobs` | `["suites/**/*.yml"]` | Which files are suites (or libraries they import). |
| `bddSuite.lintTool`, `bddSuite.targetBinding` | `powershell` | Lint with the PowerShell suiterun, and report a step whose action PowerShell does not implement (`E201`). |
| `bddSuite.bindings.powershell.tool` | `pwsh ... -File bindings/powershell/suiterun.ps1` | The program the extension runs. PowerShell needs no build. |
| `bddSuite.bindings.powershell.stubFile` | `bindings/powershell/Inventory/actions/${action}.ps1` | Where *Declare action* writes a new action's file; `${action}` is its PascalCase name. |

Where the registrations are is not a setting: the catalog says so itself, in
`bindingSources` (`../bindings/powershell/Inventory/actions/*.ps1`). The
extension indexes those files for navigation, hover and code generation.

The remaining settings: `bddSuite.offlineActions` (the same list as
`bddsuite.tests.yaml`) and `bddSuite.lab.*`, the values a Test Explorer run of
the guarded suite passes as `--api-url`, `--lab-id` and `--connection-file`.

Check it took effect: open `suites/shipping.yml`. The status bar shows the
lint tool, steps are highlighted, and hovering `action: stock.ship` shows the
catalog entry and that PowerShell implements it.

## Step 2: from a suite step to the catalog and the PowerShell code

You write the step first, in the suite. The extension then writes the catalog
entry and a PowerShell stub for it, and you fill in both. As a worked example,
add `stock.adjust`, which writes off damaged units.

1. **Write the step.** In `suites/shipping.yml`, add a case:

   ```yaml
     - name: writes-off-damaged-stock
       steps:
         - given: a store holding 5 WIDGET-1
           meta: a-store-holding
           with: { sku: WIDGET-1, qty: 5 }
         - when: two damaged widgets are written off
           action: stock.adjust
           store: ${capture.store.path}
           sku: WIDGET-1
           delta: -2
           captureAs: adjusted
         - then: three are left
           action: core.noop
           asserts:
             - var: adjusted.onHand
               equals: 3
   ```

   `action: stock.adjust` is underlined `E104 Unknown action name`, because the
   catalog does not have it yet.

2. **Declare it.** A CodeLens above the step offers **Declare action**; or put
   the cursor on the step and run *Suite: Declare action*. It makes one
   undoable edit:

   * `schema/actions.catalog.yaml` gets an entry next to the other `stock.*`
     actions, with a parameter for each key the step used:

     ```yaml
       - name: stock.adjust
         summary: TODO describe stock.adjust.
         bindings: [powershell]
         interruptible: true
         params:
           - { name: store, type: string }  # TODO type
           - { name: sku, type: string }
           - { name: delta, type: integer }
         captures: { type: object, additionalProperties: true }
     ```

   * `bindings/powershell/Inventory/actions/StockAdjust.ps1` is created, with a
     handler that fails until it is written:

     ```powershell
     Register-SuiteAction -Name 'stock.adjust' -Handler {
         param([hashtable]$Step, [hashtable]$Ctx)

         throw 'stock.adjust: not implemented in the PowerShell binding yet'
     }
     ```

     `Inventory.psm1` loads every file in `actions/`, so nothing else needs
     registering.
   * The schema is regenerated, so the editor already knows `stock.adjust`'s
     parameters (a misspelt `detla:` is now `E105`).

3. **Finish the catalog entry.** Replace the TODOs: a summary, which
   parameters are `required: true`, and the capture shape. Then run *Suite:
   Regenerate the schema*, which rewrites `suite.schema.json` and
   `suite.schema.md` from the catalog; commit them with it:

   ```yaml
     - name: stock.adjust
       summary: Add or take units of a SKU outside a delivery or shipment, such as a write-off.
       bindings: [powershell]
       interruptible: true
       params:
         - { name: store, type: string, required: true }
         - { name: sku, type: string, required: true }
         - { name: delta, type: integer, required: true, description: Units to add; negative takes them. }
       captures:
         type: object
         additionalProperties: false
         properties:
           sku: { type: string }
           onHand: { type: integer }
   ```

4. **Write the handler** in `StockAdjust.ps1`. `$Step` holds the step's
   parameters after substitution; the returned hashtable is what `captureAs`
   keeps. The helpers come from `InventoryStore.psm1`:

   ```powershell
   Register-SuiteAction -Name 'stock.adjust' -Handler {
       param([hashtable]$Step, [hashtable]$Ctx)
       $path = Get-RequiredText $Step 'stock.adjust' 'store'
       $sku = Get-RequiredText $Step 'stock.adjust' 'sku'
       $delta = 0L
       if (-not [long]::TryParse([string]$Step['delta'], [ref]$delta)) { throw "stock.adjust: delta must be a whole number, not '$($Step['delta'])'" }
       $levels = Read-InventoryStore $path
       $levels[$sku] = [long]$levels[$sku] + $delta
       Write-InventoryStore $path $levels
       return [ordered]@{ sku = $sku; onHand = $levels[$sku] }
   }
   ```

5. **Regenerate the Pester tests** (step 3), since a case was added, and run it.

Go to Definition on `action: stock.adjust` now opens the catalog entry and the
handler; Find References on the handler lists the steps that use it.

## Step 3: generate the tests, then run

PowerShell has nothing to compile. The **tests are generated** from
`bindings/powershell/bddsuite.tests.yaml`: one `Describe` per suite, one `It` per
case and examples row, tagged with the suite's and case's tags. From this
folder:

```powershell
pwsh -File bindings/powershell/suiterun.ps1 generate --config bindings/powershell/bddsuite.tests.yaml --out bindings/powershell/tests
```

The generator lints every suite first and refuses (exit 2, writing nothing)
when one has a finding, with the same message the editor shows. Run it again
after adding or renaming a case or a suite; `--check` exits 1 naming each stale
file, for CI.

### With suiterun

Every verb takes `--schema-root schema`, because the catalog is not in the
default `test/e2e/schema`.

```powershell
$suiterun = 'bindings/powershell/suiterun.ps1'

pwsh -File $suiterun lint --path 'suites/*.yml' --schema-root schema --binding-check --binding powershell --strict
pwsh -File $suiterun list --path 'suites/*.yml' --schema-root schema
pwsh -File $suiterun run  --path 'suites/*.yml' --schema-root schema --progress `
                          --results out/results.xml --trace-file out/trace.json
```

| Run | Command |
| --- | --- |
| one suite | `--path suites/shipping.yml` |
| one case | `--path suites/shipping.yml --test-name ships-in-parts` |
| by tag | `--tags smoke` |
| by case name | `--name 'ships-*'` (globs, comma-separated) |
| without running actions | `--dry-run` (checks and lists every step; nothing is called) |
| against an environment | `--api-url <url> --lab-id <id> --connection-file <file>` (options `Inventory.psm1` declares) |

suiterun runs every selected case, guarded or not: it is the command you run
on purpose. Exit codes: `0` all passed (or a clean lint), `1` a case failed,
`2` refused (a lint error or a bad command line; nothing ran).

### With Pester

```powershell
pwsh -File bindings/powershell/Invoke-Tests.ps1                              # every case
pwsh -File bindings/powershell/Invoke-Tests.ps1 -TagFilter smoke             # a tag
pwsh -File bindings/powershell/Invoke-Tests.ps1 -FullName '*ships-in-parts'  # one case
pwsh -File bindings/powershell/Invoke-Tests.ps1 -FullName 'shipping.*'       # one suite
```

A plain run gives 7 passed and 1 skipped: `syncs-levels-to-the-warehouse` is
guarded and reports *guarded suite: set BDD_SUITE_ALLOW_GUARDED=1 to run it*.
`-AllowGuarded` runs it too; the endpoint it sends to comes from
`BDD_SUITE_OPTION_API_URL` (`--api-url` for the generated tests) when set:

```powershell
$env:BDD_SUITE_OPTION_API_URL = 'https://warehouse.example/api/levels'
pwsh -File bindings/powershell/Invoke-Tests.ps1 -AllowGuarded -FullName 'warehouse-sync.*'
Remove-Item env:BDD_SUITE_OPTION_API_URL
```

`Invoke-Tests.ps1` is a thin wrapper: it loads Pester and BddSuite from
`.modules/`, builds a `New-PesterConfiguration` (path `tests/`, `Detailed`
output, NUnit3 report), sets the run inputs below for its own process, and calls
`Invoke-Pester`. Use your own runner the same way if you prefer.

### From the editor

The **Testing** view lists every suite, case and examples row. *Run* runs it
with the target binding's suiterun; *Dry run* checks it without calling an
action. Running `warehouse-sync.yml` asks for confirmation first, because it is
a guarded ("lab") suite, and passes the `bddSuite.lab.*` values as
`--api-url`, `--lab-id` and `--connection-file`.

## Step 4: logs and test reports

| Output | Where | What it holds |
| --- | --- | --- |
| suiterun's console | stdout | With `--progress`: `StartGroup: <suite>::<case>`, one line per step, table row, hook and cleanup with its status, `EndGroup: ... [Passed]`, and a `Summary:` line. Then `=== Suite: <file> ===` and one `[passed]`/`[failed]`/`[skipped]` line per case. |
| `out/results.xml` (`--results`) | NUnit 3 XML | One `test-suite` per suite, one `test-case` per case, each with its step outputs and, on failure, the message and the failing step. `--format junit` writes JUnit XML instead, for CI systems that read that. |
| `out/trace.json` (`--trace-file`) | JSON array | One entry per step, hook and case: `phase`, `case`, `step` (the sentence and action), `action`, `status`, and on failure the `reason` and message. This is what the editor reads back to mark each test item. |
| Pester's console | stdout | `Describing <suite>`, one `[+]` / `[-]` / `[!]` line per case with its time, and the skip reason of a guarded case. |
| `out/pester-results.xml` | NUnit 3 XML | Pester's report (`Invoke-Tests.ps1 -Results <path>` moves it). NUnit3 rather than Pester's default NUnit 2.5, which shows a failed suite teardown as a success. |
| Trace under Pester | the path you give | `Invoke-Tests.ps1 -TraceFile out/pester-trace.json` (or `BDD_SUITE_TRACE_FILE=<path>`), the same JSON as `--trace-file`. |
| The editor's log | *Output* view, **Suite Authoring** | Every command the extension ran (lint, run) with its arguments and working folder, and why a run did or did not start. A Test Explorer run's own output is in the *Test Results* view. |

The run inputs the generated tests read come from the environment:
`BDD_SUITE_ALLOW_GUARDED`, `BDD_SUITE_TAGS`, `BDD_SUITE_TRACE_FILE`,
`BDD_SUITE_DRY_RUN=1`, `BDD_SUITE_OPTION_<FLAG>` and `BDD_SUITE_PARAM_<NAME>`.

A case that fails names the step and the reason, the same in every report:
`case refuses-to-ship-more-than-on-hand / then the shipment is refused, with the shortfall named (core.noop)`
followed by the assertion that did not hold.

## Moving to another release

Change `BddSuite`'s `Version` and `Nupkg` in `packages.psd1`, run
`pwsh -File restore.ps1`, install the Suite Authoring extension of the same
release, regenerate the schema (*Suite: Regenerate the schema*) and the Pester
tests.
