// Step events as a run writes them (spec/events.md, `suiterun run --events <file>`): one JSON object
// per line. The Test Explorer tails the file to mark each case the moment its caseFinished arrives,
// instead of waiting for the trace at the end. No vscode import, so it is unit-tested in Node.

export type CaseState = 'passed' | 'failed' | 'errored' | 'skipped';

export interface CaseEvent {
  /** The case name, or an outline row's reported name (`case [k=v]`). */
  name: string;
  state: CaseState;
  /** The run's message for anything but a pass: its own, else the status and reason. */
  message?: string;
}

/** The caseFinished an events line carries, or undefined for any other line (another event, not JSON, blank). */
export function caseEvent(line: string): CaseEvent | undefined {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object') return undefined;
  const e = data as Record<string, unknown>;
  if (e.event !== 'caseFinished' || typeof e.case !== 'string') return undefined;
  const status = typeof e.status === 'string' ? e.status : '';
  const state: CaseState = status === 'passed' || status === 'failed' || status === 'errored' ? status : 'skipped';
  if (state === 'passed') return { name: e.case, state };
  const own = typeof e.message === 'string' && e.message ? e.message : undefined;
  const reason = typeof e.reason === 'string' && e.reason ? ` (${e.reason})` : '';
  return { name: e.case, state, message: own ?? `${status || 'unknown'}${reason}` };
}

/**
 * Whole lines out of text appended to a file: the previous incomplete tail is prepended, and a
 * trailing partial line is returned as the new tail, so a line split across two reads is read once.
 */
export function splitLines(text: string, tail: string): { lines: string[]; tail: string } {
  const all = tail + text;
  if (!all) return { lines: [], tail: '' };
  const parts = all.split(/\r?\n/);
  const rest = parts.pop() as string; // split always yields at least one part
  return { lines: parts.filter(l => l.length > 0), tail: rest };
}
