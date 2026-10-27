// @smartpcr/bdd-suite-language: the extension's editor-independent core
// (src/core, which never imports vscode, INV-9) for a browser, so a web editor
// answers as the VS Code extension does (YB-1.7). Everything here is a
// re-export; the only additions are the core catalog and the version, which
// build.mjs writes in at build time.

// Suites and libraries, parsed with positions.
export { findExpressions, parseSuite } from '../../../src/core/suites';
export type {
  BindingName, CaptureShape, CaseInfo, Catalog, CatalogAction, CatalogParam, CoreError, HookName, ImportRef, Keyword,
  MetaStepDef, Named, Pos, Range, RegistrationSite, StepHome, StepInfo, SuiteFile,
} from '../../../src/core/types';
export { LineIndex } from '../../../src/core/text';
export { fileKey, lowerDrive } from '../../../src/core/paths';

// Catalogs: parsed, and resolved with their imports through a read callback.
export { CORE_IMPORT, flattenShape, mergeSources, parseCatalog, parseShape, resolveCatalog } from '../../../src/core/catalog';

// The workspace index: steps, catalog entries, registration sites and meta steps by position (definitions, references).
export { contains, WorkspaceIndex } from '../../../src/core/workspaceIndex';
export type { MetaTarget } from '../../../src/core/workspaceIndex';
export {
  compileRecognizers, findHandlerDeclaration, handlerIdentifier, handlerQualifier, scanDeclarations, scanRegistrations,
} from '../../../src/core/registrations';
export type { CompiledRecognizer, SourceDeclarations } from '../../../src/core/registrations';

// What is in scope at a position, and the shape below a capture.
export { capturePathAt, scopeAt, shapeAt, subjectStatus } from '../../../src/core/scope';
export type { CaptureSource, Scope } from '../../../src/core/scope';

// Completion: line contexts and the required-parameter snippet.
export {
  actionPrefix, assertKeyPrefix, assertSubjectPrefix, keyPrefix, metaPrefix, requiredParamsSnippet, stepAtColumn,
  stepKeysAround, withKeyPrefix,
} from '../../../src/core/completionContext';

// The expression cursor inside ${ }.
export { CONTEXT_KEYS, cursorContext, enclosingExpression, FUNCTIONS, NAMESPACES } from '../../../src/core/exprCursor';
export type { ExprContext } from '../../../src/core/exprCursor';

// Hover markdown.
export { actionHoverMarkdown, captureHoverMarkdown } from '../../../src/core/hoverText';
export type { BindingLabel, CaptureHoverSource } from '../../../src/core/hoverText';

// The schema check (Ajv, JSON Schema 2020-12) over a workspace's suite.schema.json.
export { checkAgainstSchema, compileSuiteSchema, librarySchema } from '../../../src/core/schemaCheck';
export type { SchemaFinding } from '../../../src/core/schemaCheck';

// Semantic tokens.
export { suiteTokens, TOKEN_MODIFIERS, TOKEN_TYPES } from '../../../src/core/suiteTokens';
export type { ActionStatus, SubjectStatus, SuiteToken, TokenContext, TokenModifier, TokenType } from '../../../src/core/suiteTokens';

declare const __BDD_SUITE_CORE_CATALOG__: string;
declare const __BDD_SUITE_VERSION__: string;

/**
 * spec/core.catalog.yaml of this version: what `imports: [ bdd-suite:core ]`
 * reads. Pass resolveCatalog a `coreFile` path and return this text when `read`
 * is asked for that path.
 */
export const CORE_CATALOG_TEXT: string = __BDD_SUITE_CORE_CATALOG__;

/** This package's version, the extension's and the runtimes' (they move in lockstep). */
export const VERSION: string = __BDD_SUITE_VERSION__;
