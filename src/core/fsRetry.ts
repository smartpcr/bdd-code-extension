// Reading a workspace's files when the extension host starts (plan B1.3): every
// extension opens files at once then, and a read can fail with EMFILE ("too many
// open files") although nothing is wrong with the file. A read that failed that
// way is retried with a growing pause, and the initial scan reads a bounded
// number of files at a time, so one start-up burst cannot leave the index
// without the catalog, a suite or a binding's registrations.

/** The error codes that say "try again", not "this file cannot be read". */
export const TRANSIENT_FS_CODES: readonly string[] = ['EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN'];

/**
 * True for an error a retry can cure. Node's fs errors carry the code; VS Code's
 * FileSystemError carries it only in its message ("EMFILE: too many open files, open '...'").
 */
export function isTransientFsError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && TRANSIENT_FS_CODES.includes(code)) return true;
  return typeof message === 'string' && TRANSIENT_FS_CODES.some(c => new RegExp(`\\b${c}\\b`).test(message));
}

export const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run `op`; while it fails with a transient error, wait `baseMs`, then twice that,
 * and so on, up to `attempts` runs in all. Any other error, or the last transient
 * one, is thrown.
 */
export async function retryTransient<T>(
  op: () => Promise<T>,
  attempts: number,
  baseMs: number,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<T> {
  for (let attempt = 1; attempt < attempts; attempt++) {
    try {
      return await op();
    } catch (e) {
      if (!isTransientFsError(e)) throw e;
    }
    await sleep(baseMs * 2 ** (attempt - 1));
  }
  return op();
}

/** The synchronous form, for the catalog's imports, which are resolved while the catalog is parsed. */
export function retryTransientSync<T>(
  op: () => T,
  attempts: number,
  baseMs: number,
  sleep: (ms: number) => void = realSleepSync,
): T {
  for (let attempt = 1; attempt < attempts; attempt++) {
    try {
      return op();
    } catch (e) {
      if (!isTransientFsError(e)) throw e;
    }
    sleep(baseMs * 2 ** (attempt - 1));
  }
  return op();
}

/** Block this thread for `ms` without spinning. */
export function realSleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` on every item, at most `limit` at a time, in the items' order. Resolves when all are done. */
export async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
