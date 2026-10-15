// Where the steps of a suite are: every step list, and every step with its
// JSON pointer and phase, in the order the passes visit them.
import { isList, isMap, Value, ValueMap } from './value.js';

export interface StepEntry {
  step: ValueMap;
  pointer: string;
  phase: string;
  /** Ten per position in its list; a forStep comes one before its step. */
  order: number;
}

export interface StepList {
  steps: Value[];
  pointer: string;
  name: string;
  case?: ValueMap;
  caseIndex: number;
}

export const HOOKS = ['setup', 'beforeEach', 'afterEach', 'teardown'] as const;
export const CASE_PHASES = ['setup', 'steps', 'cleanup'] as const;

export const textOf = (m: ValueMap | undefined, key: string): string => {
  const v = m?.get(key);
  return typeof v === 'string' ? v : '';
};

/** The list under a key, and whether the key is there with a list. */
export function listOf(m: ValueMap | undefined, key: string): Value[] | undefined {
  const v = m?.get(key);
  return isList(v) ? v : undefined;
}

export function stepEntries(list: Value[], pointer: string, phase: string): StepEntry[] {
  const out: StepEntry[] = [];
  list.forEach((raw, index) => {
    if (!isMap(raw)) return;
    const stepPointer = `${pointer}/${index}`;
    const nested = raw.get('forStep');
    if (isMap(nested)) out.push({ step: nested, pointer: `${stepPointer}/forStep`, phase, order: index * 10 - 1 });
    out.push({ step: raw, pointer: stepPointer, phase, order: index * 10 });
  });
  return out;
}

/** Every step: the suite hooks, then each meta step's steps, then each case's setup, steps and cleanup. */
export function allSteps(suite: ValueMap | undefined): StepEntry[] {
  const out: StepEntry[] = [];
  for (const hook of HOOKS) out.push(...stepEntries(listOf(suite, hook) ?? [], `/${hook}`, hook));
  (listOf(suite, 'metaSteps') ?? []).forEach((meta, index) => {
    if (!isMap(meta)) return;
    out.push(...stepEntries(listOf(meta, 'steps') ?? [], `/metaSteps/${index}/steps`, `meta ${textOf(meta, 'name')}`));
  });
  (listOf(suite, 'tests') ?? []).forEach((c, index) => {
    if (!isMap(c)) return;
    for (const phase of CASE_PHASES) out.push(...stepEntries(listOf(c, phase) ?? [], `/tests/${index}/${phase}`, phase));
  });
  return out;
}

/** Every step list that is present, whatever its items are. */
export function stepLists(suite: ValueMap | undefined): StepList[] {
  const out: StepList[] = [];
  const push = (steps: Value[] | undefined, pointer: string, name: string, c: ValueMap | undefined, caseIndex: number) => {
    if (steps) out.push({ steps, pointer, name, ...(c ? { case: c } : {}), caseIndex });
  };
  for (const hook of HOOKS) push(listOf(suite, hook), `/${hook}`, `the suite ${hook}`, undefined, -1);
  (listOf(suite, 'metaSteps') ?? []).forEach((meta, index) => {
    if (isMap(meta)) push(listOf(meta, 'steps'), `/metaSteps/${index}/steps`, `meta step ${textOf(meta, 'name')}`, undefined, -1);
  });
  (listOf(suite, 'tests') ?? []).forEach((c, index) => {
    if (!isMap(c)) return;
    for (const phase of CASE_PHASES) push(listOf(c, phase), `/tests/${index}/${phase}`, `case ${textOf(c, 'name')} ${phase}`, c, index);
  });
  return out;
}

/** A table's columns: the keys of its first mapping row. */
export function tableColumns(table: Value | undefined): string[] {
  for (const row of isList(table) ? table : []) if (isMap(row)) return [...row.keys()];
  return [];
}
