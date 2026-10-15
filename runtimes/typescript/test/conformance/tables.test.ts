// The two tables that are the specification (E-B12): every expression row and
// every assertion row, plus Go's two completeness checks: every function is
// called by some row, and every operator has a row.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { compare, CompareError, OPERATORS } from '../../src/assertion.js';
import { evaluate, expand, ExprError, FUNCTION_NAMES, newScope, read, stable } from '../../src/expr.js';
import { loadDocument } from '../../src/model.js';
import { corpus, corpusComposite } from '../where.js';
import { asNumber, isList, isMap, text, Value, ValueMap } from '../../src/value.js';

const yaml = (rel: string) => loadDocument(fs.readFileSync(path.join(corpus, rel), 'utf8')).value as ValueMap;

function kind(v: Value): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'bigint') return 'int';
  if (typeof v === 'number') return 'float';
  return isList(v) ? 'list' : 'object';
}

function same(produced: Value, expected: Value): boolean {
  if (produced === null && expected === null) return true;
  const a = asNumber(produced);
  const b = asNumber(expected);
  if (a !== undefined && b !== undefined) return a === b;
  return text(produced) === text(expected);
}

test('B7.3-1 every row of expressions/cases.yaml', () => {
  const context = yaml('expressions/context.yaml');
  const rows = (yaml('expressions/cases.yaml').get('cases') as Value[]).filter(isMap);
  assert.ok(rows.length > 100);
  const wrong: string[] = [];
  const used = new Set<string>();
  for (const row of rows) {
    const isTemplate = typeof row.get('template') === 'string';
    const source = text(row.get(isTemplate ? 'template' : 'expr') ?? null);
    const label = `${isTemplate ? 'template' : 'expression'} [${source}]`;
    for (const name of read(source, false).functions) used.add(name);
    const scope = row.get('stable') === true ? stable(newScope(context, corpusComposite.roots)) : newScope(context, corpusComposite.roots);
    let produced: Value = null;
    let failure: unknown;
    try {
      produced = isTemplate ? expand(source, scope) : evaluate(source, scope);
    } catch (e) {
      failure = e;
    }
    if (failure !== undefined && !(failure instanceof ExprError)) throw failure;
    const code = row.get('code');
    if (typeof code === 'string') {
      if (!failure) wrong.push(`${label} produced ${text(produced)}; the table says ${code}`);
      else if ((failure as ExprError).code !== code) wrong.push(`${label} is refused with ${(failure as ExprError).code}; the table says ${code}`);
      continue;
    }
    if (failure) {
      wrong.push(`${label} is refused with ${(failure as ExprError).code} ${(failure as ExprError).message}; the table says it produces a value`);
      continue;
    }
    const type = row.get('type');
    if (typeof type === 'string' && kind(produced) !== type) {
      wrong.push(`${label} has type ${kind(produced)}; the table says ${type}`);
      continue;
    }
    if (row.has('value') && !same(produced, row.get('value')!)) wrong.push(`${label} is [${text(produced)}]; the table says [${text(row.get('value')!)}]`);
    const count = row.get('count');
    if (typeof count === 'bigint' && (isList(produced) ? BigInt(produced.length) : -1n) !== count) wrong.push(`${label} count differs`);
    const length = row.get('length');
    if (typeof length === 'bigint' && BigInt([...text(produced)].length) !== length) wrong.push(`${label} length differs`);
  }
  const unused = FUNCTION_NAMES.filter(n => !used.has(n));
  console.log(`  ${rows.length - wrong.length} of ${rows.length} expression rows match; functions never called: ${unused.join(', ') || 'none'}`);
  assert.deepEqual(wrong, []);
  assert.deepEqual(unused, [], 'every function is called by some row');
});

test('B7.3-1 every row of asserts/cases.yaml', () => {
  const rows = (yaml('asserts/cases.yaml').get('cases') as Value[]).filter(isMap);
  const wrong: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const op = text(row.get('op') ?? null);
    seen.add(op);
    const present = row.get('present') !== false;
    const label = `${op} [${text(row.get('actual') ?? null)}] [${text(row.get('expected') ?? null)}]`;
    let result: string;
    let code = '';
    try {
      result = compare(op, row.get('actual') ?? null, row.get('expected') ?? null, present) ? 'pass' : 'fail';
    } catch (e) {
      if (!(e instanceof CompareError)) throw e;
      result = 'error';
      code = e.code;
    }
    if (result !== row.get('result')) wrong.push(`${label}: ${result}; the table says ${text(row.get('result') ?? null)}`);
    else if (typeof row.get('code') === 'string' && row.get('code') !== code) wrong.push(`${label}: code ${code}; the table says ${text(row.get('code')!)}`);
  }
  const missing = OPERATORS.filter(o => o !== 'script' && !seen.has(o));
  console.log(`  ${rows.length - wrong.length} of ${rows.length} assertion rows match; operators without a row: ${missing.join(', ') || 'none'}`);
  assert.deepEqual(wrong, []);
  assert.deepEqual(missing, []);
});
