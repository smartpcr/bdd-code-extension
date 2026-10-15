// value.ts: typed values and the Go-compatible conversions every binding agrees on.
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  asNumber, formatGoFloat, isList, isMap, mapOf, numberText, parseDecimalInt, parseGoFloat, parseGoInt, text, toJson, toPlain, Value,
} from '../../src/value.js';

test('parseGoInt: every base, signs, underscores, int64 range', () => {
  const rows: [string, bigint | undefined][] = [
    ['0', 0n], ['42', 42n], ['-42', -42n], ['+7', 7n], ['1_000', 1000n], ['017', 15n], ['0o17', 15n], ['0O17', 15n], ['0x1F', 31n],
    ['0X1f', 31n], ['0b101', 5n], ['-0b101', -5n], ['0x_1F', 31n], ['00', 0n], ['0_7', 7n],
    ['08', undefined], ['1__0', undefined], ['_1', undefined], ['1_', undefined], ['0x', undefined], ['', undefined], ['abc', undefined],
    ['9223372036854775807', 9223372036854775807n], ['9223372036854775808', undefined], ['-9223372036854775808', -9223372036854775808n],
  ];
  for (const [s, want] of rows) assert.equal(parseGoInt(s), want, s);
});

test('parseDecimalInt: decimal digits with a sign, in range', () => {
  assert.equal(parseDecimalInt('-12'), -12n);
  assert.equal(parseDecimalInt('0x1'), undefined);
  assert.equal(parseDecimalInt('99999999999999999999'), undefined);
});

test('parseGoFloat: decimal, exponent, inf, infinity, nan; nothing else', () => {
  assert.equal(parseGoFloat('1.5'), 1.5);
  assert.equal(parseGoFloat('.5'), 0.5);
  assert.equal(parseGoFloat('5.'), 5);
  assert.equal(parseGoFloat('-1e3'), -1000);
  assert.equal(parseGoFloat('Inf'), Infinity);
  assert.equal(parseGoFloat('-infinity'), -Infinity);
  assert.ok(Number.isNaN(parseGoFloat('NaN')));
  for (const s of ['.inf', '1_0.5', 'x', '', '1e']) assert.equal(parseGoFloat(s), undefined, s);
});

test('formatGoFloat is Go\'s FormatFloat(f, \'g\', -1, 64)', () => {
  const rows: [number, string][] = [
    [0.1, '0.1'], [1.5, '1.5'], [1234567.5, '1.2345675e+06'], [123456.5, '123456.5'], [0.0001234, '0.0001234'],
    [0.00001234, '1.234e-05'], [1e21, '1e+21'], [-2.5e-7, '-2.5e-07'], [1e100, '1e+100'], [100, '100'], [-0.5, '-0.5'],
    [NaN, 'NaN'], [Infinity, '+Inf'], [-Infinity, '-Inf'], [0, '0'], [-0, '-0'],
  ];
  for (const [f, want] of rows) assert.equal(formatGoFloat(f), want, String(f));
});

test('B7.2-2 text: no .0 on a whole float, lowercase booleans, null is "", lists joined, maps as JSON', () => {
  assert.equal(numberText(2), '2');
  assert.equal(numberText(1e19), '1e+19');
  assert.equal(numberText(2.5), '2.5');
  const rows: [Value | undefined, string][] = [
    [null, ''], [undefined, ''], [true, 'true'], [false, 'false'], ['x', 'x'], [5n, '5'], [2.0, '2'], [[1n, 'a', null], '1, a, '],
    [mapOf({ b: 1n, a: 'x' }), '{"b":1,"a":"x"}'],
  ];
  for (const [v, want] of rows) assert.equal(text(v), want);
});

test('asNumber: ints, floats and strings that parse; nothing else', () => {
  assert.equal(asNumber(3n), 3);
  assert.equal(asNumber(1.5), 1.5);
  assert.equal(asNumber(' 2.5 '), 2.5);
  assert.equal(asNumber('x'), undefined);
  assert.equal(asNumber(true), undefined);
  assert.equal(asNumber(null), undefined);
});

test('toPlain and toJson keep order and write bigint as an integer', () => {
  const v: Value = new Map<string, Value>([['10', 1n], ['2', [2.5, null, true]], ['s', mapOf({})]]);
  assert.deepEqual(toPlain(v), { '10': 1, '2': [2.5, null, true], s: {} });
  assert.equal(toPlain(undefined), null);
  assert.equal(toJson(v), '{"10":1,"2":[2.5,null,true],"s":{}}');
  assert.equal(toJson(mapOf({ a: [1n], b: [] }), 2), '{\n  "a": [\n    1\n  ],\n  "b": []\n}');
  assert.equal(toJson(Infinity), 'null');
  assert.equal(toJson(undefined), 'null');
  assert.ok(isMap(v) && !isList(v) && isList([]) && !isMap([]));
});
