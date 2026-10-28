// The events tail: caseFinished lines into case states, and appended text into whole lines.
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { caseEvent, splitLines } from '../../src/core/events';

test('caseEvent: a passed case carries its name and no message', () => {
  assert.deepStrictEqual(caseEvent('{"event":"caseFinished","at":"2026-10-27T23:46:30Z","suite":"s","case":"cache-stats","status":"passed","durationMs":5}'),
    { name: 'cache-stats', state: 'passed' });
});

test('caseEvent: a failed case keeps the run\'s own message', () => {
  const e = caseEvent('{"event":"caseFinished","case":"c","status":"failed","reason":"cancelled","message":"the step was abandoned"}');
  assert.deepStrictEqual(e, { name: 'c', state: 'failed', message: 'the step was abandoned' });
});

test('caseEvent: without a message the status and reason become one', () => {
  assert.deepStrictEqual(caseEvent('{"event":"caseFinished","case":"c","status":"failed","reason":"cancelled"}'), { name: 'c', state: 'failed', message: 'failed (cancelled)' });
  assert.deepStrictEqual(caseEvent('{"event":"caseFinished","case":"c","status":"errored"}'), { name: 'c', state: 'errored', message: 'errored' });
  assert.deepStrictEqual(caseEvent('{"event":"caseFinished","case":"c","status":"skipped","reason":"no-sbe-profile"}'), { name: 'c', state: 'skipped', message: 'skipped (no-sbe-profile)' });
  assert.deepStrictEqual(caseEvent('{"event":"caseFinished","case":"c"}'), { name: 'c', state: 'skipped', message: 'unknown' });
  assert.deepStrictEqual(caseEvent('{"event":"caseFinished","case":"c","status":"cancelled","message":""}'), { name: 'c', state: 'skipped', message: 'cancelled' });
});

test('caseEvent: an outline row is named as the run reports it', () => {
  assert.strictEqual(caseEvent('{"event":"caseFinished","case":"get-cache-for-each-type [type=Update]","status":"passed"}')?.name, 'get-cache-for-each-type [type=Update]');
});

test('caseEvent: other events, a case without a name, non-objects and non-JSON give nothing', () => {
  assert.strictEqual(caseEvent('{"event":"stepFinished","case":"c","status":"passed"}'), undefined);
  assert.strictEqual(caseEvent('{"event":"caseFinished","status":"passed"}'), undefined);
  assert.strictEqual(caseEvent('{"event":"caseFinished","case":5}'), undefined);
  assert.strictEqual(caseEvent('"a string"'), undefined);
  assert.strictEqual(caseEvent('null'), undefined);
  assert.strictEqual(caseEvent('42'), undefined);
  assert.strictEqual(caseEvent('{not json'), undefined);
  assert.strictEqual(caseEvent(''), undefined);
});

test('splitLines: whole lines out, a partial last line kept as the tail, CRLF or LF, blanks dropped', () => {
  const first = splitLines('a\r\nb\n\nc', '');
  assert.deepStrictEqual(first, { lines: ['a', 'b'], tail: 'c' });
  const second = splitLines('d\n', first.tail);
  assert.deepStrictEqual(second, { lines: ['cd'], tail: '' });
  assert.deepStrictEqual(splitLines('', ''), { lines: [], tail: '' });
  assert.deepStrictEqual(splitLines('', 'x'), { lines: [], tail: 'x' });
});
