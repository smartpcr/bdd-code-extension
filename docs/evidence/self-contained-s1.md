# Stage S1 evidence: spec, corpus and the TypeScript runtime

Plan: [docs/self-contained/implementation.md](../self-contained/implementation.md#stage-s1-spec-corpus-and-the-typescript-runtime-p0).
Design: [docs/self-contained/design.md](../self-contained/design.md).
Recorded 2026-10-15, on Windows 11 with Node.js 24.16.0, PowerShell 7.6.7 and
Pester 5.7.1. Everything below ran locally; nothing has run in CI yet (S1.17).

## Source

Every copied file comes from the os-context worktree `E:\work\os\os-context-ts`,
branch `typescript-binding`, at commit `7633e176fb70140e94ddc7e9d96b07eb39c39b22`
plus that worktree's uncommitted stage-B7 changes. Those changes are: TypeScript
added to the binding lists of the catalog schema and catalog, the corpus README,
the divergence check, the expectation schema, and the whole TypeScript binding
(untracked there). os-context itself was not changed (DEC-S07).

## S1.1–S1.4: the core spec (D1)

| Step | What was done | Evidence |
| --- | --- | --- |
| S1.1 | Copied `suite.base.json`, `actions.catalog.schema.json`, `diagnostic.schema.json`, `diagnostics.md`, `Build-Schema.ps1`, `Schema.Tests.ps1`, `README.md` into `spec/` | `spec/` |
| S1.2 | `spec/suite.core.json`: the base schema without `requires` (suite, case, step), `sharedChecks`, `cluster`/`target` (defaults, case). Those fields are now os-context's suite-schema extension | `docs/self-contained/handover/os-context.suite.json` |
| S1.2 | os-context's lint rules (E214, the `lifecycle` 900 s limit rows, the scenario-catalog codes) moved out of `diagnostics.md` verbatim | `docs/self-contained/handover/os-context.diagnostics.md` |
| S1.3 | `core.catalog.yaml` (`core.noop`, `core.set`, `core.fail`, `core.sleep`, `core.record`, `wait`); the catalog schema has `imports` and `suiteSchema`, and its binding names became a pattern; `suite.extension.schema.json`; the generator takes `-Catalog`, resolves imports depth first, refuses duplicates and cycles, and folds extensions into the suite, defaults, case and every step | `spec/` |
| S1.3 | `Invoke-Pester spec/Schema.Tests.ps1`: **29 passed, 0 failed**. This includes imports, depth-first order, a duplicate naming both files, a cycle, an extension in all four places, and four refusals (a core suite field, a core step field, a core definition, an unknown section). The first run caught a generator bug, now fixed: `Join-Path` made an absolute import relative | test output |
| S1.4 | os-context's catalog without its 6 core entries (**94** actions, not 93 as first written), importing `spec/core.catalog.yaml` and its suite-schema extension, generated into `out/s1.4/`. Compared with os-context's `suite.schema.json` with descriptions, comments, titles and ids set aside: **2 differences**, both the order of the action list (`$defs.step.properties.action.enum` and `$defs.step.allOf`, with the imported core first). Compared as sets: **equivalent**, with the same 100 actions | the comparison scripts in this stage's commands |
| S1.4 | `pwsh -File spec/Build-Schema.ps1 -Check`: the committed core schema and reference are current | exit 0 |

## S1.5–S1.7: the corpus (D2)

| Step | What was done | Evidence |
| --- | --- | --- |
| S1.5 | `node conformance/Import-Corpus.mjs E:\work\os\os-context-ts`, which copies the corpus and applies `conformance/rename.json` | 56 files renamed, every replacement listed by the script |
| S1.6 | `conformance/schema/actions.catalog.yaml` imports the core and declares 6 fixture actions, with exactly the parameters, types, captures and bindings of `cluster.state`, `cluster.suspend`, `cluster.resume`, `cluster.move`, `invoke` and `lifecycle.get`. `fixture.suite.json` declares `requires`, `cluster` and `target`. The generated `conformance/schema/suite.schema.json`, compared with os-context's: every shared definition and every fixture branch is **equivalent** to the one it replaced | comparison output |
| S1.7 | Renames are all the same length (`cluster` and `fixture`, `lifecycle` and `inventory`, `WSFC` and `HOST` in 22 files), so no expected line or column changed. Handed over to os-context: 4 `lifecycle-*` and 3 `shared-checks-*` entries, plus `validate/_lib/shared-checks.yml` | `docs/self-contained/handover/conformance/` |

The remaining manifest has 41 validate entries, 11 execute entries, the two
tables and 7 report entries. Its catalog root is `schemaRoot: schema`.

## S1.8–S1.16: the TypeScript runtime (D3)

`runtimes/typescript` (package `@bdd-suite/runtime`, API 1.1.0):

* **Removed:** `src/lifecycle` and its tests.
* **The extension API:** `src/extension.ts`, with actions, context keys,
  options, rules (`lint`, `caseLimitSec`) and the environment prefix
  (`BDD_SUITE_` by default), plus `compose()` and `start()`.
* **Wired through:**
  * the executor (`runFile(..., run)`);
  * expression scopes (`roots`);
  * dataflow context keys;
  * semantics (the lifecycle rule and E214 removed, the import list exposed for extension rules);
  * `--schema-root` without a workspace walk (S1.13);
  * the command line (`main(argv, streams, extensions)`, extension options as valued flags);
  * `createLinter({ ..., extensions })`.
* **Catalog loading:** follows `imports`.
* **Example extension:** `example/`, with the action `example.echo`, the
  context key `region`, the option `--region` and a 10 s ceiling for suites
  tagged `slow`. It uses only `src/index.ts` and `src/cli.ts`.

`npm test` in `runtimes/typescript`:

| Result | Value |
| --- | --- |
| Tests | **112 passed, 0 failed** |
| Validate corpus through the library | **41 of 41** entries match (codes, severities, lines, columns, exit codes) |
| Validate corpus through the program | **39 of 39** (the 2 catalog-overlay entries are library-only) |
| Execute corpus | all 11 entries: trace, exit code, within `maxSeconds` |
| Expression and assertion tables | every row |
| Reports | **7 of 7** stored reports match after canonicalisation, 3 runs identical |
| Core catalog against registered actions | equal (6 names) |
| E3, TypeScript part | with the extension the action runs, `${region}` reads `--region`, lint reports the ceiling (`E205 5:17`). Without it, `E301 9:15`, `--region` refused, the step fails. Two extensions with one action are refused. The example's own program passes |
| Coverage gate | 100% of lines in every file; 100% of branches in `expr.ts` and `assertion.ts` |

That is **E2's TypeScript part, passed locally**, and **E3's TypeScript part,
passed locally**. The other four languages and the divergence check are stages
S2 to S4.

## S1.17: CI (built, open)

`ci.yml` gained two jobs:
* `spec`: the schema tests, plus `-Check` on the core, the corpus and the example schemas;
* `runtime-typescript`: `npm ci` and `npm test` in `runtimes/typescript`.

The release job now also needs both jobs. The file parses as YAML. **Not run:**
CI runs on GitHub after a push, so S1.17 stays open.

## S1.18: the VS Code extension resolves catalog imports (D13)

* **Catalog loading:** `src/core/catalog.ts` `resolveCatalog()` follows
  imports depth first. Each imported action records its file.
* **Errors:** a duplicate (`BDD020`, naming both files), a cycle (`BDD023`), a
  missing import (`BDD024`) and a broken one (`BDD022`) are errors at the root
  catalog's import.
* **Wiring:** the indexer uses it and watches imported files. Go to
  Definition, the catalog-position lookup and the binding table use each
  action's own file.
* **Scaffolding:** Declare action counts imported actions as declared;
  Implement refuses to edit an imported catalog.
* **Step envelope:** read from the first schema beside the catalog that lists
  it, either `suite.schema.json` or `suite.base.json`.

| Check | Result |
| --- | --- |
| `npm run test:unit` | **211 passed, 0 failed**; statements and branches **100%** |
| `npm run test:demo` on the 0.5.1 package | **21 passing** |
| Integration against `E:\work\os\os-context-ts`, files navigation, references, hover, coverage, scaffold | first run: 16 passing (oscontext); 6 scaffold failures, all from one regression. "Declared?" read the index, which lags an undo. Fixed so only imported entries come from the index. Rerun of scaffold: **8 passing**. Navigation, references, hover and coverage were not rerun after that fix, because the fix touched only scaffolding |
| Installed in the user's VS Code | `asz.bdd-suite@0.5.1`, sha256 `6fbaf39e9f19ad080ed017b533a44f4af96ecf8d421f26e020bf0ef5f0607bb5` |

E8's editor part, against `samples/workspace`, is stage S5.

## Not done in S1

* **S1.17 (CI):** built, not run.
* **Other languages:** C#, Go, Rust and PowerShell (S2–S4).
* **The divergence check:** paths updated to `runtimes/`; it runs in S4.
* **The VS Code extension's integration suite:** it still uses an os-context
  checkout until `samples/workspace` exists (S5).
