// Builds the TypeScript runtime this package depends on (file:), because its
// dist/ is not committed: installs its dependencies when they are missing,
// then compiles it. Run by `npm run build` before this package's own tsc.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.resolve(here, '../../../../../../../runtimes/typescript');

function npm(...args) {
  // One fixed command line through the shell, which Windows needs to find npm.cmd.
  const result = spawnSync(`npm ${args.join(' ')}`, { cwd: runtime, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`npm ${args.join(' ')} failed in ${runtime}`);
    process.exit(result.status ?? 1);
  }
}

if (!fs.existsSync(path.join(runtime, 'package.json'))) {
  console.error(`The TypeScript runtime is not at ${runtime}.`);
  process.exit(1);
}
if (!fs.existsSync(path.join(runtime, 'node_modules'))) npm('ci');
npm('run', 'build');
