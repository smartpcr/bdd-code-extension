// Writes (or, with --check, checks) the generated tests for each framework:
// the two shared configs, once per provider, each into its own folder.
//
//   node generate.mjs [--check]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The real path: the runtime's cli.js runs only when it is the script node was given.
const cli = fs.realpathSync(path.join(here, 'node_modules', '@bdd-suite', 'runtime', 'dist', 'cli.js'));
const check = process.argv.includes('--check');
let code = 0;
for (const provider of ['node', 'vitest', 'jest']) {
  for (const config of ['shop', 'corpus']) {
    const argv = [cli, 'generate', '--config', `shared/${config}.tests.yaml`, '--provider', provider, '--out', `${provider}/${config}`, ...(check ? ['--check'] : [])];
    const r = spawnSync(process.execPath, argv, { cwd: here, stdio: 'inherit' });
    code = Math.max(code, r.status ?? 2);
  }
}
process.exitCode = code;
