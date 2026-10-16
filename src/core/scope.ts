// What is in scope at a position (plan B3.3, B3.4, DEC-B08). An approximation
// of the bindings' dataflow pass, for suggestions only: lint decides.
import { META_DEPTH_LIMIT } from '../limits';
import { fileKey } from './paths';
import { Pos } from './text';
import type { SubjectStatus } from './suiteTokens';
import { CaptureShape, CatalogAction, StepInfo, SuiteFile } from './types';
import { contains, MetaTarget, WorkspaceIndex } from './workspaceIndex';

export interface CaptureSource {
  name: string;
  /** The step whose captureAs publishes the name (inside a meta step for an export). */
  step: StepInfo;
  /** A step with a table publishes a list, one entry per row (DEC-Y23). */
  fromTable: boolean;
}

export interface Scope {
  captures: Map<string, CaptureSource>;
  params: string[];
  vars: string[];
  /** Columns of the step's table, else of the case's examples; undefined when neither applies. */
  rows?: string[];
}

const homeIs = (s: StepInfo, kind: string, hook?: string, caseName?: string, metaName?: string): boolean =>
  s.home.kind === kind
  && (hook === undefined || (s.home.kind === 'hook' && s.home.hook === hook))
  && (s.home.kind !== 'hook' || s.home.caseName === caseName)
  && (s.home.kind !== 'case' || s.home.caseName === caseName)
  && (s.home.kind !== 'meta' || s.home.metaName === metaName);

/** The step that captures `name` inside a meta step definition, following nested uses. */
function exportSource(index: WorkspaceIndex, target: MetaTarget, name: string, depth: number): CaptureSource | undefined {
  if (depth > META_DEPTH_LIMIT) return undefined;
  const lib = index.suite(target.file)!;
  for (const s of lib.steps.filter(x => homeIs(x, 'meta', undefined, undefined, target.def.name)).reverse()) {
    if (s.captureAs === name) return { name, step: s, fromTable: s.tableColumns !== undefined };
    const nested = index.metaTargetOf(s);
    const found = nested && nested.def.exports.includes(name) ? exportSource(index, nested, name, depth + 1) : undefined;
    if (found) return found;
  }
  return undefined;
}

function addProducers(index: WorkspaceIndex, out: Map<string, CaptureSource>, producers: StepInfo[]): void {
  for (const p of producers) {
    if (p.captureAs !== undefined) out.set(p.captureAs, { name: p.captureAs, step: p, fromTable: p.tableColumns !== undefined });
    const target = index.metaTargetOf(p);
    for (const name of target?.def.exports ?? []) {
      const source = exportSource(index, target!, name, 1);
      if (source) out.set(name, source);
    }
  }
}

/** Files a suite imports, depth-first in listed order (DEC-Y17), without repeats. */
function imported(index: WorkspaceIndex, suite: SuiteFile): SuiteFile[] {
  const out: SuiteFile[] = [];
  const seen = new Set<string>([fileKey(suite.file)]);
  const visit = (s: SuiteFile, depth: number) => {
    if (depth > META_DEPTH_LIMIT) return;
    for (const i of s.imports) {
      const lib = index.suite(i.resolved);
      if (!lib || seen.has(fileKey(lib.file))) continue;
      seen.add(fileKey(lib.file));
      visit(lib, depth + 1);
      out.push(lib);
    }
  };
  visit(suite, 1);
  return out;
}

export function scopeAt(index: WorkspaceIndex, file: string, pos: Pos): Scope {
  const suite = index.suite(file);
  const scope: Scope = { captures: new Map(), params: [], vars: [] };
  if (!suite) return scope;
  const step = index.stepAt(file, pos);
  const caseName = step
    ? (step.home.kind === 'case' || step.home.kind === 'hook' ? step.home.caseName : undefined)
    : suite.cases.find(c => contains(c.range, pos))?.name;
  const before = (pred: (s: StepInfo) => boolean) =>
    suite.steps.filter(s => pred(s) && (!step || s.index < step.index));
  const all = (pred: (s: StepInfo) => boolean) => suite.steps.filter(pred);
  const setup = (s: StepInfo) => homeIs(s, 'hook', 'setup');
  const beforeEach = (s: StepInfo) => homeIs(s, 'hook', 'beforeEach');
  const caseSetup = (s: StepInfo) => homeIs(s, 'hook', 'setup', caseName);
  const caseSteps = (s: StepInfo) => homeIs(s, 'case', undefined, caseName);

  let producers: StepInfo[];
  if (step?.home.kind === 'meta') {
    producers = before(s => homeIs(s, 'meta', undefined, undefined, (step.home as { metaName: string }).metaName));
  } else if (step?.home.kind === 'hook' && step.home.caseName === undefined) {
    const hook = step.home.hook;
    producers = hook === 'setup' ? before(setup)
      : hook === 'beforeEach' ? [...all(setup), ...before(beforeEach)]
        : hook === 'afterEach' ? [...all(setup), ...all(beforeEach), ...before(s => homeIs(s, 'hook', 'afterEach'))]
          : [...all(setup), ...before(s => homeIs(s, 'hook', 'teardown'))];
  } else if (caseName !== undefined) {
    const phase = !step ? 'asserts' : step.home.kind === 'case' ? 'steps' : (step.home as { hook: string }).hook;
    producers = [...all(setup), ...all(beforeEach),
      ...(phase === 'setup' ? before(caseSetup) : all(caseSetup)),
      ...(phase === 'steps' ? before(caseSteps) : phase === 'setup' ? [] : all(caseSteps)),
      ...(phase === 'cleanup' ? before(s => homeIs(s, 'hook', 'cleanup', caseName)) : [])];
  } else {
    producers = all(setup);
  }
  if (step?.assertsRange && contains(step.assertsRange, pos)) producers.push(step);
  addProducers(index, scope.captures, producers);

  const libs = imported(index, suite);
  if (step?.home.kind === 'meta') {
    const name = step.home.metaName;
    scope.params = suite.metaSteps.find(m => m.name === name)!.params;
  } else {
    const caseInfo = suite.cases.find(c => c.name === caseName);
    scope.params = [...new Set([...suite.params.map(p => p.name), ...libs.flatMap(l => l.params.map(p => p.name)),
      ...(caseInfo?.params ?? [])])];
  }
  scope.vars = [...new Set([...suite.vars.filter(v => v.caseName === undefined || v.caseName === caseName).map(v => v.name),
    ...libs.flatMap(l => l.vars.filter(v => v.caseName === undefined).map(v => v.name))])];
  const examples = suite.cases.find(c => c.name === caseName)?.examplesColumns;
  scope.rows = step?.tableColumns?.length ? step.tableColumns : examples;
  return scope;
}

/**
 * The capture shape at a path below a capture: a CaptureShape, 'open' when an
 * open shape with nothing declared is reached, or undefined when the path is not
 * in the shape. A table capture is a list, so its first segment must be an index.
 */
export function shapeAt(action: CatalogAction, segments: string[], fromTable: boolean): CaptureShape | 'open' | undefined {
  let shape: CaptureShape = action.captures;
  let rest = segments;
  if (fromTable) {
    if (rest.length === 0) return { open: false, properties: new Map(), type: 'array', items: shape };
    if (!/^\d+$/.test(rest[0])) return undefined;
    rest = rest.slice(1);
  }
  for (const seg of rest) {
    const next = /^\d+$/.test(seg) ? shape.items : shape.properties.get(seg);
    if (!next) return shape.open ? 'open' : undefined;
    shape = next;
  }
  return shape.open && shape.properties.size === 0 && !shape.items ? 'open' : shape;
}

/**
 * Each segment of an assertion's subject at `pos` (`var: cs.Nodes.0.Name`): the
 * capture is known when it is in scope there, and each field when the capturing
 * action's declared shape has it. Past an open shape, or a capture whose step is
 * not an action, nothing is declared, so the segments are open; after an unknown
 * capture, so are the fields.
 */
export function subjectStatus(index: WorkspaceIndex, file: string, pos: Pos, path: string[]): SubjectStatus[] {
  const source = scopeAt(index, file, pos).captures.get(path[0]);
  const action = source?.step.action ? index.catalog?.actions.get(source.step.action) : undefined;
  return path.map((_, i): SubjectStatus => {
    if (i === 0) return source ? 'known' : 'unknown';
    if (!action) return 'open';
    const shape = shapeAt(action, path.slice(1, i + 1), source!.fromTable);
    return shape === undefined ? 'unknown' : shape === 'open' ? 'open' : 'known';
  });
}

/** The `capture.a.b` path covering `offset` in an expression's text, as [name, ...rest]. */
export function capturePathAt(expression: string, offset: number): string[] | undefined {
  for (const m of expression.matchAll(/(?<![\w.])capture((?:\.(?:[A-Za-z_]\w*|\d+))+)/g)) {
    if (offset >= m.index! && offset <= m.index! + m[0].length) return m[1].slice(1).split('.');
  }
  return undefined;
}
