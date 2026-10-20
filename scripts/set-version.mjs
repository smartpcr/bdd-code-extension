// Writes package.json's version into every runtime manifest and the lock files
// that record a runtime by path (docs/packages, DEC-P03). Bump package.json
// first (npm version <x.y.z> --no-git-tag-version), then run this.
// Needs `npm run build:test` first (it imports the compiled module).
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const { stampVersions } = require('../out-test/src/tools/versions.js');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = file => path.join(repo, file);
const { version } = JSON.parse(readFileSync(at('package.json'), 'utf8'));

const changed = stampVersions(
  file => (existsSync(at(file)) ? readFileSync(at(file), 'utf8') : undefined),
  (file, text) => writeFileSync(at(file), text),
  version);
console.log(changed.length ? `set ${version} in:\n  ${changed.join('\n  ')}` : `every runtime is at ${version} already`);
