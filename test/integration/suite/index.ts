// Mocha entry inside the extension host. Runs the test files of the session
// named by BDD_SESSION (a file's first line says `// session: <name>`).
import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const session = process.env.BDD_SESSION ?? 'oscontext';
  const mocha = new Mocha({ ui: 'bdd', timeout: 120_000, color: false, reporter: 'spec' });
  for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()) {
    const first = fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n').find(l => l.includes('session:')) ?? '';
    if (first.includes(`session: ${session}`)) mocha.addFile(path.join(__dirname, f));
  }
  return new Promise((resolve, reject) => {
    mocha.run(failures => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
