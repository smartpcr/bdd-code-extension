// A keyed debouncer with an injectable clock (plan B1.7), so tests own time.

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as NodeJS.Timeout),
};

export class Debouncer {
  private readonly pending = new Map<string, unknown>();
  constructor(private readonly delayMs: number, private readonly clock: Clock = realClock) {}

  /** Run `fn` once `delayMs` after the last call for `key`. */
  schedule(key: string, fn: () => void): void {
    const previous = this.pending.get(key);
    if (previous !== undefined) this.clock.clearTimeout(previous);
    this.pending.set(key, this.clock.setTimeout(() => {
      this.pending.delete(key);
      fn();
    }, this.delayMs));
  }

  get size(): number {
    return this.pending.size;
  }

  dispose(): void {
    for (const h of this.pending.values()) this.clock.clearTimeout(h);
    this.pending.clear();
  }
}
