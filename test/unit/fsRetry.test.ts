// B1.3: the initial scan survives a start-up burst of EMFILE (fsRetry.ts).
import * as assert from 'assert';
import { test } from 'node:test';
import {
  forEachLimited, isTransientFsError, realSleep, realSleepSync, retryTransient, retryTransientSync,
} from '../../src/core/fsRetry';

const emfile = (): Error => Object.assign(new Error("EMFILE: too many open files, open 'a.yml'"), { code: 'EMFILE' });
/** What VS Code's workspace.fs throws: the code only in the message. */
const vscodeEmfile = (): Error => Object.assign(new Error("Error: EMFILE: too many open files, open 'a.yml'"), { code: 'Unknown' });

test('transient errors are recognized by code or by message, nothing else is', () => {
  assert.ok(isTransientFsError(emfile()));
  assert.ok(isTransientFsError(vscodeEmfile()));
  assert.ok(isTransientFsError({ code: 'ENFILE' }));
  assert.ok(isTransientFsError({ message: 'EBUSY: resource busy or locked' }));
  assert.ok(!isTransientFsError(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })));
  assert.ok(!isTransientFsError({ message: 'XEMFILEX' }), 'only the code as a word');
  assert.ok(!isTransientFsError({ code: 42, message: 7 }));
  assert.ok(!isTransientFsError('EMFILE'));
  assert.ok(!isTransientFsError(null));
  assert.ok(!isTransientFsError(undefined));
});

test('a transient failure is retried with doubling pauses until it succeeds', async () => {
  const pauses: number[] = [];
  let calls = 0;
  const text = await retryTransient(async () => {
    if (++calls < 4) throw vscodeEmfile();
    return 'catalog';
  }, 6, 50, async ms => { pauses.push(ms); });
  assert.strictEqual(text, 'catalog');
  assert.deepStrictEqual(pauses, [50, 100, 200]);
});

test('the last transient failure, and any other failure at once, is thrown', async () => {
  const pauses: number[] = [];
  let calls = 0;
  await assert.rejects(retryTransient(async () => { calls++; throw emfile(); }, 3, 10, async ms => { pauses.push(ms); }), /EMFILE/);
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(pauses, [10, 20]);

  calls = 0;
  await assert.rejects(retryTransient(async () => { calls++; throw new Error('ENOENT'); }, 3, 10, async () => {}), /ENOENT/);
  assert.strictEqual(calls, 1);
});

test('the synchronous form retries the same way', () => {
  const pauses: number[] = [];
  let calls = 0;
  const text = retryTransientSync(() => {
    if (++calls < 3) throw emfile();
    return 'core';
  }, 6, 20, ms => { pauses.push(ms); });
  assert.strictEqual(text, 'core');
  assert.deepStrictEqual(pauses, [20, 40]);

  calls = 0;
  assert.throws(() => retryTransientSync(() => { calls++; throw emfile(); }, 2, 1, () => {}), /EMFILE/);
  assert.strictEqual(calls, 2);
  assert.throws(() => retryTransientSync(() => { throw new Error('EACCES'); }, 5, 1, () => {}), /EACCES/);
});

test('the real sleeps wait, and are what the retries use by default', async () => {
  const started = Date.now();
  await realSleep(5);
  realSleepSync(5);
  assert.ok(Date.now() - started >= 9);

  let calls = 0;
  assert.strictEqual(await retryTransient(async () => (++calls < 2 ? Promise.reject(emfile()) : 'a'), 2, 1), 'a');
  calls = 0;
  assert.strictEqual(retryTransientSync(() => { if (++calls < 2) throw emfile(); return 'b'; }, 2, 1), 'b');
});

test('forEachLimited never runs more than the limit at once and visits every item once, in order', async () => {
  let running = 0;
  let peak = 0;
  const started: number[] = [];
  await forEachLimited([1, 2, 3, 4, 5, 6, 7], 3, async item => {
    started.push(item);
    peak = Math.max(peak, ++running);
    await realSleep(2);
    running--;
  });
  assert.strictEqual(peak, 3);
  assert.deepStrictEqual(started, [1, 2, 3, 4, 5, 6, 7]);
});

test('forEachLimited with no items, or a limit above the count, is fine', async () => {
  let calls = 0;
  await forEachLimited([], 8, async () => { calls++; });
  assert.strictEqual(calls, 0);
  await forEachLimited(['a'], 8, async () => { calls++; });
  assert.strictEqual(calls, 1);
  await forEachLimited(['a', 'b'], 0, async () => { calls++; });
  assert.strictEqual(calls, 3, 'a limit below one still runs one at a time');
});
