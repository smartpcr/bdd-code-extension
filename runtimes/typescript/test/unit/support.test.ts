// diag.ts, spelling.ts, walk.ts and reader.ts.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { compare, Diagnostic, error, fails, human, relativePath, sorted, toJsonArray, warning } from '../../src/diag.js';
import { loadDocument } from '../../src/model.js';
import { diskReader, overlayReader } from '../../src/reader.js';
import { distance, nearest } from '../../src/spelling.js';
import { allSteps, listOf, stepLists, tableColumns, textOf } from '../../src/walk.js';
import { mapOf, ValueMap } from '../../src/value.js';

const P = (line: number, column: number) => ({ line, column });

test('diag: the total order, adjacent duplicates dropped, fails, human and JSON forms', () => {
  const a = error('E101', 'a.yml', P(2, 1), 'm');
  const list: Diagnostic[] = [error('E102', 'b.yml', P(1, 1), 'm'), a, warning('W301', 'a.yml', P(1, 5), 'w'), { ...a },
    error('E101', 'a.yml', P(2, 1), 'n'), error('E100', 'a.yml', P(2, 1), 'm'), error('E101', 'a.yml', P(1, 9), 'm')];
  const s = sorted(list);
  assert.deepEqual(s.map(d => `${d.file}:${d.position.line}:${d.position.column}:${d.code}:${d.message}`),
    ['a.yml:1:5:W301:w', 'a.yml:1:9:E101:m', 'a.yml:2:1:E100:m', 'a.yml:2:1:E101:m', 'a.yml:2:1:E101:n', 'b.yml:1:1:E102:m']);
  assert.equal(compare(a, { ...a }), 0);
  assert.equal(fails([warning('W301', 'a', P(1, 1), 'w')], false), false);
  assert.equal(fails([warning('W301', 'a', P(1, 1), 'w')], true), true);
  assert.equal(fails([a], false), true);
  assert.equal(fails([], true), false);
  assert.equal(human(a), 'a.yml:2:1  E101  m');
  assert.equal(human(error('E101', 'a.yml', P(2, 1), 'm', 'Did you mean x')), 'a.yml:2:1  E101  m\n    Did you mean x');
  assert.equal(toJsonArray([]), '[]');
  assert.deepEqual(JSON.parse(toJsonArray([error('E104', 'f', P(3, 4), 'x', 'hint'), a])), [
    { code: 'E104', severity: 'error', file: 'f', line: 3, column: 4, message: 'x', suggestion: 'hint' },
    { code: 'E101', severity: 'error', file: 'a.yml', line: 2, column: 1, message: 'm' },
  ]);
  const root = path.resolve('/repo');
  assert.equal(relativePath(path.join(root, 'test', 'x.yml'), root), 'test/x.yml');
  assert.equal(relativePath(path.resolve('/other/x.yml'), root), path.resolve('/other/x.yml').replace(/\\/g, '/'));
});

test('spelling: case-blind distance; the nearest, ties to the first in order, then the prefix rule', () => {
  assert.equal(distance('Asserts', 'asserts'), 0);
  assert.equal(distance('', 'abc'), 3);
  assert.equal(distance('abc', ''), 3);
  assert.equal(distance('kitten', 'sitting'), 3);
  assert.equal(nearest('', ['a'], 2), '');
  assert.equal(nearest('timeout', ['timeoutSec', 'tags'], 2), 'timeoutSec');
  assert.equal(nearest('asert', ['asserts', 'assert'], 2), 'assert');
  assert.equal(nearest('ab', ['ac', 'aa'], 1), 'aa', 'a tie goes to the first in order');
  assert.equal(nearest('cluster.suspned', ['cluster.suspend', 'cluster.resume'], 3), 'cluster.suspend');
  assert.equal(nearest('lifecycle', ['', 'lifecycle.get', 'lifecycle.getAll'], 2), 'lifecycle.get', 'the shortest that the word starts');
  assert.equal(nearest('lifecycle.getEverything', ['lifecycle.get'], 2), 'lifecycle.get', 'or that starts the word');
  assert.equal(nearest('abc', ['abcdefgh'], 1), '', 'fewer than four shared characters');
  assert.equal(nearest('zzzz', ['yyyy'], 1), '');
});

test('walk: every step in visiting order with pointers, forStep first; every present list; table columns', () => {
  const suite = loadDocument(`setup:
  - action: a
teardown: []
metaSteps:
  - name: m
    steps:
      - action: b
  - nope
tests:
  - name: c
    setup:
      - action: c
    steps:
      - action: d
        forStep: { action: e }
      - just-text
  - text
`).value as ValueMap;
  assert.deepEqual(allSteps(suite).map(e => [e.pointer, e.phase, e.order]), [
    ['/setup/0', 'setup', 0], ['/metaSteps/0/steps/0', 'meta m', 0], ['/tests/0/setup/0', 'setup', 0],
    ['/tests/0/steps/0/forStep', 'steps', -1], ['/tests/0/steps/0', 'steps', 0],
  ]);
  assert.deepEqual(stepLists(suite).map(l => [l.pointer, l.name, l.caseIndex]), [
    ['/setup', 'the suite setup', -1], ['/teardown', 'the suite teardown', -1], ['/metaSteps/0/steps', 'meta step m', -1],
    ['/tests/0/setup', 'case c setup', 0], ['/tests/0/steps', 'case c steps', 0],
  ]);
  assert.deepEqual(allSteps(undefined), []);
  assert.equal(textOf(mapOf({ a: 1n }), 'a'), '');
  assert.equal(textOf(undefined, 'a'), '');
  assert.equal(listOf(mapOf({ a: 'x' }), 'a'), undefined);
  assert.deepEqual(tableColumns(['x', mapOf({ node: 'N1', drain: true })]), ['node', 'drain']);
  assert.deepEqual(tableColumns('x'), []);
});

test('readers: the disk, and overlays first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-reader-'));
  const f = path.join(dir, 'a.yml');
  fs.writeFileSync(f, 'disk');
  assert.equal(diskReader.read(f), 'disk');
  assert.equal(diskReader.read(path.join(dir, 'none')), undefined);
  const r = overlayReader({ [path.join(dir, 'B.yml')]: 'unsaved' });
  assert.equal(r.read(f), 'disk');
  assert.equal(r.read(path.join(dir, process.platform === 'win32' ? 'b.yml' : 'B.yml')), 'unsaved');
});
