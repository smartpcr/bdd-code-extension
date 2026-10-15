// What a run says about each test item (plan B6.1-B6.5). Pure: the trace and
// report are read by the caller. The trace (Y3.3) says how each case ended;
// the NUnit report adds the failure text the trace leaves out.

/** The value as the bindings print it in a row name (DEC-Y24; Rust `values::to_text`). */
function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** `<case> [<column>=<value>, ...]`: exactly the name the bindings report for an outline row (B6.1-1). */
export function outlineRowName(caseName: string, row: Record<string, unknown>): string {
  return `${caseName} [${Object.entries(row).map(([k, v]) => `${k}=${text(v)}`).join(', ')}]`;
}

/** The names a case reports under: one per examples row, or its own. */
export function reportedNames(c: { name: string; examples: Record<string, unknown>[] }): string[] {
  return c.examples.length ? c.examples.map(r => outlineRowName(c.name, r)) : [c.name];
}

export interface TraceEntry {
  phase: string;
  case?: string;
  step?: string;
  action?: string;
  status: string;
  reason?: string;
}

/** The trace file's entries, or undefined when it is not a trace (B6.2-2). */
export function parseTrace(textOf: string): TraceEntry[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(textOf);
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const ok = data.every(e => e && typeof e === 'object' && typeof e.phase === 'string' && typeof e.status === 'string');
  return ok ? data as TraceEntry[] : undefined;
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g, (all, name: string, dec?: string, hex?: string) =>
  dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : entities[name]);

export interface ReportCase {
  result: string;
  message?: string;
}

/** Each `<test-case>` of an NUnit 3 report: its result and its failure message. */
export function parseNUnit(xml: string): Map<string, ReportCase> {
  const out = new Map<string, ReportCase>();
  const re = /<test-case\b([^>]*?)(\/>|>([\s\S]*?)<\/test-case>)/g;
  for (const m of xml.matchAll(re)) {
    const name = /\bname="([^"]*)"/.exec(m[1]);
    const result = /\bresult="([^"]*)"/.exec(m[1]);
    if (!name || !result) continue;
    const body = m[3] ?? '';
    const message = /<message>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/message>/.exec(body);
    out.set(decode(name[1]), { result: result[1], ...(message ? { message: (message[1] ?? decode(message[2])).trim() } : {}) });
  }
  return out;
}

export type ItemState = 'passed' | 'failed' | 'errored' | 'skipped';

export interface ItemResult {
  state: ItemState;
  message?: string;
}

export interface MappedRun {
  /** By reported name: a case, or an outline row. */
  cases: Map<string, ItemResult>;
  /** Suite setup and teardown failures, shown on the file item. */
  file: string[];
}

const HOOK: Record<string, string> = {
  'case-setup': 'case setup', 'case-cleanup': 'case cleanup', 'before-each': 'beforeEach', 'after-each': 'afterEach',
  'suite-setup': 'suite setup', 'suite-teardown': 'suite teardown',
};

/** One failed entry as a line: where it failed, the keyword and sentence (with the action), and why. */
function failureLine(e: TraceEntry): string {
  const where = HOOK[e.phase] ? `${HOOK[e.phase]}: ` : '';
  return `${where}${e.step ?? e.phase} failed${e.reason ? ` (${e.reason})` : ''}`;
}

const STATE: Record<string, ItemState> = { passed: 'passed', failed: 'failed', error: 'errored', skipped: 'skipped' };

/**
 * Item results from a trace (B6.2): each `case` entry's status, with the
 * failing step's keyword and sentence, and the report's message when it has
 * one, as the message.
 */
export function mapTrace(trace: TraceEntry[], report: Map<string, ReportCase> = new Map()): MappedRun {
  const cases = new Map<string, ItemResult>();
  const file = trace.filter(e => (e.phase === 'suite-setup' || e.phase === 'suite-teardown') && e.status === 'failed').map(failureLine);
  for (const e of trace) {
    if (e.phase !== 'case' || !e.case) continue;
    const state = STATE[e.status] ?? 'errored';
    if (state === 'passed') {
      cases.set(e.case, { state });
      continue;
    }
    if (state === 'skipped') {
      cases.set(e.case, { state, message: `skipped${e.reason ? ` (${e.reason})` : ''}` });
      continue;
    }
    const lines = trace.filter(x => x.case === e.case && x.phase !== 'case' && x.status === 'failed').map(failureLine);
    if (e.reason === 'suite-setup') lines.push(...file.filter(l => l.startsWith('suite setup')));
    const detail = report.get(e.case)?.message;
    if (detail && !lines.some(l => l.includes(detail))) lines.push(detail);
    if (!lines.length) lines.push(`${e.status}${e.reason ? ` (${e.reason})` : ''}`);
    cases.set(e.case, { state, message: lines.join('\n') });
  }
  return { cases, file };
}

/** A dry run's trace is empty; its report lists the cases that would run, each skipped (B6.3). */
export function mapDryRun(report: Map<string, ReportCase>): MappedRun {
  const cases = new Map<string, ItemResult>();
  for (const name of report.keys()) cases.set(name, { state: 'skipped', message: 'would run (dry run)' });
  return { cases, file: [] };
}

/** An outline's own result from its rows: any failure fails it, then any error, then all skipped, else passed. */
export function aggregate(states: ItemState[]): ItemState | undefined {
  if (!states.length) return undefined;
  for (const s of ['failed', 'errored'] as const) if (states.includes(s)) return s;
  return states.every(s => s === 'skipped') ? 'skipped' : 'passed';
}

/**
 * The `--tags` that select exactly the included cases of a file: [] when all
 * are included, one tag when it selects exactly them, undefined when no tag
 * does (the file runs whole and only the included items are reported).
 */
export function selectionTags(cases: { name: string; tags: string[] }[], included: Set<string>): string[] | undefined {
  if (cases.every(c => included.has(c.name))) return [];
  const all = [...new Set(cases.flatMap(c => c.tags))].sort();
  const exact = all.find(t => cases.every(c => c.tags.includes(t) === included.has(c.name)));
  return exact === undefined ? undefined : [exact];
}

/** A suite needs a lab unless every action it uses is `core.*` or `wait` (B6.4 item 1). */
export function isLabSuite(actions: string[]): boolean {
  return actions.some(a => a !== 'wait' && !a.startsWith('core.'));
}
