// Exits 1 when a runtime manifest or a lock file that records a runtime holds a
// version other than package.json's (docs/packages, DEC-P03; E10). The fix is
// `npm run set-version`.
// Needs `npm run build:test` first (it imports the compiled module).
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const { versionProblems, VERSION_FILES } = require('../out-test/src/tools/versions.js');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = file => path.join(repo, file);
const { version } = JSON.parse(readFileSync(at('package.json'), 'utf8'));

const problems = versionProblems(file => (existsSync(at(file)) ? readFileSync(at(file), 'utf8') : undefined), version);
if (problems.length) {
  console.log(`Versions differ from package.json's ${version}; run npm run set-version:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`${VERSION_FILES.length} files are at ${version}`);
