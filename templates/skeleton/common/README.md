# {{name}} suites

Behaviour-driven test suites in YAML, run by bdd-suite {{version}} with a
{{languages}} binding. Written by the Suite Authoring extension's *Suite: Create
suites workspace skeleton*.

| Path | What it is |
| --- | --- |
| `schema/actions.catalog.yaml` | The action catalog: every action a step may name, with its parameters and what it returns. |
| `schema/suite.schema.json`, `suite.schema.md` | Generated from the catalog by *Suite: Regenerate the schema*; never edited by hand. |
| `suites/*.yml` | The suites: one file per feature area, one case per scenario. |
| `bindings/` | The code that implements the actions, one folder per language. |
| `.vscode/settings.json` | Points the Suite Authoring extension at the catalog, the suites and the bindings. |

## Writing a case

1. Open this folder as the VS Code workspace.
2. Add a case to a suite in `suites/`. Every step has a keyword (`given`,
   `when`, `then`, `and`), an `action` and that action's parameters;
   `captureAs` keeps what it returned for later steps (`${capture.<name>}`) and
   assertions (`var: <name>.<field>`).
3. A step naming an action the catalog does not have is `E104`. The CodeLens
   above it, **Declare action**, adds the catalog entry and a stub in the target
   binding and regenerates the schema. Fill in the entry's TODOs (types,
   `required`, captures), run *Suite: Regenerate the schema*, and write the
   handler.
4. An action that needs a real environment stays out of `offlineActions`
   (`.vscode/settings.json` and each `bddsuite.tests.yaml`): its suites are then
   guarded, and a routine test run never reaches the environment by accident.
