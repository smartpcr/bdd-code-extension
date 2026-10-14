// INV-9: src/core imports neither vscode nor child_process.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';

const coreDir = path.join(__dirname, '../../../src/core');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
}

test('INV-9 no file under src/core imports vscode or child_process', () => {
  const found = files(coreDir);
  assert.ok(found.length > 5, `expected core files in ${coreDir}`);
  for (const f of found) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /from ['"](vscode|child_process|node:child_process)['"]|require\(['"](vscode|child_process)['"]\)/,
      `${path.basename(f)} imports a forbidden module`);
  }
});
