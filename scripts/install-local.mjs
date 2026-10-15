// Rebuild the .vsix and install it into your own VS Code, replacing the copy
// installed there, so the editor runs the code as it is now. Reload the window
// afterwards for the new copy to load; from 0.4.1 an open window offers that itself
// (a "Reload for Suite Authoring <version>" status bar button).
//
//   npm run install:local                  uses the `code` CLI on PATH
//   BDD_VSCODE_CLI=code-insiders npm run install:local
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const vsix = path.join(repo, `${pkg.name}-${pkg.version}.vsix`);
const shell = process.platform === 'win32';

execFileSync('node', [path.join(repo, 'scripts', 'package.mjs')], { cwd: repo, stdio: 'inherit' });
const cli = process.env.BDD_VSCODE_CLI ?? 'code';
execFileSync(cli, ['--install-extension', vsix, '--force'], { cwd: repo, stdio: 'inherit', shell });
const listed = execFileSync(cli, ['--list-extensions', '--show-versions'], { encoding: 'utf8', shell });
const id = `${pkg.publisher}.${pkg.name}@${pkg.version}`;
if (!listed.includes(id)) throw new Error(`${id} is not listed by ${cli} after installing`);
const sha = fs.readFileSync(`${vsix}.sha256`, 'utf8').split(/\s+/)[0];
console.log(`\nInstalled ${id} (sha256 ${sha}) with ${cli}. Each open window loads it on reload: click "Reload for Suite Authoring" in its status bar (0.4.1 and later), or run "Developer: Reload Window".`);
