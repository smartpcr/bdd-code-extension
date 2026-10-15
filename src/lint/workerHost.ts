// The lint worker's owner (plan 2.4b items 3-7, B8.1): at most one Worker per
// window, started only through the trust gate (INV-11), every request bounded
// by WORKER_LINT_TIMEOUT_MS, and only the newest request per file answered
// (INV-4). A worker that times out, crashes or reports an error is terminated
// and the next request starts a new one.
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { LIBRARY_API_MAJOR, WORKER_LINT_TIMEOUT_MS, WORKER_MAX_CONSECUTIVE_FAILURES } from '../limits';
import type { HostMessage, LibraryLintRequest, WorkerMessage } from './protocol';

export type WorkerFailureReason = 'untrusted' | 'not-found' | 'load' | 'api' | 'timeout' | 'crash' | 'error' | 'paused';

export type WorkerLintResult =
  | { kind: 'result'; diagnostics: unknown[] }
  | { kind: 'failure'; reason: WorkerFailureReason; detail: string; apiVersion?: string }
  | { kind: 'superseded' };

type Failure = Extract<WorkerLintResult, { kind: 'failure' }>;

export interface WorkerHostOptions {
  /** The worker script: dist/lintWorker.js in the extension, the compiled worker.ts in tests. */
  workerPath: string;
  gate: () => boolean;
  exists?: (p: string) => boolean;
  timeoutMs?: number;
  maxFailures?: number;
  /** Extra workerData, for the test library only. */
  extraWorkerData?: Record<string, unknown>;
}

export interface LintOptions {
  /** A lint on a pause in typing; refused while live lint is paused. */
  live?: boolean;
}

/** The status-bar text for each failure (B8.1, E-B11). */
export function workerFailureText(tool: string, f: Failure): string {
  switch (f.reason) {
    case 'untrusted': return 'Suite: untrusted, lint and run disabled';
    case 'not-found': return `Lint: ${tool} not built`;
    case 'load': return `Lint: the ${tool} library did not load`;
    case 'api': return `Lint: the ${tool} library speaks API ${f.apiVersion || 'none'}; this extension speaks ${LIBRARY_API_MAJOR}.x`;
    case 'timeout': return `Lint timed out after ${Math.round(WORKER_LINT_TIMEOUT_MS / 1000)} s`;
    case 'crash': return `Lint: the ${tool} worker stopped`;
    case 'error': return `Lint: the ${tool} library failed`;
    case 'paused': return `Lint paused after ${WORKER_MAX_CONSECUTIVE_FAILURES} failures; save to retry`;
  }
}

/** What a start waiting on a worker that another start replaced gets; it starts again. */
const REPLACED: Failure = { kind: 'failure', reason: 'crash', detail: 'the worker was replaced' };

interface Pending {
  key: string;
  timer: NodeJS.Timeout;
  resolve: (r: WorkerLintResult) => void;
}

export class LintWorkerHost {
  private worker: Worker | undefined;
  private libraryPath: string | undefined;
  /** The library's files changed since the worker loaded them (reload()). */
  private stale = false;
  private starting: Promise<Failure | undefined> | undefined;
  private settleStart: ((f: Failure | undefined) => void) | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly newest = new Map<string, number>();
  private nextId = 0;
  private readonly timeoutMs: number;
  private readonly maxFailures: number;
  private readonly exists: (p: string) => boolean;
  /** Failures since the last answer; live lint pauses at maxFailures. */
  consecutiveFailures = 0;
  /** How many workers were ever created (E-B15: none while untrusted). */
  workersStarted = 0;

  constructor(private readonly options: WorkerHostOptions) {
    this.timeoutMs = options.timeoutMs ?? WORKER_LINT_TIMEOUT_MS;
    this.maxFailures = options.maxFailures ?? WORKER_MAX_CONSECUTIVE_FAILURES;
    this.exists = options.exists ?? (p => fs.existsSync(p));
  }

  /** Live worker threads: 0 or 1 (E-B11, E-B15). */
  get workerCount(): number {
    return this.worker ? 1 : 0;
  }

  /** A worker is loaded and its library has not changed since. */
  get current(): boolean {
    return !!this.worker && !this.stale;
  }

  get paused(): boolean {
    return this.consecutiveFailures >= this.maxFailures;
  }

  /**
   * A worker loaded with `libraryPath`, ready to lint; undefined when ready, a
   * failure otherwise. Checks the trust gate itself (INV-11).
   */
  start(libraryPath: string): Promise<Failure | undefined> {
    if (!this.options.gate()) return Promise.resolve({ kind: 'failure', reason: 'untrusted', detail: 'the workspace is not trusted' });
    if (this.worker && this.libraryPath === libraryPath && !this.stale) return this.starting!;
    this.stale = false;
    this.stop('replaced');
    if (!this.exists(libraryPath)) {
      return Promise.resolve({ kind: 'failure', reason: 'not-found', detail: `no library at ${libraryPath}` });
    }
    const worker = new Worker(this.options.workerPath, {
      workerData: { libraryPath, apiMajor: LIBRARY_API_MAJOR, ...this.options.extraWorkerData },
    });
    this.workersStarted++;
    this.worker = worker;
    this.libraryPath = libraryPath;
    this.starting = new Promise(resolve => {
      const timer = setTimeout(() => this.fail(worker, 'timeout', `the library did not load within ${this.timeoutMs} ms`), this.timeoutMs);
      this.settleStart = f => {
        clearTimeout(timer);
        this.settleStart = undefined;
        resolve(f);
      };
    });
    worker.on('message', (m: WorkerMessage) => this.onMessage(worker, m));
    worker.on('error', e => this.fail(worker, 'crash', e.message));
    worker.on('exit', code => this.fail(worker, 'crash', `the worker exited with code ${code}`));
    return this.starting;
  }

  private onMessage(worker: Worker, m: WorkerMessage): void {
    if (worker !== this.worker) return;
    if (m.type === 'ready') {
      this.settleStart!(undefined);
    } else if (m.type === 'refused') {
      this.fail(worker, m.reason, m.reason === 'api' ? `the library's apiVersion is ${m.detail}` : m.detail, m.apiVersion);
    } else if (m.type === 'result') {
      // Only a live worker answers, and stop() drops a worker with its pending requests.
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      this.consecutiveFailures = 0;
      p.resolve(this.settle(p.key, m.id, { kind: 'result', diagnostics: m.diagnostics }));
    } else {
      this.fail(worker, 'error', m.detail);
    }
  }

  /** Terminate `worker` if it is the current one, and fail its start and every pending request. */
  private fail(worker: Worker, reason: WorkerFailureReason, detail: string, apiVersion?: string): void {
    if (worker !== this.worker) return;
    this.consecutiveFailures++;
    const failure: Failure = { kind: 'failure', reason, detail, ...(apiVersion !== undefined ? { apiVersion } : {}) };
    this.stop(failure);
  }

  /**
   * Drop the current worker. A failure goes to its start and every pending
   * request; on 'replaced' or 'disposed' pending requests are superseded, and a
   * waiting start is told to start again or that the extension stopped.
   */
  private stop(outcome: Failure | 'replaced' | 'disposed'): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    this.libraryPath = undefined;
    this.starting = undefined;
    void worker.terminate();
    const result: WorkerLintResult = typeof outcome === 'string' ? { kind: 'superseded' } : outcome;
    this.settleStart?.(outcome === 'replaced' ? REPLACED
      : outcome === 'disposed' ? { kind: 'failure', reason: 'crash', detail: 'the extension stopped the worker' } : outcome);
    const all = [...this.pending];
    this.pending.clear();
    for (const [id, p] of all) {
      clearTimeout(p.timer);
      p.resolve(this.settle(p.key, id, result));
    }
  }

  /** Only the newest request for a file is answered; an older one is superseded (INV-4). */
  private settle(key: string, id: number, r: WorkerLintResult): WorkerLintResult {
    return this.newest.get(key) === id ? r : { kind: 'superseded' };
  }

  /** Lint through the library; `key` names the linted file for supersession. */
  async lint(key: string, libraryPath: string, root: string, request: LibraryLintRequest, o: LintOptions = {}): Promise<WorkerLintResult> {
    if (o.live && this.paused) {
      return { kind: 'failure', reason: 'paused', detail: `${this.consecutiveFailures} failures in a row; live lint resumes on save` };
    }
    const id = ++this.nextId;
    this.newest.set(key, id);
    let startFailure = await this.start(libraryPath);
    // Another request replaced the worker this one was waiting on: wait on the new one.
    while (startFailure === REPLACED) startFailure = await this.start(libraryPath);
    if (startFailure) {
      // A worker's own failures were counted in fail(); a missing library starts none.
      if (startFailure.reason === 'not-found') this.consecutiveFailures++;
      return this.settle(key, id, startFailure);
    }
    if (this.newest.get(key) !== id) return { kind: 'superseded' };
    const worker = this.worker!;
    return new Promise(resolve => {
      const timer = setTimeout(() => this.fail(worker, 'timeout', `no answer within ${this.timeoutMs} ms`), this.timeoutMs);
      this.pending.set(id, { key, timer, resolve });
      const message: HostMessage = { type: 'lint', id, root, request };
      worker.postMessage(message);
    });
  }

  /** The catalog or schema changed: the next lint under `root` reloads them. */
  invalidate(root: string): void {
    const message: HostMessage = { type: 'invalidate', root };
    this.worker?.postMessage(message);
  }

  /**
   * The library's files changed (a build, or a test breaking it): the worker's
   * loaded copy is old, so the next lint starts a new worker. A lint already
   * running finishes on the old one; nothing is cut off mid-answer.
   */
  reload(): void {
    this.stale = true;
  }

  /** deactivate(): no worker outlives the extension. */
  dispose(): void {
    this.stop('disposed');
  }
}
