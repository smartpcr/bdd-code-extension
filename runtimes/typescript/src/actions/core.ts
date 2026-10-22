// The offline actions every binding implements: six core.* and wait. One
// registration per line: the extension's recognizer and its stub template
// (plan B5.5) read this list by line.
import * as fs from 'node:fs';
import { asNumber, isMap, mapOf, Value } from '../value.js';
import { textOf } from '../walk.js';
import { action, failed, Registration, Request, skipped, sleep, timedOut } from './registry.js';

/** Does nothing and says so: what a then step uses when its whole job is to carry a sentence. */
async function noop(): Promise<Value> {
  return mapOf({ ok: true });
}

/** Publishes a literal, so a fixture can capture a value without an action that fetches one. */
async function set(request: Request): Promise<Value> {
  if (!request.step.has('value')) throw failed('core.set: value is required');
  return request.step.get('value')!;
}

/** Fails on purpose with the fixture's message, so a test asserts on attribution. */
async function fail(request: Request): Promise<Value> {
  throw failed(textOf(request.step, 'message') || 'core.fail: failed on purpose');
}

/**
 * Ends its case as skipped, with the message the suite chose: what a case does
 * when it finds its environment cannot run it (spec/session.md rule 12),
 * usually guarded by ifCapture.
 */
async function skip(request: Request): Promise<Value> {
  throw skipped(textOf(request.step, 'message') || 'core.skip: skipped on purpose');
}

/** Sleeps, and stops at once when its limit or the run's cancellation arrives. */
async function sleepFor(request: Request): Promise<Value> {
  const seconds = asNumber(request.step.get('seconds') ?? null) ?? 1;
  await sleep(seconds * 1000, request.signal, 'core.sleep');
  return mapOf({ sleptSec: seconds });
}

/** Appends a marker to the record path (<prefix>RECORD_PATH), so a test can see which steps ran and in what order. */
async function record(request: Request): Promise<Value> {
  const marker = textOf(request.step, 'marker');
  if (!marker) throw failed('core.record: marker is required');
  if (request.recordPath) {
    try {
      fs.appendFileSync(request.recordPath, `${marker}\n`, { mode: 0o600 });
    } catch (e) {
      throw failed(`core.record: ${request.recordPath} cannot be written: ${(e as Error).message}`);
    }
  }
  return mapOf({ marker });
}

/**
 * Sleeps for `seconds`, or polls `forStep` every `intervalSec` (10) until it
 * succeeds and `until` holds, giving up after its own `timeoutSec` (300) or
 * the case deadline, whichever is first. Unlike Go's uncancellable sleep, both
 * stop when the run is cancelled.
 */
async function wait(request: Request): Promise<Value> {
  const step = request.step;
  const nested = step.get('forStep');
  const seconds = asNumber(step.get('seconds') ?? null) ?? 0;
  if (!isMap(nested)) {
    if (seconds <= 0) throw failed('wait needs either seconds, or a forStep to poll.');
    await sleep(seconds * 1000, request.signal, 'wait');
    return mapOf({ waitedSec: seconds });
  }
  const given = (key: string, fallback: number) => {
    const v = step.get(key);
    return typeof v === 'bigint' && v > 0n ? Number(v) : fallback;
  };
  const intervalMs = given('intervalSec', 10) * 1000;
  const started = Date.now();
  const until = Math.min(started + given('timeoutSec', 300) * 1000, request.deadline ?? Infinity);
  const elapsed = () => BigInt(Math.trunc((Date.now() - started) / 1000));
  for (;;) {
    const ok = await request.runNested!(nested);
    if (ok && (!step.has('until') || step.get('until') === null || request.holds!(step.get('until')!))) {
      return mapOf({ waited: true, elapsedSec: elapsed() });
    }
    if (Date.now() + intervalMs > until) {
      throw timedOut(`wait gave up after ${elapsed()}s: the step it polls never satisfied its until.`);
    }
    await sleep(intervalMs, request.signal, 'wait');
  }
}

export const coreActions: readonly Registration[] = [
  action('core.noop', noop),
  action('core.set', set),
  action('core.fail', fail),
  action('core.skip', skip),
  action('core.sleep', sleepFor),
  action('core.record', record),
  action('wait', wait),
];
