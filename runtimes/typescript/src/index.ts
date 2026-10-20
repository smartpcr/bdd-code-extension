// The library API (DEC-B20): the lint path with an overlay-first reader, so
// an editor can lint unsaved text as the saved file would be linted. The
// command line stays file-based; this is the one thing it does not offer.
//
// apiVersion follows semver: a change to LintRequest or Diagnostic that an
// existing caller cannot read changes the major (B7.4-3).
import * as path from 'node:path';
import { compare, Diagnostic as Finding, relativePath } from './diag.js';
import { coreActions } from './actions/core.js';
import { compose, Extension } from './extension.js';
import { schemaRoot as defaultSchemaRoot } from './paths.js';
import { diskReader, overlayReader, Reader } from './reader.js';
import { loadSchema, Schema } from './schema.js';
import { validateFile } from './validate/index.js';

export const apiVersion = '1.1.0';

export type { Extension, ExtensionOption, Rules, RuleInput, RunState } from './extension.js';
export { action, failed, timedOut, assertionFailed } from './actions/registry.js';
export type { Handler, Registration, Request } from './actions/registry.js';
// What a lint rule needs to report a finding where the core would: the finding
// constructors, and the position of a JSON pointer in the parsed suite.
export { error, warning } from './diag.js';
export { at, START } from './model.js';
export { listOf, textOf } from './walk.js';
export { compose, start, CORE_ROOTS, DEFAULT_ENV_PREFIX, ExtensionError } from './extension.js';
// The session (spec/session.md) a test framework drives a suite through, and
// the run context it runs in (docs/test-providers, D11).
export {
  createRunContext, flushTrace, GUARDED_MESSAGE, openLinted, openSession, optionVariable, runContextFromEnv, Session, SuiteRefusedError,
} from './session.js';
export type { RunContext, TeardownResult } from './session.js';
export { runFile, coreOnly, thrownMessage } from './exec.js';
export type { CaseResult, RunObserver, RunOptions, RunExtensions, SuiteResult } from './exec.js';
// Run progress and the observer behind it (spec/progress.md), the name filter,
// and the core this runtime carries (docs/packages, D5).
export { ProgressPrinter, setProgressWriter } from './progress.js';
export { nameMatches } from './suite.js';
export { CORE_IMPORT } from './schema.js';
export { CORE_CATALOG } from './coreCatalog.js';

/** One finding, with exactly the fields of diagnostic.schema.json. */
export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  /** Relative to the repository root, with forward slashes. */
  file: string;
  line: number;
  column: number;
  message: string;
  suggestion?: string;
}

export interface LintRequest {
  /** Absolute paths of the suites to lint. */
  paths: string[];
  /** The binding E201 is checked against when bindingCheck is set; typescript by default. */
  binding?: string;
  bindingCheck?: boolean;
  /** Recorded for the caller's exit decision; findings are the same either way. */
  strict?: boolean;
  /** --param name=value pairs, as the command line takes them. */
  params?: [string, string][];
  /** Absolute path to text, read before the disk for every file the linter opens (TS-5). */
  overlays?: Record<string, string>;
}

export interface Linter {
  /** The sorted findings for the request's paths. */
  lint(request: LintRequest): Diagnostic[];
  /** Drops the cached schema and catalog; the next lint reads them again. */
  invalidate(): void;
}

export interface LinterOptions {
  /** The workspace root: findings are relative to it. */
  root: string;
  /** Where suite.schema.json and actions.catalog.yaml are, when not under root. */
  schemaRoot?: string;
  /** The reader beneath the overlays; the disk by default. */
  reader?: Reader;
  /** Extensions whose context keys and lint rules apply (added in 1.1.0). */
  extensions?: Extension[];
}

const plain = (d: Finding): Diagnostic => ({
  code: d.code, severity: d.severity, file: d.file, line: d.position.line, column: d.position.column, message: d.message,
  ...(d.suggestion ? { suggestion: d.suggestion } : {}),
});

export function createLinter(options: LinterOptions): Linter {
  const root = path.resolve(options.root);
  const schemaRoot = options.schemaRoot ?? defaultSchemaRoot(root);
  let schema: Schema | undefined;
  const extensions = compose(options.extensions ?? [], coreActions);
  return {
    lint(request) {
      const reader = overlayReader(request.overlays ?? {}, options.reader ?? diskReader);
      schema ??= loadSchema(schemaRoot, reader);
      const settings = { binding: request.binding ?? 'typescript', bindingCheck: !!request.bindingCheck, params: request.params ?? [], extensions };
      const found: Finding[] = [];
      for (const file of request.paths) found.push(...validateFile(path.resolve(file), relativePath(path.resolve(file), root), schema, settings, reader));
      return found.sort(compare).filter((d, i, all) => i === 0 || compare(all[i - 1]!, d) !== 0).map(plain);
    },
    invalidate() {
      schema = undefined;
    },
  };
}
