// assertion.ts beyond the table: unportable(), the refusals and the failure sentences.
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, CompareError, describe, OPERATORS, unportable } from '../../src/assertion.js';

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof CompareError);
    return `${e.code}:${e.message.slice(0, 30)}`;
  }
  return 'none';
};

test('unportable: the SuiteLint.psm1 constructs, an inline flag group, and nothing else', () => {
  assert.equal(unportable('a(?=b)'), 'a lookahead');
  assert.equal(unportable('a(?!b)'), 'a negative lookahead');
  assert.equal(unportable('(?<=a)b'), 'a lookbehind');
  assert.equal(unportable('(?<!a)b'), 'a negative lookbehind');
  assert.equal(unportable('(a)\\1'), 'a backreference');
  assert.equal(unportable('(?i)up'), 'an inline flag group');
  assert.equal(unportable('(?i:up)'), 'an inline flag group');
  assert.equal(unportable('\\0'), '', 'NUL is not a backreference, as SuiteLint.psm1 reads it');
  assert.equal(unportable('^N[0-9]+$'), '');
  assert.equal(unportable('(?:a|b)'), '');
});

test('compare: matches, in, the number operators and count, with their refusals', () => {
  assert.equal(compare('matches', 'WSFC-N1', '^wsfc', true), true);
  assert.equal(refusal(() => compare('matches', 'a', '(', true)), ':the pattern \'(\' cannot be read');
  assert.equal(refusal(() => compare('matches', 'a', '(?i)a', true)), 'E308:the pattern \'(?i)a\' uses an in');
  assert.equal(compare('in', 'b', ['A', 'B'], true), true);
  assert.equal(refusal(() => compare('in', 'b', 'B', true)), ':in takes a list, and \'B\' is no');
  assert.equal(refusal(() => compare('gt', 'x', 1n, true)), ':gt compares numbers, and the s');
  assert.equal(refusal(() => compare('lt', 1n, 'x', true)), ':lt compares numbers, and the e');
  assert.equal(compare('gte', '3', 3n, true), true);
  assert.equal(compare('lte', 2.5, 3n, true), true);
  assert.equal(compare('lt', 4n, 3n, true), false);
  assert.equal(refusal(() => compare('count', 'x', 1n, true)), ':count takes a list, and the su');
  assert.equal(compare('count', ['a'], '1', true), true);
  assert.equal(refusal(() => compare('script', 1n, null, true)), 'E201:script runs PowerShell, which ');
  assert.equal(refusal(() => compare('nope', 1n, null, true)), ':Unknown assertion: nope');
});

test('compare: the truth operators read the expected value as wanted or not', () => {
  assert.equal(compare('isTrue', true, 'yes', true), true);
  assert.equal(compare('isTrue', 'true', true, true), false);
  assert.equal(compare('isFalse', false, 1n, true), true);
  assert.equal(compare('isNull', null, '0', true), false);
  assert.equal(compare('isNull', 'x', false, true), true);
  assert.equal(compare('isNotNull', 'x', null, false), true);
  assert.equal(compare('notContains', ['A'], 'a', true), true);
  assert.equal(compare('startsWith', 'Abc', 'a', true), true);
  assert.equal(compare('endsWith', 'Abc', 'C', true), true);
  assert.ok(OPERATORS.includes('script') && OPERATORS.length === 18);
});

test('describe: the sentence for each kind of operator and subject', () => {
  assert.equal(describe('cs.State', 'equals', 'Up', 'Down', true), "expected cs.State equals 'Up', got 'Down'");
  assert.equal(describe('x', 'in', ['a', 'b'], ['c'], true), "expected x in '[a, b]', got '[c]'");
  assert.equal(describe('x', 'isTrue', true, null, true), "expected x to be true, got '(null)'");
  assert.equal(describe('x', 'isFalse', true, true, true), "expected x to be false, got 'true'");
  assert.equal(describe('x', 'isNull', true, 'v', true), "expected x to be absent or null, got 'v'");
  assert.equal(describe('x', 'isNotNull', true, null, false), "expected x to be present, got '(absent)'");
  assert.equal(describe('x', 'count', 2n, ['a'], true), "expected x to have 2 entries, got '[a]'");
});
