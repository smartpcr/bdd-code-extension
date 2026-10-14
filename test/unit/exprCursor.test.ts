// B3.2-1: the cursor-context table (at least 40 rows).
import * as assert from 'assert';
import { test } from 'node:test';
import { CONTEXT_KEYS, cursorContext, enclosingExpression, FUNCTIONS, NAMESPACES } from '../../src/core/exprCursor';

/** `|` marks the cursor. */
function at(line: string) {
  const offset = line.indexOf('|');
  const text = line.slice(0, offset) + line.slice(offset + 1);
  return cursorContext(text, offset);
}
const root = (prefix: string) => ({ kind: 'root', prefix });
const path = (r: string, segments: string[], prefix = '') => ({ kind: 'path', root: r, segments, prefix });
const strip = (c: ReturnType<typeof at>) => c && (c.kind === 'root'
  ? { kind: c.kind, prefix: c.prefix } : { kind: c.kind, root: c.root, segments: c.segments, prefix: c.prefix });

const TABLE: [string, unknown][] = [
  // root positions
  ['node: ${|', root('')],
  ['node: ${|}', root('')],
  ['node: ${ |}', root('')],
  ['node: ${cap|}', root('cap')],
  ['node: ${capture|}', root('capture')],
  ['node: x-${pa|}-y', root('pa')],
  ['node: ${lower(|)}', root('')],
  ['node: ${lower(ca|)}', root('ca')],
  ['node: ${join(a, |)}', root('')],
  ['node: ${join(a, b|)}', root('b')],
  ['node: ${1 + |}', root('')],
  ['node: ${a * x|}', root('x')],
  ['node: ${a == |}', root('')],
  ['node: ${a != v|}', root('v')],
  ['node: ${a > b ? |}', root('')],
  ['node: ${a ? b : c|}', root('c')],
  ['node: ${a and |}', root('')],
  ['node: ${a or p|}', root('p')],
  ['node: ${not |}', root('')],
  ['node: ${(|)}', root('')],
  ['node: ${-|}', root('')],
  ['node: ${a % |}', root('')],
  // paths
  ['node: ${capture.|}', path('capture', [])],
  ['node: ${capture.c|}', path('capture', [], 'c')],
  ['node: ${capture.cs.|}', path('capture', ['cs'])],
  ['node: ${capture.cs.No|}', path('capture', ['cs'], 'No')],
  ['node: ${capture.run.0.|}', path('capture', ['run', '0'])],
  ['node: ${capture.run.0.va|}', path('capture', ['run', '0'], 'va')],
  ['node: ${capture.run.1|}', path('capture', ['run'], '1')],
  ['node: ${param.|}', path('param', [])],
  ['node: ${row.n|}', path('row', [], 'n')],
  ['node: ${len(capture.cs.|)}', path('capture', ['cs'])],
  ['node: ${a + capture.|}', path('capture', [])],
  ['node: ${x ? param.a : var.|}', path('var', [])],
  ['node: ${lower(param.labId) + "-" + var.|}', path('var', [])],
  ['node: ${outer} ${capture.|}', path('capture', [])],
  // not an expression position
  ['node: |${capture.x}', undefined],
  ['node: ${capture.x}|', undefined],
  ['node: plain text|', undefined],
  ['node: ${"a.b|"}', undefined],
  ['node: ${"}|"}', undefined],
  ['node: ${\'it\\\'s |\'}', undefined],
  ['node: ${capture.x |}', undefined],
  ['node: ${"abc".|}', undefined],
  ['node: ${f(a)|}', undefined],
  ['node: ${3|}', undefined],
  ['node: ${capture.x.|} ${y}', path('capture', ['x'])],
];

test('B3.2-1 the cursor-context table', () => {
  assert.ok(TABLE.length >= 40, `${TABLE.length} rows`);
  for (const [line, want] of TABLE) assert.deepStrictEqual(strip(at(line)), want, line);
});

test('the start offset is where the typed prefix begins', () => {
  assert.strictEqual(at('a: ${capture.cs.No|}')!.start, 'a: ${capture.cs.'.length);
  assert.strictEqual(at('a: ${lo|}')!.start, 'a: ${'.length);
});

test('enclosingExpression: nesting, closed expressions, strings', () => {
  assert.strictEqual(enclosingExpression('a ${b} c', 7), -1);
  assert.strictEqual(enclosingExpression('a ${b', 5), 4);
  assert.strictEqual(enclosingExpression('${f({x})}', 6), 2);
  assert.strictEqual(enclosingExpression('${a ${b', 7), 6);
  assert.strictEqual(enclosingExpression('{plain}', 3), -1);
  assert.strictEqual(enclosingExpression('${"x\\"y"}', 9), -1);
});

test('the vocabulary: 21 functions, six context keys, four namespaces', () => {
  assert.strictEqual(Object.keys(FUNCTIONS).length, 21);
  assert.deepStrictEqual(CONTEXT_KEYS, ['cluster', 'target', 'timeoutSec', 'labId', 'apiUrl', 'defaults']);
  assert.deepStrictEqual(NAMESPACES, ['capture', 'param', 'var', 'row']);
});
