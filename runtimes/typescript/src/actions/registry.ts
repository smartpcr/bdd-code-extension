// What an action is: a name, and a handler that takes the expanded step and a
// signal that says when to stop.
import type { Reason } from '../trace.js';
import type { Value, ValueMap } from '../value.js';

export interface Request {
  action: string;
  /** The step, every ${...} already expanded. */
  step: ValueMap;
  /** Aborted when the step's limit or the run's cancellation is reached (TS-4). */
  signal: AbortSignal;
  /** <prefix>RECORD_PATH (BDD_SUITE_RECORD_PATH by default): where core.record appends its marker, when set. */
  recordPath: string;
  /** For wait: runs the step it polls, as a step of the same case; resolves to whether it succeeded. */
  runNested?: (step: ValueMap) => Promise<boolean>;
  /** For wait: whether its until assertions hold now. */
  holds?: (assertions: Value) => boolean;
  /** The step's deadline (the case deadline for wait), as epoch milliseconds. */
  deadline?: number;
  /** For an extension's action: what that extension's start() returned as state for this run. */
  state?: unknown;
}

export type Handler = (request: Request) => Promise<Value>;

export interface Registration {
  name: string;
  handler: Handler;
}

export const action = (name: string, handler: Handler): Registration => ({ name, handler });

/** A failure with the reason the trace records for it. */
export class ActionError extends Error {
  constructor(message: string, readonly reason: Exclude<Reason, ''> = 'action') {
    super(message);
  }
}

export const failed = (message: string): ActionError => new ActionError(message, 'action');
export const timedOut = (message: string): ActionError => new ActionError(message, 'timeout');
export const assertionFailed = (message: string): ActionError => new ActionError(message, 'assertion');

/**
 * Not a failure: the case cannot run here, so it ends as skipped with this
 * message, and its cleanup and afterEach still run (spec/session.md rule 12).
 * Outside a case's setup and steps it is that hook's failure.
 */
export const skipped = (message: string): ActionError => new ActionError(message, 'skip');

/** Whether a thrown value ends its case as skipped rather than failing it. */
export const isSkip = (thrown: unknown): thrown is ActionError => thrown instanceof ActionError && thrown.reason === 'skip';

/** Sleeps for ms, or rejects with a timeout as soon as the signal aborts. */
export function sleep(ms: number, signal: AbortSignal, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(timedOut(`${what} was cancelled before it finished.`));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(timedOut(`${what} was cancelled before it finished.`));
    };
    signal.addEventListener('abort', stop, { once: true });
  });
}
