// Where the tests find the corpus and its schema, and the extension the corpus
// is run with. The corpus lives at the repository root (conformance/), with
// its own catalog and schema (conformance/schema); this runtime is
// runtimes/typescript, so both are two folders up from the package.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreActions } from '../src/actions/core.js';
import { compose, Extension } from '../src/extension.js';

/** The package folder: dist-test/test is where this file runs from. */
export const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** This repository's root. */
export const repo = path.resolve(pkg, '..', '..');
export const corpus = path.join(repo, 'conformance');
export const corpusSchema = path.join(corpus, 'schema');
/** The core catalog every runtime implements exactly. */
export const coreCatalog = path.join(repo, 'spec', 'core.catalog.yaml');

/**
 * The corpus's context keys (conformance/README.md): the core defines none
 * beyond timeoutSec and defaults, so the corpus declares the ones its suites
 * and expression table read, with the values of expressions/context.yaml.
 */
export const corpusExtension: Extension = {
  name: 'the corpus',
  contextKeys: ['cluster', 'target', 'labId', 'apiUrl'],
  start: () => ({ context: { cluster: 'HOST-CL01', target: 'HOST-N1', labId: 'lab1', apiUrl: 'http://api/api/v1' } }),
};

export const corpusComposite = compose([corpusExtension], coreActions);

/** The command line the corpus tests spawn: suiterun with the corpus extension. */
export const corpusCli = path.join(pkg, 'dist-test', 'test', 'conformance', 'cli.js');
