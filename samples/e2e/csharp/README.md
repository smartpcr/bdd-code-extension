# Inventory suites with a C# binding

A self-contained workspace that writes behaviour-driven test suites in YAML and
runs them with a C# binding, laid out the way update2's
`src/UpdateResourceProvider/UpdateService/EnvironmentTest/BVT` is. It depends on
nothing in the bdd-code-extension repository: the runtime comes from the
`Smartpcr.BddSuite` and `Smartpcr.BddSuite.Testing` packages on nuget.org, and
the editor support from the **Suite Authoring** extension. Copy this folder
anywhere and it works the same.

The [PowerShell sample](../powershell/README.md) is the same suites with a
PowerShell binding.

## What is here

| Path | What it is |
| --- | --- |
| `schema/actions.catalog.yaml` | **The action catalog**: every action a step may name, with its parameters and what it returns. It imports `bdd-suite:core` (the built-in `core.*` and `wait`) and declares six inventory actions. |
| `schema/suite.schema.json`, `suite.schema.md` | Generated from the catalog. The editor, `suiterun lint` and the runtime check suites against the schema; the `.md` is a reference page listing every action. Never edited by hand. |
| `suites/*.yml` | **The suites**: one file per feature area, one case per scenario. |
| `suites/_lib/inventory.yml` | A **library**: the `a-store-holding` meta step the suites share. |
| `bindings/dotnet/Inventory.Suite` | **The extension**: `InventoryExtension` (one registration per action), `InventoryActions` (the handlers), `Store` (the system under test). |
| `bindings/dotnet/Inventory.Suite.Cli` | **suiterun**: the runtime's command line plus the extension. The editor runs it to lint, list and run suites. |
| `bindings/dotnet/Inventory.Suite.MsTest` | The suites as **MSTest tests**, generated at every build from `bddsuite.tests.yaml`. |
| `bindings/dotnet/Directory.Packages.props` | **The package references**: `Smartpcr.BddSuite` and `Smartpcr.BddSuite.Testing` 0.7.12, and MSTest, at central versions. |
| `nuget.config` | nuget.org only, so a restore takes exactly what `Directory.Packages.props` names. |
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
| **Binding** | The code, in one language, that implements the actions: here a C# class with one `["stock.ship"] = InventoryActions.Ship,` line per action. |
| **Guarded suite** | A suite using an action not listed as offline (`offlineActions`). Generated tests skip it unless `BDD_SUITE_ALLOW_GUARDED=1`, and the editor asks before running it, so a routine test run never reaches a real environment by accident. Here `warehouse-sync.yml` is guarded. |

The system under test is deliberately small: a **store** is a JSON file of stock
levels by SKU. `store.open` creates one in the temp folder (`bdd-inventory/`),
and each suite's `afterEach` deletes it, whether the case passed or failed.
Every case owns its own store, so cases never share state and may run in
parallel.

## Prerequisites

* .NET SDK 10 (`dotnet --list-sdks`) and network access to nuget.org (or a
  mirror; put its URL in `nuget.config`).
* PowerShell 7 (`pwsh`), which the schema generator runs on, and the
  `powershell-yaml` module: `Install-PSResource powershell-yaml`.
* VS Code with the **Suite Authoring** extension (`asz.bdd-suite`) 0.7.12, the
  same release as the packages. It is the `.vsix` asset of the
  [v0.7.12 release](https://github.com/smartpcr/bdd-code-extension/releases/tag/v0.7.12):
  `code --install-extension bdd-suite-0.7.12.vsix`.

## Step 1: open the workspace and configure it

Open **this folder** as the VS Code workspace (`code samples/e2e/csharp`), not the
repository around it: the settings apply to the folder that is open, and the
extension does nothing in a folder without a catalog. A workspace with several
binding projects gives each its own folder and settings like this one.

`.vscode/settings.json` holds the five things the extension needs:

| Setting | Value here | Why |
| --- | --- | --- |
| `bddSuite.root` | `.` | The **suites' root**: suiterun runs in it, and the binding's `tool` and `build` paths are relative to it. |
| `bddSuite.catalogPath` | `schema/actions.catalog.yaml` | The catalog. Its folder holds the generated schema and is passed to suiterun as `--schema-root`. |
| `bddSuite.suiteGlobs` | `["suites/**/*.yml"]` | Which files are suites (or libraries they import). |
| `bddSuite.lintTool`, `bddSuite.targetBinding` | `csharp` | Lint with the C# suiterun, and report a step whose action C# does not implement (`E201`). |
| `bddSuite.bindings.csharp` | `tool`, `build` | Where suiterun is after a build, and the command *Suite: Build lint tool* runs. |

Where the C# registrations are is not a setting: the catalog says so itself,
in `bindingSources` (`../bindings/dotnet/Inventory.Suite/**/*.cs`). The extension
indexes those files for navigation, hover and code generation.

The remaining settings: `bddSuite.offlineActions` (the same list as
`bddsuite.tests.yaml`) and `bddSuite.lab.*`, the values a Test Explorer run of
the guarded suite passes as `--api-url`, `--lab-id` and `--connection-file`.

Check it took effect: open `suites/shipping.yml`. The status bar shows the
lint tool, steps are highlighted, and hovering `action: stock.ship` shows the
catalog entry and that C# implements it. Until the first build (step 3) the
editor lints with the runtime it carries and says *lint bundled runtime*.

## Step 2: from a suite step to the catalog and the C# code

You write the step first, in the suite. The extension then writes the catalog
entry and a C# stub for it, and you fill in both. As a worked example, add
`stock.adjust`, which writes off damaged units.

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
         bindings: [csharp]
         interruptible: true
         params:
           - { name: store, type: string }  # TODO type
           - { name: sku, type: string }
           - { name: delta, type: integer }
         captures: { type: object, additionalProperties: true }
     ```

   * `InventoryExtension.cs` gets the registration after the last one:
     `["stock.adjust"] = InventoryActions.StockAdjust,`
   * `InventoryActions.cs` gets a handler that fails until it is written:

     ```csharp
     internal static object? StockAdjust(ActionRequest request) =>
         throw ActionException.Failed("stock.adjust: not implemented in the C# binding yet");
     ```

   * The schema is regenerated, so the editor already knows `stock.adjust`'s
     parameters (a misspelt `detla:` is now `E105`).

   For an action the catalog already has but C# does not implement, the
   CodeLens says so and offers **Implement in C#**: the same registration and
   handler, plus `csharp` added to the entry's `bindings:`.

3. **Finish the catalog entry.** Replace the TODOs: a summary, which
   parameters are `required: true`, and the capture shape. Then run *Suite:
   Regenerate the schema*, which rewrites `suite.schema.json` and
   `suite.schema.md` from the catalog; commit them with it:

   ```yaml
     - name: stock.adjust
       summary: Add or take units of a SKU outside a delivery or shipment, such as a write-off.
       bindings: [csharp]
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

4. **Write the handler** in `InventoryActions.cs`. It reads the step's
   parameters, acts, and returns the capture shape:

   ```csharp
   internal static object? StockAdjust(ActionRequest request)
   {
       var store = Store.Load(Required(request, "store"));
       var sku = Required(request, "sku");
       if (!Value.TryNumber(request.Step.Value("delta"), out var delta) || delta != Math.Floor(delta))
       {
           throw ActionException.Failed("stock.adjust: delta must be a whole number");
       }
       var onHand = store.Add(sku, (long)delta);
       store.Save();
       var result = new OrderedMap();
       result.Set("sku", sku);
       result.Set("onHand", onHand);
       return result;
   }
   ```

5. **Rebuild the lint tool** (*Suite: Build lint tool*, or step 3's build) so
   the editor's suiterun knows the new action, then run the case (step 3).

Go to Definition on `action: stock.adjust` now opens the catalog entry and the
handler; Find References on the handler lists the steps that use it.

## Step 3: build, then run

From this folder (the workspace root):

```powershell
dotnet build bindings/dotnet/Inventory.Suite.slnx
```

The build restores the packages from nuget.org, compiles the extension and
suiterun, and **generates the MSTest tests** from
`bindings/dotnet/Inventory.Suite.MsTest/bddsuite.tests.yaml`: one `[TestClass]`
per suite, one `[TestMethod]` per case and examples row, written to
`bindings/dotnet/artifacts/obj/Inventory.Suite.MsTest/Debug/net10.0/BddSuite/*.g.cs`
and never committed. The generator lints every suite first, and a finding
**fails the build** as a build error at its file and line, the same message
the editor shows.

### With suiterun

`$suiterun` below is `bindings/dotnet/artifacts/bin/Inventory.Suite.Cli/Debug/net10.0/suiterun.exe`.
Every verb takes `--schema-root schema`, because the catalog is not in the
default `test/e2e/schema`.

```powershell
$suiterun = 'bindings/dotnet/artifacts/bin/Inventory.Suite.Cli/Debug/net10.0/suiterun.exe'

& $suiterun lint --path 'suites/*.yml' --schema-root schema --binding-check --binding csharp --strict
& $suiterun list --path 'suites/*.yml' --schema-root schema
& $suiterun run  --path 'suites/*.yml' --schema-root schema --progress `
                 --results out/results.xml --trace-file out/trace.json
```

| Run | Command |
| --- | --- |
| one suite | `--path suites/shipping.yml` |
| by tag | `--tags smoke` |
| by case name | `--name 'ships-*'` (globs, comma-separated) |
| without running actions | `--dry-run` (checks and lists every step; nothing is called) |
| against an environment | `--api-url <url> --lab-id <id> --connection-file <file>` (options `InventoryExtension` declares) |

suiterun runs every selected case, guarded or not: it is the command you run
on purpose. Exit codes: `0` all passed (or a clean lint), `1` a case failed,
`2` refused (a lint error or a bad command line; nothing ran).

### With MSTest (`dotnet test`)

```powershell
dotnet test bindings/dotnet/Inventory.Suite.MsTest                                  # every case
dotnet test bindings/dotnet/Inventory.Suite.MsTest --filter TestCategory=smoke       # a tag
dotnet test bindings/dotnet/Inventory.Suite.MsTest --filter "Name=ships-in-parts"    # one case
dotnet test bindings/dotnet/Inventory.Suite.MsTest --filter "FullyQualifiedName~Inventory.Suite.MsTest.Suite_Shipping."  # one suite
```

A plain `dotnet test` gives 7 passed and 1 skipped: `syncs-levels-to-the-warehouse`
is guarded and reports *guarded suite: set BDD_SUITE_ALLOW_GUARDED=1 to run it*.
To run it as well:

```powershell
$env:BDD_SUITE_ALLOW_GUARDED = '1'
$env:BDD_SUITE_OPTION_API_URL = 'https://warehouse.example/api/levels'   # --api-url, for the generated tests
dotnet test bindings/dotnet/Inventory.Suite.MsTest --filter TestCategory=warehouse
Remove-Item env:BDD_SUITE_ALLOW_GUARDED, env:BDD_SUITE_OPTION_API_URL
```

The test explorers (VS Code's C# Dev Kit, Visual Studio) list and run the same
tests.

### From the editor

The **Testing** view lists every suite, case and examples row. *Run* runs it
with the target binding's suiterun; *Dry run* checks it without calling an
action. Running `warehouse-sync.yml` asks for confirmation first, because it is
a guarded ("lab") suite, and passes the `bddSuite.lab.*` values as
`--api-url`, `--lab-id` and `--connection-file`.

## Step 4: logs and test reports

| Output | Where | What it holds |
| --- | --- | --- |
| suiterun's console | stdout | With `--progress`: `StartGroup: <suite>::<case>`, one line per step, hook and cleanup with its status, `EndGroup: ... [Passed]`, and a `Summary:` line. Then `=== Suite: <file> ===` and one `[passed]`/`[failed]` line per case. |
| `out/results.xml` (`--results`) | NUnit 3 XML | One `test-suite` per suite, one `test-case` per case, each with its step outputs and, on failure, the message and the failing step. `--format junit` writes JUnit XML instead, for CI systems that read that. |
| `out/trace.json` (`--trace-file`) | JSON array | One entry per step, hook and case: `phase`, `case`, `step` (the sentence and action), `action`, `status`, and on failure the `reason` and message. This is what the editor reads back to mark each test item. |
| TRX (`dotnet test --logger "trx;LogFileName=inventory.trx"`) | `bindings/dotnet/artifacts/TestResults/` | MSTest's report, set by `inventory.runsettings`. A guarded case is `NotExecuted` with its reason. |
| Step lines under MSTest | test output | `BDD_SUITE_PROGRESS=1` prints the same step lines suiterun's `--progress` does into each test's standard output (`dotnet test --logger "console;verbosity=detailed"` shows them). |
| Trace under MSTest | the path you give | `BDD_SUITE_TRACE_FILE=<path>`, the same JSON as `--trace-file`. |
| The editor's log | *Output* view, **Suite Authoring** | Every command the extension ran (lint, build, run) with its arguments and working folder, and why a run did or did not start. A Test Explorer run's own output is in the *Test Results* view. |

The run inputs the generated tests read (`BDD_SUITE_ALLOW_GUARDED`,
`BDD_SUITE_TAGS`, `BDD_SUITE_TRACE_FILE`, `BDD_SUITE_OPTION_<FLAG>`,
`BDD_SUITE_PARAM_<NAME>`) can also go in
`bindings/dotnet/Inventory.Suite.MsTest/inventory.runsettings` under
`TestRunParameters`, which win over the environment.

A case that fails names the step and the reason, the same in every report:
`case refuses-to-ship-more-than-on-hand / then the shipment is refused, with the shortfall named (core.noop)`
followed by the assertion that did not hold.

## Moving to another release

Change `BddSuiteVersion` in `bindings/dotnet/Directory.Packages.props`, install
the Suite Authoring extension of the same release, rebuild, and regenerate the
schema (*Suite: Regenerate the schema*), since the core catalog comes with the
release.
