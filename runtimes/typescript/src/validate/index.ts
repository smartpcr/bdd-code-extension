// One suite file through every pass: load (E100), structure (E101-E105),
// imports, semantics (E2xx, W302, W304) and dataflow (E3xx, W301, W303).
import { Diagnostic, error, sorted } from '../diag.js';
import { loadDocument, START } from '../model.js';
import { diskReader, Reader } from '../reader.js';
import { Schema } from '../schema.js';
import { coreActions } from '../actions/core.js';
import { compose, Composite } from '../extension.js';
import { isMap } from '../value.js';
import { checkDataflow } from './dataflow.js';
import { checkSemantics, readImports } from './semantics.js';
import { checkStructure } from './structure.js';

export interface ValidateOptions {
  binding: string;
  bindingCheck: boolean;
  params: [string, string][];
  /** <prefix>PARAM_<NAME> variables count as parameter values; injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** The runtime's extensions: their context keys, lint rules and environment prefix. The core alone by default. */
  extensions?: Composite;
}

/** The findings for one file, sorted; throws when the file cannot be read at all. */
export function validateFile(file: string, relative: string, schema: Schema, options: ValidateOptions, reader: Reader = diskReader): Diagnostic[] {
  const text = reader.read(file);
  if (text === undefined) throw new Error(`${file} cannot be read.`);
  let doc;
  try {
    doc = loadDocument(text);
  } catch (e) {
    // At 1:1 whatever the parser says or throws: four parsers stop in four places on one broken file (B7.2-3).
    return [error('E100', relative, START, `The file is not valid YAML: ${(e as Error).message}`)];
  }
  if (!isMap(doc.value)) return [error('E100', relative, START, 'The file does not hold a YAML mapping, so it cannot be a suite.')];
  const library = readImports(doc, relative, file, reader);
  const extensions = options.extensions ?? compose([], coreActions);
  return sorted([
    ...checkStructure(doc, relative, schema),
    ...checkSemantics(doc, relative, schema, library, { ...options, envPrefix: extensions.envPrefix }),
    ...checkDataflow(doc, relative, schema, library, extensions.contextKeys),
    ...extensions.lint({ doc, file: relative, suite: doc.value, library }),
  ]);
}
