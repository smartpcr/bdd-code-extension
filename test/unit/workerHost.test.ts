// B8.1: LintWorkerHost with a real Worker running the compiled worker.ts and a
// test library that answers, throws, loops, exits or reports another apiVersion.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { LIBRARY_API_MAJOR, WORKER_LINT_TIMEOUT_MS, WORKER_MAX_CONSECUTIVE_FAILURES } from '../../src/limits';
import { LintWorkerHost, WorkerHostOptions, workerFailureText, WorkerLintResult } from '../../src/lint/workerHost';
import type { LibraryLintRequest } from '../../src/lint/protocol';

const WORKER = path.join(__dirname, '../../src/lint/worker.js');
const LIBRARY = path.join(__dirname, '../../../test/fake-library/index.mjs');
const ROOT = path.join(os.tmpdir(), 'bdd-worker-root');
const request = (overlays: Record<string, string> = {}): LibraryLintRequest =>
  ({ paths: [path.join(ROOT, 'a.yml')], binding: 'go', bindingCheck: true, strict: false, overlays });

function host(fake: string, over: Partial<WorkerHostOptions> = {}): LintWorkerHost {
  return new LintWorkerHost({ workerPath: WORKER, gate: () => true, extraWorkerData: { fake }, ...over });
}

const message = (r: WorkerLintResult): string => {
  assert.strictEqual(r.kind, 'result', JSON.stringify(r));
  return (r as { diagnostics: { message: string }[] }).diagnostics[0].message;
};
const failure = (r: WorkerLintResult) => {
  assert.strictEqual(r.kind, 'failure', JSON.stringify(r));
  return r as Extract<WorkerLintResult, { kind: 'failure' }>;
};
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise(r => setTimeout(r, 10));
  }
};

test('a library that answers: one worker, reused; the request reaches the library as sent', async () => {
  const h = host('answer');
  try {
    const r = await h.lint('a', LIBRARY, ROOT, request({ [path.join(ROOT, 'b.yml')]: 'x' }));
    assert.match(message(r), new RegExp(`^root=.*bdd-worker-root binding=go overlays=.*b\\.yml invalidated=0$`));
    assert.deepStrictEqual([h.workerCount, h.workersStarted], [1, 1]);
    await h.lint('a', LIBRARY, ROOT, request());
    assert.strictEqual(h.workersStarted, 1, 'the worker is reused');
    h.invalidate(ROOT);
    assert.match(message(await h.lint('a', LIBRARY, ROOT, request())), /invalidated=1$/);
    assert.strictEqual(h.current, true);
    h.reload();
    assert.deepStrictEqual([h.workerCount, h.current], [1, false], 'reload marks the loaded copy old; the worker stays until the next lint');
    assert.match(message(await h.lint('a', LIBRARY, ROOT, request())), /invalidated=0$/, 'a fresh load of the library');
    assert.deepStrictEqual([h.workersStarted, h.current], [2, true]);
  } finally {
    h.dispose();
  }
  assert.strictEqual(h.workerCount, 0);
  h.invalidate(ROOT);
});

test('B8.1-4 an untrusted workspace starts no worker (INV-11)', async () => {
  const h = host('answer', { gate: () => false });
  assert.strictEqual(failure(await h.lint('a', LIBRARY, ROOT, request())).reason, 'untrusted');
  assert.strictEqual(failure((await h.start(LIBRARY))!).reason, 'untrusted');
  assert.deepStrictEqual([h.workerCount, h.workersStarted], [0, 0]);
});

test('a missing library is "not built" and starts no worker', async () => {
  const h = host('answer', { exists: () => false });
  const f = failure(await h.lint('a', LIBRARY, ROOT, request()));
  assert.deepStrictEqual([f.reason, h.workersStarted, h.consecutiveFailures], ['not-found', 0, 1]);
  assert.strictEqual(workerFailureText('typescript', f), 'Lint: typescript not built');
});

test('B8.1-3 apiVersion 2.0.0 is refused, with both versions in the status; a missing version too', async () => {
  const h = host('v2');
  const f = failure(await h.lint('a', LIBRARY, ROOT, request()));
  assert.deepStrictEqual([f.reason, f.apiVersion, h.workerCount], ['api', '2.0.0', 0]);
  const text = workerFailureText('typescript', f);
  assert.ok(text.includes('2.0.0') && text.includes(`${LIBRARY_API_MAJOR}.x`), text);
  const none = failure(await host('no-version').lint('a', LIBRARY, ROOT, request()));
  assert.deepStrictEqual([none.reason, none.apiVersion], ['api', '']);
  assert.match(workerFailureText('typescript', none), /speaks API none;/);
});

test('a library that throws while loading is "did not load"; one that never loads times out', async () => {
  const f = failure(await host('load-throws').lint('a', LIBRARY, ROOT, request()));
  assert.deepStrictEqual([f.reason, f.apiVersion], ['load', undefined]);
  assert.match(f.detail, /failed while loading/);
  const h = host('load-slow', { timeoutMs: 300 });
  assert.strictEqual(failure(await h.lint('a', LIBRARY, ROOT, request())).reason, 'timeout');
  assert.strictEqual(h.workerCount, 0);
});

test('a library that throws: "library failed" with its message, and the next lint starts a new worker', async () => {
  const h = host('throw');
  try {
    const f = failure(await h.lint('a', LIBRARY, ROOT, request()));
    assert.deepStrictEqual([f.reason, f.detail, h.workerCount], ['error', 'the library threw', 0]);
    await h.lint('a', LIBRARY, ROOT, request());
    assert.strictEqual(h.workersStarted, 2);
    assert.strictEqual(failure(await host('throw-string').lint('a', LIBRARY, ROOT, request())).detail, 'a thrown string');
  } finally {
    h.dispose();
  }
});

test('B8.1-2 a looping library is terminated within the timeout plus 1 s, and the next lint starts a new worker', async () => {
  const h = host('loop', { timeoutMs: 500 });
  try {
    const started = Date.now();
    const f = failure(await h.lint('a', LIBRARY, ROOT, request()));
    const took = Date.now() - started;
    assert.strictEqual(f.reason, 'timeout');
    assert.ok(took < 500 + 1000, `${took} ms`);
    assert.strictEqual(h.workerCount, 0);
    assert.strictEqual(failure(await h.lint('a', LIBRARY, ROOT, request())).reason, 'timeout');
    assert.strictEqual(h.workersStarted, 2);
  } finally {
    h.dispose();
  }
  assert.strictEqual(WORKER_LINT_TIMEOUT_MS, 5000);
});

test('a worker that exits, or throws outside a lint, is "worker stopped"', async () => {
  const f = failure(await host('exit').lint('a', LIBRARY, ROOT, request()));
  assert.deepStrictEqual([f.reason, f.detail], ['crash', 'the worker exited with code 3']);
  const h = host('uncaught');
  message(await h.lint('a', LIBRARY, ROOT, request()));
  await until(() => h.workerCount === 0);
  assert.strictEqual(h.consecutiveFailures, 1);
});

test(`${WORKER_MAX_CONSECUTIVE_FAILURES} failures in a row pause live lint; a save-time lint still runs, and an answer resumes it`, async () => {
  const exists = { value: false };
  const h = host('answer', { exists: () => exists.value });
  try {
    for (let i = 0; i < WORKER_MAX_CONSECUTIVE_FAILURES; i++) await h.lint('a', LIBRARY, ROOT, request(), { live: true });
    assert.strictEqual(h.paused, true);
    const p = failure(await h.lint('a', LIBRARY, ROOT, request(), { live: true }));
    assert.strictEqual(p.reason, 'paused');
    assert.strictEqual(workerFailureText('typescript', p), `Lint paused after ${WORKER_MAX_CONSECUTIVE_FAILURES} failures; save to retry`);
    exists.value = true;
    message(await h.lint('a', LIBRARY, ROOT, request()));
    assert.deepStrictEqual([h.paused, h.consecutiveFailures], [false, 0]);
    message(await h.lint('a', LIBRARY, ROOT, request(), { live: true }));
  } finally {
    h.dispose();
  }
  const two = host('answer', { exists: () => false, maxFailures: 1 });
  await two.lint('a', LIBRARY, ROOT, request());
  assert.strictEqual(two.paused, true);
});

test('INV-4 only the newest request for a file is answered; other files are not affected', async () => {
  const h = host('slow', { extraWorkerData: { fake: 'slow', slowMs: 300 } });
  try {
    const first = h.lint('a', LIBRARY, ROOT, request());
    const other = h.lint('b', LIBRARY, ROOT, request());
    const second = h.lint('a', LIBRARY, ROOT, request());
    assert.strictEqual((await first).kind, 'superseded', 'superseded while the worker was starting');
    message(await other);
    message(await second);
    const busy = h.lint('a', LIBRARY, ROOT, request());
    await new Promise(r => setTimeout(r, 50));
    const newer = h.lint('a', LIBRARY, ROOT, request());
    assert.strictEqual((await busy).kind, 'superseded', 'superseded while the library was linting');
    message(await newer);
  } finally {
    h.dispose();
  }
});

test('a start failure of a superseded request is not reported for it', async () => {
  const h = host('v2');
  const first = h.lint('a', LIBRARY, ROOT, request());
  const second = h.lint('a', LIBRARY, ROOT, request());
  assert.strictEqual((await first).kind, 'superseded');
  assert.strictEqual(failure(await second).reason, 'api');
});

test('another library path replaces the worker; dispose fails a start and supersedes pending requests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-fake-lib-'));
  const copy = path.join(dir, 'index.mjs');
  fs.copyFileSync(LIBRARY, copy);
  const h = host('slow', { extraWorkerData: { fake: 'slow', slowMs: 1000 } });
  message(await h.lint('a', LIBRARY, ROOT, request()));
  message(await h.lint('a', copy, ROOT, request()));
  assert.strictEqual(h.workersStarted, 2);
  const pending = h.lint('a', copy, ROOT, request());
  await new Promise(r => setTimeout(r, 100));
  h.dispose();
  assert.strictEqual((await pending).kind, 'superseded');
  const s = host('load-slow');
  const during = s.start(LIBRARY);
  s.dispose();
  assert.deepStrictEqual(failure((await during)!).detail, 'the extension stopped the worker');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a reload while a lint waits for the worker to start: the lint waits on the new worker and is answered', async () => {
  const h = host('answer');
  try {
    const waiting = h.lint('a', LIBRARY, ROOT, request());
    h.reload();
    const other = h.lint('b', LIBRARY, ROOT, request());
    message(await waiting);
    message(await other);
    assert.deepStrictEqual([h.workersStarted, h.workerCount, h.consecutiveFailures], [2, 1, 0]);
  } finally {
    h.dispose();
  }
});

test('a message still queued from a worker that was already replaced is ignored', async () => {
  const h = host('answer');
  try {
    message(await h.lint('a', LIBRARY, ROOT, request()));
    const onMessage = (h as unknown as { onMessage(w: unknown, m: unknown): void }).onMessage.bind(h);
    onMessage({}, { type: 'error', id: 1, detail: 'from an old worker' });
    assert.deepStrictEqual([h.workerCount, h.consecutiveFailures], [1, 0]);
  } finally {
    h.dispose();
  }
});

test('INV-12 a lint with overlays writes nothing to disk: no fs write names an overlay path', async () => {
  const overlay = path.join(ROOT, 'unsaved.yml');
  const written: string[] = [];
  // The module object itself; the `import * as` namespace is read-only.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs') as typeof fs;
  const mutable = nodeFs as unknown as Record<string, (...a: unknown[]) => unknown>;
  const promises = nodeFs.promises as unknown as Record<string, (...a: unknown[]) => unknown>;
  const names = ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'openSync', 'open', 'createWriteStream', 'mkdirSync', 'copyFileSync', 'renameSync'];
  const saved = names.map(n => [n, mutable[n]] as const);
  const savedPromises = ['writeFile', 'appendFile', 'open'].map(n => [n, promises[n]] as const);
  for (const [n, fn] of saved) mutable[n] = (...a: unknown[]) => { written.push(String(a[0])); return fn.apply(nodeFs, a); };
  for (const [n, fn] of savedPromises) promises[n] = (...a: unknown[]) => { written.push(String(a[0])); return fn.apply(nodeFs.promises, a); };
  const h = host('answer');
  try {
    const r = await h.lint('a', LIBRARY, ROOT, request({ [overlay]: 'suite: unsaved\n' }));
    assert.match(message(r), /unsaved\.yml/, 'the overlay reached the library');
  } finally {
    for (const [n, fn] of saved) mutable[n] = fn;
    for (const [n, fn] of savedPromises) promises[n] = fn;
    h.dispose();
  }
  assert.ok(!written.some(w => w.toLowerCase().includes('unsaved')), written.join('\n'));
  assert.ok(!fs.existsSync(overlay));
});

test('every failure has its own status text', () => {
  const t = (reason: string, apiVersion?: string) =>
    workerFailureText('typescript', { kind: 'failure', reason: reason as never, detail: '', ...(apiVersion !== undefined ? { apiVersion } : {}) });
  assert.deepStrictEqual(
    ['untrusted', 'load', 'timeout', 'crash', 'error'].map(r => t(r)),
    ['Suite: untrusted, lint and run disabled', 'Lint: the typescript library did not load', 'Lint timed out after 5 s',
      'Lint: the typescript worker stopped', 'Lint: the typescript library failed']);
  assert.strictEqual(t('api'), 'Lint: the typescript library speaks API none; this extension speaks 1.x');
});
