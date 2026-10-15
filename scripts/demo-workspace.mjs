// Makes a fresh copy of the demo workspace (test/e2e-demo/fixture) to try the
// extension by hand. The fixture itself is never edited, so every copy starts
// from the same state.
//
//   npm run demo:workspace                     copies to %TEMP%/bdd-suite-demo (or $TMPDIR)
//   npm run demo:workspace -- <folder>         copies there
//   npm run demo:workspace -- <folder> --open  and opens it in VS Code
//   ... --force                                replaces an existing copy
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const target = path.resolve(args.find(a => !a.startsWith('--')) ?? path.join(os.tmpdir(), 'bdd-suite-demo'));
if (fs.existsSync(target)) {
  if (!args.includes('--force')) {
    console.error(`${target} already exists; pass --force to replace it.`);
    process.exit(2);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
fs.cpSync(path.join(repo, 'test', 'e2e-demo', 'fixture'), target, { recursive: true });
const { name, version } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const vsix = path.join(repo, 'out', `${name}-${version}.vsix`);

console.log(`Demo workspace: ${target}

1. Install the extension (once):   code --install-extension "${vsix}"
2. Open the folder and trust it:   code "${target}"

Then, in test/e2e/suites/orders.yml and demo.yml:
  * F12 or Ctrl+click on an action value   the catalog entry and each language's handler: the C# method, Go func, Rust fn, TS function
  * Ctrl+F12 on an action value     each language's registration line
  * Shift+F12 in CoreActions.cs on a method name or registration, or the CodeLens above it: back to the YAML steps
  * F12 on \`meta: place-order\`      the meta step in _lib/orders-steps.yml
  * Lightbulb (Ctrl+.) on \`action: orders.ship\`     Implement orders.ship in C# (or Go, Rust)
  * Save orders.yml: E104 on \`orders.refund\`; its lightbulb declares it, then Implement in C#
Lint here uses tools/fake-lint.mjs (it reports E104 only) and the schema generator is tools/gen-schema.mjs.`);

if (args.includes('--open')) spawnSync('code', [target], { stdio: 'inherit', shell: process.platform === 'win32' });
