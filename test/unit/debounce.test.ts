// B1.7: Debouncer with a clock scoped to each test.
import * as assert from 'assert';
import { test } from 'node:test';
import { Clock, Debouncer, realClock } from '../../src/core/debounce';

class FakeClock implements Clock {
  now = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.timers]) {
      if (t.at <= this.now) {
        this.timers.delete(id);
        t.fn();
      }
    }
  }
}

test('a burst for one key runs once, after the last call plus the delay', () => {
  const clock = new FakeClock();
  const d = new Debouncer(250, clock);
  let runs = 0;
  for (let i = 0; i < 10; i++) {
    d.schedule('a', () => runs++);
    clock.advance(100);
  }
  assert.strictEqual(runs, 0);
  assert.strictEqual(d.size, 1);
  clock.advance(150);
  assert.strictEqual(runs, 1);
  assert.strictEqual(d.size, 0);
});

test('keys are independent; dispose cancels everything', () => {
  const clock = new FakeClock();
  const d = new Debouncer(10, clock);
  const ran: string[] = [];
  d.schedule('a', () => ran.push('a'));
  d.schedule('b', () => ran.push('b'));
  clock.advance(10);
  assert.deepStrictEqual(ran.sort(), ['a', 'b']);
  d.schedule('c', () => ran.push('c'));
  d.dispose();
  clock.advance(100);
  assert.deepStrictEqual(ran, ['a', 'b']);
  assert.strictEqual(d.size, 0);
});

test('the real clock works', async () => {
  const d = new Debouncer(1);
  await new Promise<void>(resolve => d.schedule('x', resolve));
  const h = realClock.setTimeout(() => assert.fail('cleared timer ran'), 5);
  realClock.clearTimeout(h);
  await new Promise(r => setTimeout(r, 10));
});
