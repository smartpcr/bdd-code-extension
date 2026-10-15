// Coverage gate for the package (plan B7.2, B7.3-3): every source file at 100
// percent of lines, and the two modules where bindings diverge quietly (the
// expression evaluator and the assertion comparer) at 100 percent of
// branches. Reads coverage/coverage-summary.json, which `npm test` writes.
import * as fs from 'node:fs';
import * as path from 'node:path';

const BRANCH_FILES = ['expr.ts', 'assertion.ts'];
const summary = JSON.parse(fs.readFileSync(path.join('coverage', 'coverage-summary.json'), 'utf8'));
const failures = [];
for (const [file, totals] of Object.entries(summary)) {
  if (file === 'total') continue;
  const name = path.basename(file);
  if (totals.lines.pct < 100) failures.push(`${file}: lines ${totals.lines.pct}%`);
  if (BRANCH_FILES.includes(name) && totals.branches.pct < 100) failures.push(`${file}: branches ${totals.branches.pct}%`);
}
for (const name of BRANCH_FILES) {
  if (!Object.keys(summary).some(f => path.basename(f) === name)) failures.push(`${name}: not in the coverage report`);
}
if (failures.length) {
  console.error(`Coverage gate failed:\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log('Coverage gate: every file at 100% of lines; expr.ts and assertion.ts at 100% of branches.');
}
