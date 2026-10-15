// paths.ts: the repository root, and the two-character glob every binding shares.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { matchesGlob, repositoryRoot, resolveGlob, schemaRoot } from '../../src/paths.js';

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-paths-'));
  fs.mkdirSync(path.join(root, 'test', 'e2e', 'schema'), { recursive: true });
  fs.mkdirSync(path.join(root, 'suites', 'deep'), { recursive: true });
  for (const f of ['b.yml', 'a.yml', 'c.yaml', 'ab.yml']) fs.writeFileSync(path.join(root, 'suites', f), '');
  fs.mkdirSync(path.join(root, 'suites', 'dir.yml'));
  return root;
}

test('repositoryRoot walks up to test/e2e/schema, and says so when there is none', () => {
  const root = tree();
  assert.equal(repositoryRoot(path.join(root, 'suites', 'deep')), root);
  assert.equal(repositoryRoot(root), root);
  assert.equal(repositoryRoot(path.parse(root).root), undefined);
  assert.equal(schemaRoot(root), path.join(root, 'test', 'e2e', 'schema'));
});

test('matchesGlob: * is any run, ? is one, and nothing else is special', () => {
  const rows: [string, string, boolean][] = [
    ['*.yml', 'a.yml', true], ['*.yml', 'a.yaml', false], ['a?.yml', 'ab.yml', true], ['a?.yml', 'a.yml', false],
    ['*', '', true], ['', '', true], ['', 'a', false], ['a*b*c', 'axxbyyc', true], ['a*b*c', 'axxbyy', false],
    ['**', 'abc', true], ['[a].yml', 'a.yml', false], ['[a].yml', '[a].yml', true], ['*a', 'aaa', true], ['a**', 'a', true],
  ];
  for (const [p, n, want] of rows) assert.equal(matchesGlob(p, n), want, `${p} ~ ${n}`);
});

test('resolveGlob: sorted files in the last segment\'s directory; a plain name must be a file', () => {
  const root = tree();
  const s = path.join(root, 'suites');
  assert.deepEqual(resolveGlob('suites/*.yml', root), ['a.yml', 'ab.yml', 'b.yml'].map(f => path.join(s, f)));
  assert.deepEqual(resolveGlob('suites\\a?.yml', root), [path.join(s, 'ab.yml')]);
  assert.deepEqual(resolveGlob(path.join(s, 'c.yaml'), '/elsewhere'), [path.join(s, 'c.yaml')]);
  assert.throws(() => resolveGlob('suites/none.yml', root), /suites\/none\.yml names no file/);
  assert.throws(() => resolveGlob('suites/dir.yml', root), /names no file/);
  assert.throws(() => resolveGlob('suites/*.json', root), /names no file/);
  assert.throws(() => resolveGlob('missing/*.yml', root), /cannot be read/);
});
