// Writes the settings defaults from src/config/defaults.ts into package.json.
// With --check it only compares and exits 1 on a difference.
// Needs `npm run build:test` first (it imports the compiled module).
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { configurationContribution } = require('../out-test/src/config/packageConfig.js');
const file = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(file, 'utf8'));
const wanted = configurationContribution();

if (process.argv.includes('--check')) {
  const same = JSON.stringify(pkg.contributes.configuration) === JSON.stringify(wanted);
  console.log(same ? 'package.json defaults are in sync' : 'package.json defaults differ; run npm run sync-defaults');
  process.exit(same ? 0 : 1);
}
pkg.contributes.configuration = wanted;
writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('package.json defaults written');
