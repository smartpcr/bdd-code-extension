// What a suite becomes before it runs: its libraries read, meta steps and
// tables expanded into plain steps, an outline turned into one case per row,
// parameters and variables resolved.
import { DEFAULT_ENV_PREFIX } from './extension.js';
import * as path from 'node:path';
import { expand, newScope } from './expr.js';
import { loadDocument } from './model.js';
import { diskReader, Reader } from './reader.js';
import { isMap, text, Value, ValueMap } from './value.js';
import { CASE_PHASES, HOOKS, listOf, textOf } from './walk.js';

export const META_DEPTH_LIMIT = 5;
const GHERKIN = ['given', 'when', 'then', 'and'];

export interface Library {
  params: ValueMap[];
  vars: ValueMap;
  metaSteps: Map<string, ValueMap>;
  defaults: ValueMap;
}

/** The mapping entries of a list under a key. */
const entries = (m: ValueMap | undefined, key: string): ValueMap[] => (listOf(m, key) ?? []).filter(isMap);

/** A deep enough copy of a step: maps are copied, values shared. */
const clone = (m: ValueMap): ValueMap => new Map(m);

/**
 * Every import, depth first (a library's own imports before it), merged in
 * order: later declarations replace earlier ones. A cycle, a missing file or
 * a file that is not a YAML mapping refuses the run.
 */
export function readLibraries(suite: ValueMap, filePath: string, reader: Reader = diskReader): Library {
  const library: Library = { params: [], vars: new Map(), metaSteps: new Map(), defaults: new Map() };
  const visited = new Set([path.resolve(filePath).toLowerCase()]);
  const walk = (owner: ValueMap, ownerPath: string) => {
    for (const name of listOf(owner, 'imports') ?? []) {
      if (typeof name !== 'string' || !name) continue;
      const full = path.resolve(path.dirname(ownerPath), name);
      if (visited.has(full.toLowerCase())) throw new Error(`Import ${name} forms a cycle.`);
      const importText = reader.read(full);
      if (importText === undefined) throw new Error(`Import ${name} does not exist at ${full}.`);
      visited.add(full.toLowerCase());
      let imported: Value;
      try {
        imported = loadDocument(importText).value;
      } catch (e) {
        throw new Error(`Import ${name} is not valid YAML: ${(e as Error).message}`);
      }
      if (!isMap(imported)) throw new Error(`Import ${name} does not hold a YAML mapping.`);
      walk(imported, full);
      library.params.push(...entries(imported, 'params'));
      const vars = imported.get('vars');
      if (isMap(vars)) for (const [k, v] of vars) library.vars.set(k, v);
      for (const meta of entries(imported, 'metaSteps')) library.metaSteps.set(textOf(meta, 'name'), meta);
      const defaults = imported.get('defaults');
      if (isMap(defaults)) for (const [k, v] of defaults) library.defaults.set(k, v);
    }
  };
  walk(suite, filePath);
  return library;
}

/** Meta step definitions by name: the suite's own over the imported ones. */
export function metaDefinitions(suite: ValueMap, library: Library): Map<string, ValueMap> {
  const out = new Map(library.metaSteps);
  for (const meta of entries(suite, 'metaSteps')) out.set(textOf(meta, 'name'), meta);
  return out;
}

/** ${param.<name>} inside a meta step's body replaced by the use site's argument, as text. */
function bindMetaParams(held: Value, args: ValueMap): Value {
  if (typeof held === 'string') {
    let out = held;
    for (const [name, v] of args) out = out.split(`\${param.${name}}`).join(text(v));
    return out;
  }
  if (Array.isArray(held)) return held.map(item => bindMetaParams(item, args));
  if (isMap(held)) return new Map([...held].map(([k, v]) => [k, bindMetaParams(v, args)]));
  return held;
}

/** `col=val, ...` in the row's column order. */
export function formatRow(row: Value | undefined): string {
  return isMap(row) ? [...row].map(([k, v]) => `${k}=${text(v)}`).join(', ') : '';
}

/** What the trace and a failure call one step: its sentence and keyword, the action, and its row. */
export function stepLabel(step: ValueMap): string {
  const actionName = textOf(step, 'action');
  const index = step.get('__rowIndex');
  const row = typeof index === 'bigint' ? ` row ${index} (${formatRow(step.get('__row'))})` : '';
  const keyword = textOf(step, '__keyword');
  const sentence = textOf(step, '__sentence');
  if (keyword && sentence) return `${keyword} ${sentence} (${actionName})${row}`;
  const provenance = textOf(step, '__provenance');
  if (provenance) return `${provenance} (${actionName})${row}`;
  return `step ${actionName}${row}`;
}

/** An `and` becomes the keyword it continues, once, here. */
function resolveKeyword(step: ValueMap, previous: { keyword: string }): void {
  for (const k of ['given', 'when', 'then']) if (textOf(step, k)) previous.keyword = k;
  const continued = textOf(step, 'and');
  if (continued) {
    step.set('__keyword', previous.keyword || 'and');
    step.set('__sentence', continued);
    return;
  }
  for (const k of GHERKIN) {
    const sentence = textOf(step, k);
    if (sentence) {
      step.set('__keyword', k);
      step.set('__sentence', sentence);
      return;
    }
  }
}

/**
 * Plain steps from a step list: a meta use becomes its definition's steps
 * (defaults overlaid by `with`, the use's ifCapture passed down) to depth 5;
 * a table becomes one step per row; every step learns its keyword and where
 * it came from.
 */
export function expandSteps(steps: Value[], definitions: Map<string, ValueMap>, whereItIs: string, depth = 0, provenance = ''): ValueMap[] {
  const out: ValueMap[] = [];
  const previous = { keyword: '' };
  steps.forEach((raw, index) => {
    if (!isMap(raw)) return;
    const position = provenance ? `${provenance} step ${index + 1}` : `step ${index + 1}`;
    const used = textOf(raw, 'meta');
    if (used) {
      const definition = definitions.get(used);
      if (!definition) throw new Error(`${whereItIs} ${position} uses meta step ${used}, which is not declared or imported.`);
      if (depth >= META_DEPTH_LIMIT) {
        throw new Error(`${whereItIs} ${position} nests meta steps deeper than ${META_DEPTH_LIMIT}, which is the limit. A meta step that uses itself, directly or through another, is a cycle.`);
      }
      const args = new Map<string, Value>();
      for (const declared of entries(definition, 'params')) {
        const fallback = declared.get('default');
        if (fallback !== undefined && fallback !== null) args.set(textOf(declared, 'name'), fallback);
      }
      const given = raw.get('with');
      if (isMap(given)) for (const [k, v] of given) args.set(k, v);
      const body = (listOf(definition, 'steps') ?? []).map(inner => bindMetaParams(inner, args));
      const guard = textOf(raw, 'ifCapture');
      for (const inner of expandSteps(body, definitions, whereItIs, depth + 1, `meta ${used}`)) {
        if (guard && !textOf(inner, 'ifCapture')) inner.set('ifCapture', guard);
        out.push(inner);
      }
      return;
    }
    const table = raw.get('table');
    if (table !== undefined && table !== null) {
      const rows = Array.isArray(table) ? table : [];
      rows.forEach((row, rowIndex) => {
        const copied = clone(raw);
        copied.delete('table');
        copied.set('__row', row);
        copied.set('__rowIndex', BigInt(rowIndex + 1));
        copied.set('__rowCount', BigInt(rows.length));
        copied.set('__provenance', position);
        resolveKeyword(copied, previous);
        out.push(copied);
      });
      return;
    }
    const copied = clone(raw);
    copied.set('__provenance', position);
    resolveKeyword(copied, previous);
    out.push(copied);
  });
  return out;
}

/** One case per examples row, named `name [col=val, ...]`; a case without examples is itself. */
export function expandOutline(c: ValueMap): ValueMap[] {
  const examples = c.get('examples');
  if (!Array.isArray(examples) || !examples.length) return [c];
  return examples.map(row => {
    const copied = clone(c);
    copied.delete('examples');
    copied.set('name', `${textOf(c, 'name')} [${formatRow(row)}]`);
    copied.set('__row', row);
    return copied;
  });
}

export const cases = (suite: ValueMap): ValueMap[] => entries(suite, 'tests').flatMap(expandOutline);

/** A case's tags, then the suite's. */
export const caseTags = (suite: ValueMap, c: ValueMap): string[] =>
  [...(listOf(c, 'tags') ?? []), ...(listOf(suite, 'tags') ?? [])].filter((t): t is string => typeof t === 'string');

/** No filter selects everything; otherwise any shared tag does. */
export const tagsMatch = (tags: string[], filter: string[]): boolean => !filter.length || tags.some(t => filter.includes(t));

/**
 * Parameter values, lowest first: library, file, case (a default, then a
 * value), then <prefix>PARAM_<NAME> (BDD_SUITE_PARAM_<NAME> by default) for the
 * names declared above the case,
 * then --param. The last one wins.
 */
export function resolveParams(library: Library, suite: ValueMap, c: ValueMap | undefined, commandLine: [string, string][], env: NodeJS.ProcessEnv = process.env,
  envPrefix = DEFAULT_ENV_PREFIX): ValueMap {
  const values = new Map<string, Value>();
  const fileLevel = [...library.params, ...entries(suite, 'params')];
  for (const declared of [...fileLevel, ...entries(c, 'params')]) {
    const name = textOf(declared, 'name');
    if (!name) continue;
    for (const key of ['default', 'value']) {
      const v = declared.get(key);
      if (v !== undefined && v !== null) values.set(name, v);
    }
  }
  const names = [...values.keys()];
  for (const declared of fileLevel) {
    const name = textOf(declared, 'name');
    if (name && !names.includes(name)) names.push(name);
  }
  for (const name of names) {
    const fromEnv = env[`${envPrefix}PARAM_${name.toUpperCase()}`];
    if (fromEnv !== undefined) values.set(name, fromEnv);
  }
  for (const [name, v] of commandLine) values.set(name, v);
  return values;
}

/** Variables, lowest first (library, file, case), each expanded against the scope as it is so far. */
export function resolveVars(library: Library, suite: ValueMap, c: ValueMap | undefined, scope: ValueMap, roots?: readonly string[]): void {
  const sources = [library.vars, suite.get('vars'), c?.get('vars')].filter(isMap);
  let bag = scope.get('var');
  if (!isMap(bag)) {
    bag = new Map();
    scope.set('var', bag);
  }
  for (const source of sources) for (const [name, v] of source) (bag as ValueMap).set(name, expand(v, newScope(scope, roots)));
}

/** The expanded steps of each case phase. */
export function expandedCase(c: ValueMap, definitions: Map<string, ValueMap>): Record<string, ValueMap[]> {
  return Object.fromEntries(CASE_PHASES.map(phase => [phase, expandSteps(listOf(c, phase) ?? [], definitions, `case ${textOf(c, 'name')}`)]));
}

/** The expanded steps of each suite hook. */
export function expandedHooks(suite: ValueMap, definitions: Map<string, ValueMap>): Record<string, ValueMap[]> {
  return Object.fromEntries(HOOKS.map(hook => [hook, expandSteps(listOf(suite, hook) ?? [], definitions, `the suite ${hook}`)]));
}

/** A step's limit: its own when it has one smaller than what is left, else what is left. */
export const stepLimit = (ownSec: number, remainingSec: number): number => (ownSec > 0 && ownSec < remainingSec ? ownSec : remainingSec);

