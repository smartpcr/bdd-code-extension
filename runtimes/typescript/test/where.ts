// Where the tests find the corpus and its schema, and the extension the corpus
// is run with. The corpus lives at the repository root (conformance/), with
// its own catalog and schema (conformance/schema); this runtime is
// runtimes/typescript, so both are two folders up from the package.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreActions } from '../src/actions/core.js';
import { action, failed } from '../src/actions/registry.js';
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
 * and expression table read, with the values of expressions/context.yaml. It
 * also implements fixture.append, which changes the list it is given in place
 * (execute/capture-isolation.yml), and fixture.throw, which throws a bare
 * string, TypeScript's most unusual failure (execute/worker-throws.yml,
 * spec/progress.md).
 */
export const corpusExtension: Extension = {
  name: 'the corpus',
  actions: [action('fixture.append', async request => {
    const list = request.step.get('list');
    if (!Array.isArray(list)) throw failed('fixture.append: list must be a list');
    list.push(request.step.get('item') ?? null);
    return list;
  }), action('fixture.throw', async request => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point: not an Error
    throw String(request.step.get('message') ?? '');
  })],
  contextKeys: ['cluster', 'target', 'labId', 'apiUrl'],
  start: () => ({ context: { cluster: 'HOST-CL01', target: 'HOST-N1', labId: 'lab1', apiUrl: 'http://api/api/v1' } }),
};

export const corpusComposite = compose([corpusExtension], coreActions);

/** The command line the corpus tests spawn: suiterun with the corpus extension. */
export const corpusCli = path.join(pkg, 'dist-test', 'test', 'conformance', 'cli.js');

/** This runtime's name in a manifest entry's pendingIn. */
export const runtime = 'typescript';

/**
 * pendingIn (conformance/README.md): an entry of any kind this runtime does
 * not meet yet is neither run nor counted as passed. Splits a manifest list
 * into the entries to run and those to report as pending.
 */
export function splitPending<T extends { pendingIn?: string[] }>(entries: readonly T[]): { run: T[]; pending: T[] } {
  const isPending = (e: T) => (e.pendingIn ?? []).includes(runtime);
  return { run: entries.filter(e => !isPending(e)), pending: entries.filter(isPending) };
}
