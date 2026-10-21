// What the extension carries so that a workspace needs no copy of the spec or a
// TypeScript binding of its own (docs/packages, D12, D13, DEC-P07, DEC-P08): the
// core catalog `bdd-suite:core` names, the schema generator, and the TypeScript
// runtime as a linter. No vscode import, so it is unit-tested in Node.
import * as path from 'path';

export interface BundledFiles {
  /** spec/core.catalog.yaml: what `imports: [ bdd-suite:core ]` reads. */
  core: string;
  /** spec/Build-Schema.ps1: the default `bddSuite.schemaGenerator`. */
  generator: string;
  /** The TypeScript runtime, bundled into one ES module the lint worker loads. */
  runtime: string;
}

/** The bundled files under the extension's install folder. */
export function bundledFiles(extensionPath: string): BundledFiles {
  return {
    core: path.join(extensionPath, 'spec', 'core.catalog.yaml'),
    generator: path.join(extensionPath, 'spec', 'Build-Schema.ps1'),
    runtime: path.join(extensionPath, 'dist', 'runtime', 'index.mjs'),
  };
}

/**
 * A setting's argv with `${extension}` (the extension's install folder) and
 * `${catalogPath}` (the workspace catalog) filled in. Without an install folder
 * (a unit test) `${extension}` is left as written.
 */
export function expandArgv(argv: readonly string[], catalogPath: string, extensionPath?: string): string[] {
  return argv.map(a => {
    const withCatalog = a.split('${catalogPath}').join(catalogPath);
    return extensionPath === undefined ? withCatalog : withCatalog.split('${extension}').join(extensionPath);
  });
}

/** The library the lint worker loads, and whether it is the extension's own. */
export interface LintLibrary {
  path: string;
  bundled: boolean;
}

/**
 * The binding's library when it exists in the workspace; otherwise, for the
 * TypeScript lint tool, the runtime the extension carries (DEC-P08). Any other
 * tool keeps its missing library, which reports "not built" as before.
 */
export function lintLibrary(configured: string, tool: string, runtime: string | undefined, exists: (p: string) => boolean): LintLibrary {
  if (exists(configured) || tool !== 'typescript' || runtime === undefined || !exists(runtime)) return { path: configured, bundled: false };
  return { path: runtime, bundled: true };
}
