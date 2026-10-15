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
