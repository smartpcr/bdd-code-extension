// Mocha entry inside the extension host for the demo: every *.test.js here, in order.
import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 120_000, color: false, reporter: 'spec' });
  for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort()) mocha.addFile(path.join(__dirname, f));
  return new Promise((resolve, reject) => {
    mocha.run(failures => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
