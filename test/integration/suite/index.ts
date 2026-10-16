// Mocha entry inside the extension host. Runs the test files of the session
// named by BDD_SESSION (a file's first line says `// session: <name>`),
// narrowed to the files whose names start with one of BDD_FILES when it is set.
// With BDD_RESULTS_FILE, each test's outcome is written there as JSON (B9.2).
import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

interface TestOutcome {
  file: string;
  title: string;
  state: 'passed' | 'failed' | 'pending';
  error?: string;
}

export function run(): Promise<void> {
  const session = process.env.BDD_SESSION ?? 'sample';
  const mocha = new Mocha({ ui: 'bdd', timeout: 120_000, color: false, reporter: 'spec' });
  for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()) {
    const first = fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n').find(l => l.includes('session:')) ?? '';
    const files = (process.env.BDD_FILES ?? '').split(',').filter(Boolean);
    if (files.length && !files.some(p => f.startsWith(p))) continue;
    if (first.includes(`session: ${session}`)) mocha.addFile(path.join(__dirname, f));
  }
  const outcomes: TestOutcome[] = [];
  const name = (t: Mocha.Runnable) => path.basename(t.file ?? '').replace(/\.js$/, '.ts');
  return new Promise((resolve, reject) => {
    const runner = mocha.run(failures => {
      const out = process.env.BDD_RESULTS_FILE;
      if (out) fs.writeFileSync(out, JSON.stringify({ session, outcomes }, null, 2));
      if (failures) reject(new Error(`${failures} test(s) failed`));
      else resolve();
    });
    runner.on('pass', t => outcomes.push({ file: name(t), title: t.fullTitle(), state: 'passed' }));
    runner.on('pending', t => outcomes.push({ file: name(t), title: t.fullTitle(), state: 'pending' }));
    runner.on('fail', (t, e) => outcomes.push({ file: name(t), title: t.fullTitle(), state: 'failed', error: String(e?.message ?? e).slice(0, 500) }));
  });
}
