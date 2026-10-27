# @smartpcr/bdd-suite-language

The language core of the BDD suite format, built for a browser. It is the
extension's `src/core` (the part that never imports `vscode`), so a web editor
gets the same answers as the VS Code extension: suites and catalogs parsed with
positions, what is in scope at a cursor, completion contexts, hover text, the
schema check, semantic tokens, and where a meta step or an action is defined.

One ES module, `yaml` and `ajv` inside, no Node built-ins. Its version is the
extension's and the runtimes' (they move in lockstep).

## Use

```ts
import {
  CORE_CATALOG_TEXT, parseSuite, resolveCatalog, WorkspaceIndex, scopeAt, suiteTokens,
} from '@smartpcr/bdd-suite-language';

// Paths are names, not files: the package never reads anything. In a browser they
// follow POSIX rules and a relative path resolves against /.
const CORE = '/bdd-suite/core.catalog.yaml';
const files: Record<string, string> = { [CORE]: CORE_CATALOG_TEXT, '/bvt/schema/actions.catalog.yaml': catalogText };

// `imports: [ bdd-suite:core ]` reads the path given as coreFile through the callback.
const catalog = resolveCatalog(catalogText, '/bvt/schema/actions.catalog.yaml', f => files[f], CORE);

const index = new WorkspaceIndex();
index.updateCatalog(catalog);
index.updateSuite(parseSuite(suiteText, '/bvt/suites/update-location.yml'));
index.updateSuite(parseSuite(libraryText, '/bvt/suites/_lib/urp.yml'));

const scope = scopeAt(index, '/bvt/suites/update-location.yml', { line: 30, character: 16 });
```

A suite's `imports:` resolve against the suite's own path, so give each file the
path it has in the package (`suites/_lib/urp.yml` under the same root as its
suites). Index lookups take any spelling of a path; `fileKey` is the key they
compare.

## What it exports

| Area | Exports |
| --- | --- |
| Suites | `parseSuite`, `findExpressions`, the types (`SuiteFile`, `StepInfo`, `CaseInfo`, `MetaStepDef`, `ImportRef`, ...), `LineIndex`, `fileKey`, `lowerDrive` |
| Catalogs | `parseCatalog`, `resolveCatalog` (with a read callback), `parseShape`, `flattenShape`, `mergeSources`, `CORE_IMPORT`, `CORE_CATALOG_TEXT` |
| Index and definitions | `WorkspaceIndex` (`stepAt`, `actionNameAt`, `metaTargetOf`, `metaDefinitionAt`, `metaUses`, `visibleMetaSteps`, `stepsUsing`, `sitesFor`, ...), `contains`, `compileRecognizers`, `scanRegistrations`, `scanDeclarations`, `findHandlerDeclaration`, `handlerIdentifier`, `handlerQualifier` |
| Scope and shapes | `scopeAt`, `shapeAt`, `subjectStatus`, `capturePathAt` |
| Completion | `actionPrefix`, `metaPrefix`, `keyPrefix`, `withKeyPrefix`, `assertKeyPrefix`, `assertSubjectPrefix`, `stepAtColumn`, `stepKeysAround`, `requiredParamsSnippet` |
| Expressions | `cursorContext`, `enclosingExpression`, `FUNCTIONS`, `NAMESPACES`, `CONTEXT_KEYS` |
| Hover | `actionHoverMarkdown`, `captureHoverMarkdown` |
| Schema | `compileSuiteSchema`, `checkAgainstSchema`, `librarySchema` (give it the workspace's generated `suite.schema.json`) |
| Semantic tokens | `suiteTokens`, `TOKEN_TYPES`, `TOKEN_MODIFIERS` |
| Version | `VERSION` |

The declarations name types from `yaml` and `ajv`, which is why they are
dependencies; the code itself does not load them.

## Build and test

From the repository root:

```
npm run build:language   # dist/index.js and dist/index.d.ts
npm run test:language    # builds, then loads the bundle in a jsdom window and exercises each export
```
