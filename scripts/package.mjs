// B9.1: build the .vsix, record its SHA-256, and check what is in it by listing
// the archive itself (B9.1-1), not by trusting .vscodeignore.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const vsix = path.join(repo, `${pkg.name}-${pkg.version}.vsix`);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });

run('npm', ['run', 'compile']);
fs.rmSync(vsix, { force: true });
// --no-dependencies: esbuild bundles yaml and minimatch into dist/extension.js.
run('npx', ['vsce', 'package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '--out', vsix]);

const sha256 = createHash('sha256').update(fs.readFileSync(vsix)).digest('hex');
fs.writeFileSync(`${vsix}.sha256`, `${sha256}  ${path.basename(vsix)}\n`);

/** The names in a zip's central directory; no tool on PATH is trusted to read zip. */
function zipEntries(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error(`${vsix} is not a zip archive`);
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central directory entry ${i}`);
    const nameLength = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    names.push(buf.toString('utf8', at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
  }
  return names;
}
const entries = zipEntries(fs.readFileSync(vsix));
const inExtension = entries.filter(e => e.startsWith('extension/')).map(e => e.slice('extension/'.length));
const required = ['dist/extension.js', 'dist/lintWorker.js', 'package.json', 'readme.md'];
const problems = [
  // vsce stores the README as readme.md.
  ...required.filter(r => !inExtension.some(e => e.toLowerCase() === r.toLowerCase())).map(r => `missing ${r}`),
  ...(inExtension.some(e => e.startsWith('templates/')) ? [] : ['missing templates/']),
  ...inExtension.filter(e => e.startsWith('.')).map(e => `must not contain ${e}`),
  ...inExtension.filter(e => /^(src|test|out-test|docs|scripts|artifacts|node_modules)\//.test(e) || e.endsWith('.map'))
    .map(e => `must not contain ${e}`),
];
console.log(`\n${path.basename(vsix)}: ${fs.statSync(vsix).size} bytes, sha256 ${sha256}`);
console.log(`${inExtension.length} files under extension/:\n  ${inExtension.join('\n  ')}`);
if (problems.length) {
  console.error(`B9.1-1 failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('B9.1-1: the package holds dist/extension.js, dist/lintWorker.js, templates/, package.json and README.md, and nothing under src/ or test/.');
