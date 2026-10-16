// The runtime's library with this workspace's extension applied: what an
// editor loads (dist/index.js) to lint a suite exactly as this workspace's
// suiterun does, with the shop's context key known.
import { createLinter as createRuntimeLinter, type Linter, type LinterOptions } from '@bdd-suite/runtime';
import { shop } from './extension.js';

export * from '@bdd-suite/runtime';
export { registrations } from './actions.js';
export { shop } from './extension.js';

/** The runtime's createLinter, with the shop extension ahead of any the caller adds. */
export function createLinter(options: LinterOptions): Linter {
  return createRuntimeLinter({ ...options, extensions: [shop, ...(options.extensions ?? [])] });
}
