// Bundles the extension into one file, and the lint worker (plan 2.4b) into a
// second. `vscode` is provided by the host; the worker never imports it.
import { build } from 'esbuild';

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'warning',
};

await build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] });
await build({ ...common, entryPoints: ['src/lint/worker.ts'], outfile: 'dist/lintWorker.js' });
// The TypeScript runtime, with ajv and yaml, as one ES module: the linter the
// worker loads when the workspace has no TypeScript library (docs/packages,
// D13, DEC-P08). It is the runtime of this checkout, the extension's version.
await build({ ...common, format: 'esm', entryPoints: ['runtimes/typescript/src/index.ts'], outfile: 'dist/runtime/index.mjs',
  // ajv is CommonJS and calls require; an ES module has none of its own.
  banner: { js: "import { createRequire as __bddRequire } from 'node:module'; const require = __bddRequire(import.meta.url);" } });
