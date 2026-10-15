// expr.ts beyond the table: the kinds (B7.3-2), the width rule, every refusal
// path, read(), references() and expand() over lists and maps.
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, expand, ExprError, field, newIdentifier, newScope, read, references, scan, stable, ROOTS } from '../../src/expr.js';
import { mapOf, Value } from '../../src/value.js';

const context = mapOf({
  cluster: 'C', capture: mapOf({ list: ['a', 'b'], m: mapOf({ k: 'v' }), nothing: null, n: 7n }),
  param: mapOf({ num: '7', f: '2.5', big: '9007199254740993' }), var: mapOf({}), row: mapOf({}), defaults: mapOf({}),
});
const ev = (s: string, scope = newScope(context)) => evaluate(s, scope);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ExprError, String(e));
    return e.code;
  }
  return 'no error';
};

test('B7.3-2 kinds: 1.5 + 1.5 is a float, 6 / 3 an int, 0.0 a float, text numbers count as their kind', () => {
  assert.equal(typeof ev('1.5 + 1.5'), 'number');
  assert.equal(ev('6 / 3'), 2n);
  assert.equal(typeof ev('0.0'), 'number');
  assert.equal(ev('7 / 2'), 3.5);
  assert.equal(ev('param.num + 1'), 8n);
  assert.equal(ev('param.f * 2'), 5);
  assert.equal(ev('-7 % 3'), -1n);
  assert.equal(ev('7.5 % 2'), 1.5);
  assert.equal(ev('1.5 - 1'), 0.5);
});

test('past 2^53 an integer result is what the f64 bindings give; whole under 9.2e18 stays an int', () => {
  assert.equal(ev('9223372036854775807 + 1'), 9223372036854775808);
  assert.equal(typeof ev('9223372036854775807 + 1'), 'number');
  assert.equal(ev('9007199254740993 - 0'), 9007199254740992n);
  assert.equal(ev('9007199254740992 * 2'), 18014398509481984n);
  assert.equal(ev('9007199254740993 / 1'), 9007199254740992n);
});

test('text and comparison: + joins non-numbers, == ignores case, two ints compare exactly, floats as floats', () => {
  assert.equal(ev("'a' + 1"), 'a1');
  assert.equal(ev('null + 1'), '1');
  assert.equal(ev("'Up' == 'up'"), true);
  assert.equal(ev("'Up' != 'up'"), false);
  assert.equal(ev('2 != 3'), true);
  assert.equal(ev('9007199254740993 == 9007199254740992'), false);
  assert.equal(ev('1 == 1.0'), true);
  assert.equal(ev('1.5 < 2'), true);
  assert.equal(ev('2 <= 2.0'), true);
  assert.equal(ev('3 > 2'), true);
  assert.equal(ev('2.5 >= 3'), false);
  assert.equal(ev('2.5 > 1'), true);
  assert.equal(ev("float('nan') == float('nan')"), false, 'NaN is equal to nothing');
  assert.equal(code(() => ev("'a' < 1")), 'E307');
  assert.equal(code(() => ev("'a' - 1")), 'E307');
  assert.equal(code(() => ev('1.0 % 0')), 'E307');
});

test('booleans: and/or read both sides, not, the words true/yes/1 and false/no/0/""', () => {
  assert.equal(ev("'yes' and 1"), true);
  assert.equal(ev("'no' or 0"), false);
  assert.equal(ev("not ''"), true);
  assert.equal(code(() => ev("true or 'maybe'")), 'E307');
  assert.equal(code(() => ev("false and 'maybe'")), 'E307');
  assert.equal(code(() => ev("'maybe' ? 1 : 2")), 'E307');
  assert.equal(ev('false ? 1 : 2'), 2n);
});

test('the untaken branch is checked, not evaluated', () => {
  assert.equal(ev('true ? 1 : capture.nope'), 1n);
  assert.equal(ev('false ? 1 / 0 : 2'), 2n);
  assert.equal(ev('true ? 1 : (not 1 or 2 and 3 == 4 + -5 * 6)'), 1n);
  assert.equal(code(() => ev('true ? 1 : nope()')), 'E306');
  assert.equal(code(() => ev('true ? 1 : len(1, 2)')), 'E307');
  assert.equal(code(() => ev('false ? uuid() : 1', stable(newScope(context)))), 'E309');
  assert.equal(code(() => ev('true ? (true ? 1 : 2) : 3 :')), 'E305');
});

test('paths: roots, maps, list indexes, null on the way, out of range', () => {
  assert.equal(ev('capture.list.1'), 'b');
  assert.equal(ev('capture.m.k'), 'v');
  assert.equal(ev('capture.nothing'), null);
  assert.equal(code(() => ev('capture.nothing.x')), 'E301');
  assert.equal(code(() => ev('capture.list.5')), 'E301');
  assert.equal(code(() => ev('capture.list.x')), 'E301');
  assert.equal(code(() => ev('capture.n.x')), 'E301');
  assert.equal(code(() => ev('nowhere.x')), 'E301');
  assert.equal(code(() => ev('capture.')), 'E305');
  assert.deepEqual(field('x', 'k'), { found: false, value: null });
});

test('syntax refusals (E305): unclosed string, stray character, unread number, unclosed call and paren, leftovers', () => {
  for (const s of ["'a", '1 # 2', '(1', 'len(1', '1 2', ')', '', '1 +', '?']) assert.equal(code(() => ev(s)), 'E305', s);
  assert.equal(code(() => scan('99999999999999999999')), 'E305');
  assert.deepEqual(scan('a.0.b').map(t => t.text), ['a', '.', '0', '.', 'b', '']);
});

test('functions: every one, the arity and kind refusals, determinism', () => {
  const rows: [string, Value][] = [
    ["lower('A')", 'a'], ["upper('a')", 'A'], ["trim(' a ')", 'a'], ["replace('aXa', 'X', 'Y')", 'aYa'],
    ["format('{0}-{1}', 1, 'x')", '1-x'], ["join(split('a,b', ','), '+')", 'a+b'], ["join('one', '+')", 'one'],
    ["startsWith('Abc', 'a')", true], ["endsWith('Abc', 'C')", true], ["contains(capture.list, 'b')", true],
    ["contains(capture.list, 'B')", false], ["contains('Abc', 'B')", true], ["len('hé')", 2n], ['len(capture.list)', 2n],
    ['len(capture.m)', 1n], ['len(null)', 0n], ['first(capture.list)', 'a'], ['last(capture.list)', 'b'], ["first('x')", 'x'],
    ["int('7.9')", 7n], ['int(7)', 7n], ['int(param.big)', 9007199254740993n], ['float(3)', 3], ['str(1.0)', '1'], ['str(true)', 'true'],
    ["bool('YES')", true], ["default(null, 'd')", 'd'], ["default('', 'd')", 'd'], ["default('x', 'd')", 'x'],
    ["env('SUITERUN_NO_SUCH_VARIABLE')", ''],
  ];
  for (const [s, want] of rows) assert.deepEqual(ev(s), want, s);
  assert.match(ev('uuid()') as string, /^[0-9a-f]{32}$/);
  assert.match(ev('nowIso()') as string, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
  assert.notEqual(newIdentifier(), newIdentifier());
  const refusals: [string, string][] = [
    ['lenn(1)', 'E306'], ['zzz()', 'E306'], ['len()', 'E307'], ["format()", 'E307'], ['len(1)', 'E307'], ['len(true)', 'E307'],
    ['first(null)', 'E307'], ["int('x')", 'E307'], ['int(1e400)', 'E305'], ["float('x')", 'E307'], ["bool('maybe')", 'E307'],
  ];
  for (const [s, c] of refusals) assert.equal(code(() => ev(s)), c, s);
  assert.equal(code(() => ev('int(999999999999999999999.5)')), 'E307');
  assert.equal(code(() => ev("env('X')", stable(newScope(context)))), 'E309');
});

test('expand: one expression keeps its type, text substitutes, lists and maps expand, a ${ never closed is text', () => {
  // cluster is a context key an extension would add.
  const scope = newScope(context, [...ROOTS, 'cluster']);
  assert.equal(expand('${capture.n}', scope), 7n);
  assert.equal(expand(' ${capture.n}', scope), ' 7');
  assert.equal(expand('n=${capture.n}, c=${cluster}', scope), 'n=7, c=C');
  assert.equal(code(() => expand('x ${nope.y} y', scope)), 'E301');
  assert.equal(expand('keep ${ open', scope), 'keep ${ open');
  assert.deepEqual(expand(['${cluster}', 1n], scope), ['C', 1n]);
  assert.deepEqual([...(expand(mapOf({ a: '${capture.n}' }), scope) as Map<string, Value>)], [['a', 7n]]);
  assert.equal(expand(true, scope), true);
  assert.equal(expand('${cluster}${cluster}', scope), 'CC');
});

test('references and read: every ${...}; the paths and functions read; the first problem', () => {
  assert.deepEqual(references('a ${x} b ${y.z} ${'), [{ expression: 'x', start: 2, end: 6 }, { expression: 'y.z', start: 9, end: 15 }]);
  const r = read("len(capture.list.0) > param.num and not row.x or true ? lower('a') : null", false);
  assert.deepEqual([r.paths, r.functions, r.error], [[['capture', 'list', '0'], ['param', 'num'], ['row', 'x']], ['len', 'lower'], undefined]);
  assert.equal(read('1 +', false).error?.code, 'E305');
  assert.equal(read('uuid()', true).error?.code, 'E309');
  assert.equal(read("'unclosed", false).error?.code, 'E305');
  assert.deepEqual(read('capture.', false).error?.code, 'E305');
  assert.deepEqual(read('a.b.', false).paths, []);
});
