// Builds @smartpcr/bdd-suite-language (YB-1.7): src/core for a browser, as one
// ES module with yaml and ajv inside (dist/index.js), and its declarations
// (dist/index.d.ts over dist/types). platform 'browser' makes a Node built-in
// a build error, not a runtime one.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const here = import.meta.dirname;
const repo = path.resolve(here, '../..');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const { version } = readJson(path.join(here, 'package.json'));
const extension = readJson(path.join(repo, 'package.json')).version;
// Lockstep with the extension (docs/packages, DEC-P03); npm run set-version stamps both.
if (version !== extension) throw new Error(`packages/language is at ${version}, package.json at ${extension}; run npm run set-version`);

const dist = path.join(here, 'dist');
rmSync(dist, { recursive: true, force: true });
// One line ending whatever the checkout's, so every build carries the same text.
const core = readFileSync(path.join(repo, 'spec', 'core.catalog.yaml'), 'utf8').replace(/\r\n/g, '\n');

await build({
  entryPoints: [path.join(here, 'src', 'index.ts')],
  outfile: path.join(dist, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'warning',
  define: { __BDD_SUITE_CORE_CATALOG__: JSON.stringify(core), __BDD_SUITE_VERSION__: JSON.stringify(version) },
});

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', path.join(here, 'tsconfig.json')], { stdio: 'inherit' });
mkdirSync(dist, { recursive: true });
writeFileSync(path.join(dist, 'index.d.ts'), "export * from './types/packages/language/src/index';\n");

console.log(`packages/language/dist/index.js: ${statSync(path.join(dist, 'index.js')).size} bytes (${version})`);
