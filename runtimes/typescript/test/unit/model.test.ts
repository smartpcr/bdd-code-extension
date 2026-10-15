// model.ts: the value as yaml.v3 and Go's model read it, and where each part is.
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { at, child, escape, loadDocument, LoadError, resolvePlain, START } from '../../src/model.js';
import { isMap } from '../../src/value.js';

test('resolvePlain follows yaml.v3 then Go\'s model', () => {
  const rows: [string, unknown][] = [
    ['', null], ['~', null], ['null', null], ['NULL', null], ['true', true], ['False', false], ['yes', 'yes'],
    ['2', 2n], ['017', 15n], ['0x10', 16n], ['1_000', 1000n], ['2.0', 2], ['1e3', 1000], ['08', 8], ['.5', 0.5],
    ['9223372036854775808', 9223372036854775808], ['.inf', '.inf'], ['inf', Infinity], ['2024-01-01', '2024-01-01'],
    ['12:30', '12:30'], ['-foo', '-foo'], ['6 / 3', '6 / 3'], ['1_000.5', '1_000.5'],
  ];
  for (const [s, want] of rows) assert.deepEqual(resolvePlain(s), want, s);
  assert.ok(Number.isNaN(resolvePlain('nan') as number));
});

test('B7.2-2 typed from the first byte: quoted is text, int is bigint, float is number, map order is kept', () => {
  const doc = loadDocument('a: "6 / 3"\nb: 6 / 3\nc: 2\nd: 2.0\ne: \'2\'\nf: !!str 7\ng: |\n  block\nm:\n  "10": x\n  "2": y\n');
  const v = doc.value;
  assert.ok(isMap(v));
  assert.deepEqual([v.get('a'), v.get('b'), v.get('c'), v.get('d'), v.get('e'), v.get('f'), v.get('g')], ['6 / 3', '6 / 3', 2n, 2, '2', '7', 'block\n']);
  assert.deepEqual([...(v.get('m') as Map<string, unknown>).keys()], ['10', '2']);
});

test('positions: key and value of a pair, a container at its first child, an empty entry past its dash', () => {
  const doc = loadDocument('suite: s\ntests:\n  -\n  - name: c\n    steps: []\nempty:\nflow: { a: 1 }\n');
  assert.deepEqual(at(doc, '/suite'), { key: { line: 1, column: 1 }, value: { line: 1, column: 8 } });
  assert.deepEqual(at(doc, '/tests/0').value, { line: 3, column: 4 });
  assert.deepEqual(at(doc, '/tests/1'), { key: { line: 4, column: 5 }, value: { line: 4, column: 5 } });
  assert.deepEqual(at(doc, '/tests/1/name').key, { line: 4, column: 5 });
  assert.deepEqual(at(doc, '/empty'), { key: { line: 6, column: 1 }, value: { line: 6, column: 1 } });
  assert.deepEqual(at(doc, '/flow').value, { line: 7, column: 7 });
  assert.deepEqual(at(doc, ''), { key: { line: 1, column: 1 }, value: { line: 1, column: 1 } });
  assert.deepEqual(at(doc, '/nothing'), { key: START, value: START });
});

test('aliases are null, duplicate keys are not an error (the later value wins), escapes follow JSON pointers', () => {
  const doc = loadDocument('a: &x 1\nb: *x\na: 2\nl: [&y 3, *y]\n');
  const v = doc.value as Map<string, unknown>;
  assert.deepEqual([v.get('a'), v.get('b'), v.get('l')], [2n, null, [3n, null]]);
  assert.equal(escape('a/b~c'), 'a~1b~0c');
  assert.equal(child('/x', 'a/b'), '/x/a~1b');
  assert.equal(child('', 3), '/3');
});

test('B7.2-3 what the parser refuses or cannot hold is a LoadError, never an unhandled exception', () => {
  for (const text of ['a: [1, 2', 'a: b: c', '', '# only a comment\n', 'key: "unterminated\n']) {
    assert.throws(() => loadDocument(text), LoadError, JSON.stringify(text));
  }
  assert.doesNotThrow(() => loadDocument('- 1\n- 2\n'));
  assert.ok(Array.isArray(loadDocument('- 1\n').value));
});

test('a non-scalar key reads as "" and a value that is neither scalar nor container is null', () => {
  const doc = loadDocument('? [a]\n: 1\n');
  assert.deepEqual([...(doc.value as Map<string, unknown>).keys()], ['']);
});

test('an explicit key with no value reads as null at its key', () => {
  const doc = loadDocument('? a\n');
  assert.deepEqual([...(doc.value as Map<string, unknown>)], [['a', null]]);
});
