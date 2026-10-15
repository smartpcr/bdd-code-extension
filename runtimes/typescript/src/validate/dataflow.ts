// E3xx, W301 and W303: what each ${...} reads, in the order the case runs.
//
// Every case is laid out in run order (suite setup, beforeEach, case setup,
// steps, the case's asserts, cleanup, afterEach), each step with an order
// number, so "read before it is produced" is a comparison of two numbers. No
// expression is evaluated at lint time; each is parsed with the evaluator's
// own reader, which also gives the paths and functions it uses.
import { unportable } from '../assertion.js';
import { Diagnostic, error, warning } from '../diag.js';
import { read as readExpression, references } from '../expr.js';
import { at, child, Document } from '../model.js';
import { Schema } from '../schema.js';
import { nearest } from '../spelling.js';
import { isList, isMap, mapOf, Value, ValueMap } from '../value.js';
import { allSteps, listOf, StepEntry, stepEntries, tableColumns, textOf } from '../walk.js';
import { entriesOf, Library, mapKeys, present } from './semantics.js';

/** The bare names the core's run context holds; extensions add their own context keys. */
const CORE_CONTEXT_KEYS = ['timeoutSec', 'defaults'];

interface Produced {
  order: number;
  action: string;
  pointer: string;
  /** A step with a table captures a list, one entry per row. */
  list: boolean;
}

interface Check {
  value: Value;
  pointer: string;
  order: number;
  inMeta: boolean;
  columns: string[];
}

/** A case's steps in run order, each with an order that sorts them. */
export function casePlan(suite: ValueMap, c: ValueMap, caseIndex: number): StepEntry[] {
  const plan: StepEntry[] = [];
  const add = (owner: ValueMap, key: string, pointer: string, phase: string, base: number) => {
    for (const e of stepEntries(listOf(owner, key) ?? [], pointer, phase)) plan.push({ ...e, order: e.order + base });
  };
  add(suite, 'setup', '/setup', 'suite setup', -4000);
  add(suite, 'beforeEach', '/beforeEach', 'beforeEach', -3000);
  add(c, 'setup', `/tests/${caseIndex}/setup`, 'case setup', -2000);
  add(c, 'steps', `/tests/${caseIndex}/steps`, 'steps', 0);
  add(c, 'cleanup', `/tests/${caseIndex}/cleanup`, 'cleanup', 100000);
  add(suite, 'afterEach', '/afterEach', 'afterEach', 200000);
  return plan;
}

/** Whether a path is inside a capture shape; an open shape (no type, any, additionalProperties) accepts any path. */
export function walkShape(shape: Value | undefined, segments: string[]): { ok: boolean; expected?: string; candidates?: string[] } {
  let current = shape;
  for (const segment of segments) {
    if (!isMap(current)) return { ok: true };
    const kind = textOf(current, 'type');
    if (!kind || kind === 'any') return { ok: true };
    if (kind === 'array') {
      if (!/^-?[0-9]+$/.test(segment) && segment !== '<index>') return { ok: false, expected: 'an index into an array' };
      current = current.get('items');
      continue;
    }
    if (kind !== 'object') return { ok: false, expected: `a ${kind}, which has no ${segment} inside it` };
    if (current.get('additionalProperties') === true) return { ok: true };
    const properties = current.get('properties');
    const declared = isMap(properties) ? [...properties.keys()] : [];
    if (!declared.includes(segment)) return { ok: false, expected: 'not declared', candidates: declared };
    current = (properties as ValueMap).get(segment);
  }
  return { ok: true };
}

/** Each ${...} in a value, with the pointer of the string that holds it. */
function referencesIn(held: Value, pointer: string): { pointer: string; expression: string }[] {
  if (typeof held === 'string') return references(held).map(r => ({ pointer, expression: r.expression }));
  if (isList(held)) return held.flatMap((item, i) => referencesIn(item, `${pointer}/${i}`));
  if (isMap(held)) return [...held].flatMap(([k, v]) => referencesIn(v, child(pointer, k)));
  return [];
}

const sorted = (names: Iterable<string>) => [...names].sort();

/** The name a script reads after `capture.`: letters, digits and underscores. */
const leadingName = (piece: string) => /^[A-Za-z0-9_]*/.exec(piece)![0];

export function checkDataflow(doc: Document, file: string, schema: Schema, library: Library, extraContextKeys: readonly string[] = []): Diagnostic[] {
  const out: Diagnostic[] = [];
  const contextKeys = [...CORE_CONTEXT_KEYS, ...extraContextKeys];
  const suite = doc.value as ValueMap;
  const declaredParams = new Set([...library.params.keys(), ...entriesOf(suite, 'params').filter(Boolean).map(p => textOf(p, 'name'))]);
  const suiteVars = new Set([...library.vars.keys(), ...mapKeys(suite, 'vars')]);
  const readParams = new Set<string>();
  const fileCaptures = new Set(allSteps(suite).map(e => textOf(e.step, 'captureAs')).filter(Boolean));

  entriesOf(suite, 'tests').forEach((c, caseIndex) => {
    if (!c) return;
    const caseName = textOf(c, 'name');
    const plan = casePlan(suite, c, caseIndex);
    const caseVars = new Set([...suiteVars, ...mapKeys(c, 'vars')]);
    for (const p of entriesOf(c, 'params')) if (p) declaredParams.add(textOf(p, 'name'));

    const sources = new Map<string, Produced>();
    for (const e of plan) {
      const name = textOf(e.step, 'captureAs');
      if (!name) continue;
      const existing = sources.get(name);
      if (existing && e.order >= existing.order) continue;
      sources.set(name, { order: e.order, action: textOf(e.step, 'action'), pointer: e.pointer, list: present(e.step, 'table') });
    }
    // A meta step's exports count as produced at its use site; a meta step used
    // twice is recorded at the later use, as in every binding (open question 4).
    for (const e of plan) {
      const used = textOf(e.step, 'meta');
      if (!used) continue;
      const definition = entriesOf(suite, 'metaSteps').find(m => m && textOf(m, 'name') === used) ?? library.metaSteps.get(used);
      if (!definition) continue;
      for (const name of listOf(definition, 'exports') ?? []) {
        if (typeof name === 'string' && name) sources.set(name, { order: e.order, action: '', pointer: e.pointer, list: false });
      }
    }

    const caseColumns = tableColumns(c.get('examples'));
    const readNames = new Set<string>();
    const checks: Check[] = [];
    const subject = (pathText: string, pointer: string, visible: Map<string, Produced>): void => {
      const segments = pathText.split('.');
      const name = segments[0]!;
      readNames.add(name);
      const position = at(doc, pointer).value;
      const source = visible.get(name);
      if (!source) {
        out.push(error('E301', file, position, `No step in case ${caseName} captures ${name}.`, nearest(name, sorted(visible.keys()), 2)));
        return;
      }
      const declared = schema.actions.get(source.action);
      if (!declared || segments.length <= 1) return;
      const shape = source.list ? mapOf({ type: 'array', items: declared.captures ?? null }) : declared.captures;
      const r = walkShape(shape, segments.slice(1));
      if (r.ok) return;
      let hint: string;
      if (!r.candidates?.length) hint = `That path wants ${r.expected}.`;
      else {
        const guess = nearest(segments[segments.length - 1]!, r.candidates, 2);
        hint = guess ? `Did you mean ${guess}` : `Declared: ${r.candidates.join(', ')}`;
      }
      out.push(error('E302', file, position, `Action ${source.action} does not declare ${pathText} in what it captures.`, hint));
    };

    for (const e of plan) {
      checks.push({ value: e.step, pointer: e.pointer, order: e.order, inMeta: e.phase.startsWith('meta '), columns: [...caseColumns, ...tableColumns(e.step.get('table'))] });
      let guard = textOf(e.step, 'ifCapture');
      if (!guard) continue;
      if (!sources.has(guard)) guard = guard.split('.')[0]!;
      readNames.add(guard);
      if (!sources.has(guard)) {
        out.push(error('E301', file, at(doc, `${e.pointer}/ifCapture`).value, `ifCapture names ${guard}, which no step in case ${caseName} captures.`,
          nearest(guard, sorted(sources.keys()), 2)));
      }
    }

    const assertions = (list: Value | undefined, pointer: string, order: number, columns: string[], visible: Map<string, Produced>) => {
      (isList(list) ? list : []).forEach((raw, index) => {
        if (!isMap(raw)) return;
        checks.push({ value: raw, pointer: `${pointer}/${index}`, order, inMeta: false, columns });
        const variable = textOf(raw, 'var');
        if (variable) subject(variable, `${pointer}/${index}/var`, visible);
        const pattern = textOf(raw, 'matches');
        const construct = pattern && unportable(pattern);
        if (construct) {
          out.push(error('E308', file, at(doc, `${pointer}/${index}/matches`).value,
            `The pattern uses ${construct}, which one binding's engine cannot run.`, 'Restrict the pattern to the subset every binding agrees on.'));
        }
        for (const piece of textOf(raw, 'script').split('capture.').slice(1)) {
          const name = leadingName(piece);
          if (name) readNames.add(name);
        }
      });
    };
    assertions(c.get('asserts'), `/tests/${caseIndex}/asserts`, 99999, caseColumns, sources);
    for (const e of plan) {
      if (!present(e.step, 'asserts')) continue;
      // A step's own asserts see what it captured, as one value, not the table's list.
      const visible = new Map(sources);
      const own = textOf(e.step, 'captureAs');
      if (present(e.step, 'table') && own && visible.has(own)) visible.set(own, { ...visible.get(own)!, list: false });
      assertions(e.step.get('asserts'), `${e.pointer}/asserts`, e.order + 1, [...caseColumns, ...tableColumns(e.step.get('table'))], visible);
    }

    for (const one of checks) {
      for (const reference of referencesIn(one.value, one.pointer)) {
        const position = at(doc, reference.pointer).value;
        const reading = readExpression(reference.expression, false);
        if (reading.error) {
          const guess = reading.error.code === 'E306' ? /Did you mean (.*)$/.exec(reading.error.message)?.[1]?.replace(/[?.]+$/, '') : undefined;
          out.push(error(reading.error.code, file, position, `\${${reference.expression}} does not parse: ${reading.error.message}.`, guess ? `Did you mean ${guess}` : undefined));
          continue;
        }
        for (const segments of reading.paths) {
          const whole = segments.join('.');
          const [root, second] = segments as [string, string | undefined];
          if (root === 'capture') {
            if (second === undefined) {
              out.push(error('E301', file, position, 'A capture reference needs a name: ${capture.<name>}.'));
              continue;
            }
            readNames.add(second);
            const source = sources.get(second);
            if (!source) {
              out.push(error('E301', file, position, `No step in case ${caseName} captures ${second}.`, nearest(second, sorted(sources.keys()), 2)));
              continue;
            }
            if (source.order >= one.order) {
              out.push(error('E303', file, position, `Capture ${second} is read before the step that produces it.`));
              continue;
            }
            subject(segments.slice(1).join('.'), reference.pointer, sources);
          } else if (root === 'param') {
            if (second === undefined) continue;
            readParams.add(second);
            if (one.inMeta || declaredParams.has(second)) continue;
            out.push(error('E301', file, position, `No parameter named ${second} is declared or imported.`, nearest(second, sorted(declaredParams), 2)));
          } else if (root === 'var') {
            if (second === undefined || caseVars.has(second)) continue;
            out.push(error('E301', file, position, `No variable named ${second} is declared.`, nearest(second, sorted(caseVars), 2)));
          } else if (root === 'defaults') {
            if (second === undefined || mapKeys(suite, 'defaults').includes(second)) continue;
            out.push(error('E301', file, position, `The defaults block declares no ${second}.`));
          } else if (root === 'row') {
            if (!one.columns.length) {
              out.push(error('E301', file, position, '${row} has no table in scope. A row exists inside a step that carries a table, or a case that carries examples.'));
            } else if (second === undefined) {
              out.push(error('E301', file, position, 'A row reference needs a column: ${row.<column>}.', `Declared: ${one.columns.join(', ')}`));
            } else if (!one.columns.includes(second)) {
              out.push(error('E301', file, position, `The table in scope declares no column ${second}.`, nearest(second, one.columns, 2)));
            }
          } else {
            if (contextKeys.includes(root) && segments.length === 1) continue;
            let hint: string;
            if (sources.has(root)) hint = `Captures are read as \${capture.${whole}}.`;
            else if (fileCaptures.has(root)) {
              hint = `Captures are read as \${capture.${whole}}, and only in the case that captured ${root}. Capture it in case ${caseName} too.`;
            } else {
              const guess = nearest(root, [...contextKeys, 'capture', 'param', 'var'], 2);
              hint = guess ? `Did you mean ${guess}` : '';
            }
            out.push(error('E301', file, position, `\${${whole}} resolves to nothing. A path starts at capture, param, var or a context key.`, hint || undefined));
          }
        }
      }
    }

    for (const name of sorted(sources.keys())) {
      const source = sources.get(name)!;
      if (readNames.has(name) || !source.pointer.startsWith(`/tests/${caseIndex}/`)) continue;
      out.push(warning('W301', file, at(doc, `${source.pointer}/captureAs`).value, `Capture ${name} in case ${caseName} is never read by a later step, an assertion or a cleanup.`));
    }
  });

  entriesOf(suite, 'metaSteps').forEach((m, metaIndex) => {
    if (!m) return;
    const captured = entriesOf(m, 'steps').map(s => textOf(s, 'captureAs')).filter(Boolean);
    (listOf(m, 'exports') ?? []).forEach((raw, exportIndex) => {
      if (typeof raw !== 'string' || !raw || captured.includes(raw)) return;
      out.push(error('E304', file, at(doc, `/metaSteps/${metaIndex}/exports/${exportIndex}`).value,
        `Meta step ${textOf(m, 'name')} exports ${raw}, which none of its steps captures.`, nearest(raw, captured, 2)));
    });
  });

  // E309: a vars block is compared by the corpus, so its values must be stable.
  const blocks: [string, ValueMap][] = [];
  if (isMap(suite.get('vars'))) blocks.push(['/vars', suite.get('vars') as ValueMap]);
  entriesOf(suite, 'tests').forEach((c, index) => {
    if (c && isMap(c.get('vars'))) blocks.push([`/tests/${index}/vars`, c.get('vars') as ValueMap]);
  });
  for (const [pointer, block] of blocks) {
    for (const [name, v] of block) {
      for (const reference of referencesIn(v, child(pointer, name))) {
        const reading = readExpression(reference.expression, true);
        if (reading.error?.code !== 'E309') continue;
        out.push(error('E309', file, at(doc, reference.pointer).value, `\${${reference.expression}} cannot be used in vars: ${reading.error.message}.`,
          'Pass the value in with --param, or capture it in a step where a changing value is fine.'));
      }
    }
  }

  entriesOf(suite, 'params').forEach((p, index) => {
    if (!p || readParams.has(textOf(p, 'name'))) return;
    out.push(warning('W303', file, at(doc, `/params/${index}/name`).value, `Parameter ${textOf(p, 'name')} is declared and never read.`));
  });
  return out;
}
