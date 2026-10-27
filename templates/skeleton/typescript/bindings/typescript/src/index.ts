// The runtime's library with this workspace's extension applied: what the
// editor loads (dist/index.js, bddSuite.bindings.typescript.library) to lint a
// suite as this workspace's suiterun does, in process.
import { createLinter as createRuntimeLinter, type Linter, type LinterOptions } from '@bdd-suite/runtime';
import { {{prefix}}Extension } from './extension.js';

export * from '@bdd-suite/runtime';
export { registrations } from './actions.js';
export { {{prefix}}Extension } from './extension.js';

/** The runtime's createLinter, with this extension ahead of any the caller adds. */
export function createLinter(options: LinterOptions): Linter {
  return createRuntimeLinter({ ...options, extensions: [{{prefix}}Extension, ...(options.extensions ?? [])] });
}
