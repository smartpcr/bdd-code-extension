// E2xx, W302 and W304: what a suite means rather than what it spells
// (diagnostics.md), at the positions the corpus pins.
import * as path from 'node:path';
import { Diagnostic, error, warning } from '../diag.js';
import { DEFAULT_ENV_PREFIX } from '../extension.js';
import { at, child, Document, loadDocument } from '../model.js';
import { Reader } from '../reader.js';
import { Schema } from '../schema.js';
import { nearest } from '../spelling.js';
import { isList, isMap, text, Value, ValueMap } from '../value.js';
import { allSteps, CASE_PHASES, listOf, stepEntries, stepLists, tableColumns, textOf } from '../walk.js';

/** What a library may declare: nothing that runs. */
const LIBRARY_KEYS = ['params', 'vars', 'metaSteps', 'defaults', 'description', 'schemaVersion'];
const LIMIT_CEILING_SEC = 14400;
const GHERKIN = ['given', 'when', 'then', 'and'];

export interface ParamDeclaration {
  hasValue: boolean;
  pointer: string;
}

/** What a suite's imports declare, the names the suite redeclares, and what was wrong with an import. */
export interface Library {
  params: Map<string, ParamDeclaration>;
  /** Variable name to the import that declares it. */
  vars: Map<string, string>;
  metaSteps: Map<string, ValueMap>;
  defaults: Map<string, string>;
  collisions: { kind: string; name: string; source: string; pointer: string }[];
  diagnostics: Diagnostic[];
  /** Every import the suite and its libraries name, in reading order, for an extension's rules. */
  imports: { import: string; pointer: string; file: string }[];
}

/** The entries of a list under a key, a non-mapping entry as undefined (positions count it). */
export const entriesOf = (m: ValueMap | undefined, key: string): (ValueMap | undefined)[] =>
  (listOf(m, key) ?? []).map(v => (isMap(v) ? v : undefined));

/** The keys of a mapping under a key, or none. */
export const mapKeys = (m: ValueMap | undefined, key: string): string[] => {
  const v = m?.get(key);
  return isMap(v) ? [...v.keys()] : [];
};

/** A key that is there with a value other than null. */
export const present = (m: ValueMap | undefined, key: string): boolean => !!m && m.has(key) && m.get(key) !== null;

const norm = (p: string) => path.resolve(p).toLowerCase();

/** Reads every import through the reader (overlays first, TS-5), one level deep, as every binding does. */
export function readImports(doc: Document, file: string, filePath: string, reader: Reader): Library {
  const library: Library = { params: new Map(), vars: new Map(), metaSteps: new Map(), defaults: new Map(), collisions: [], diagnostics: [], imports: [] };
  const suite = isMap(doc.value) ? doc.value : undefined;
  const visited = new Set([norm(filePath)]);
  const directory = path.dirname(filePath);
  (listOf(suite, 'imports') ?? []).forEach((raw, index) => {
    if (typeof raw !== 'string' || !raw) return;
    const pointer = `/imports/${index}`;
    const position = at(doc, pointer).value;
    const full = path.resolve(directory, raw);
    if (visited.has(norm(full))) {
      library.diagnostics.push(error('E207', file, position, `Import ${raw} forms a cycle.`));
      return;
    }
    const importText = reader.read(full);
    if (importText === undefined) {
      library.diagnostics.push(error('E301', file, position, `Import ${raw} does not exist.`));
      return;
    }
    visited.add(norm(full));
    library.imports.push({ import: raw, pointer, file: full });
    let imported: Value;
    try {
      imported = loadDocument(importText).value;
    } catch (e) {
      library.diagnostics.push(error('E100', file, position, `Import ${raw} is not valid YAML: ${(e as Error).message}`));
      return;
    }
    if (!isMap(imported)) {
      library.diagnostics.push(error('E100', file, position, `Import ${raw} does not hold a YAML mapping.`));
      return;
    }
    for (const key of imported.keys()) {
      if (!LIBRARY_KEYS.includes(key)) {
        library.diagnostics.push(error('E211', file, position, `Import ${raw} declares ${key}. A library declares ${LIBRARY_KEYS.join(', ')} and nothing that runs.`));
      }
    }
    for (const p of entriesOf(imported, 'params')) {
      if (p) library.params.set(textOf(p, 'name'), { hasValue: present(p, 'default') || present(p, 'input'), pointer });
    }
    for (const v of mapKeys(imported, 'vars')) library.vars.set(v, raw);
    for (const m of entriesOf(imported, 'metaSteps')) if (m) library.metaSteps.set(textOf(m, 'name'), m);
    for (const k of mapKeys(imported, 'defaults')) library.defaults.set(k, raw);
  });
  entriesOf(suite, 'metaSteps').forEach((m, index) => {
    if (m && library.metaSteps.has(textOf(m, 'name')) && !present(m, 'override')) {
      library.collisions.push({ kind: 'Meta step', name: textOf(m, 'name'), source: 'library', pointer: `/metaSteps/${index}/name` });
    }
  });
  entriesOf(suite, 'params').forEach((p, index) => {
    if (p && library.params.has(textOf(p, 'name')) && !present(p, 'override')) {
      library.collisions.push({ kind: 'Parameter', name: textOf(p, 'name'), source: 'library', pointer: `/params/${index}/name` });
    }
  });
  for (const name of mapKeys(suite, 'vars')) {
    const source = library.vars.get(name);
    if (source !== undefined) library.collisions.push({ kind: 'Variable', name, source, pointer: child('/vars', name) });
  }
  return library;
}

/** E204: an assertion with a subject and no comparison, or with no subject. */
function assertionShape(assertions: Value | undefined, pointer: string, where: string, schema: Schema, doc: Document, file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  (isList(assertions) ? assertions : []).forEach((raw, index) => {
    if (!isMap(raw)) return;
    const operators = [...raw.keys()].filter(k => schema.assertOperators.includes(k));
    const position = at(doc, `${pointer}/${index}`).key;
    if (!operators.length && present(raw, 'var')) {
      out.push(error('E204', file, position, `The assertion on ${textOf(raw, 'var')} in ${where} names a subject and no comparison, so it asserts nothing.`,
        `One of: ${schema.assertOperators.join(', ')}`));
    } else if (!present(raw, 'var') && !present(raw, 'script')) {
      out.push(error('E204', file, position, `An assertion in ${where} names no subject. Add var, or use script.`));
    }
  });
  return out;
}

/** E213: a table or examples block that is empty, uneven or repeats a row. */
function tableRules(table: Value | undefined, pointer: string, where: string, doc: Document, file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!isList(table)) return out;
  if (!table.some(r => r !== null)) return [error('E213', file, at(doc, pointer).key, `The table on ${where} has no rows, so the step it drives would never run.`)];
  const columns = tableColumns(table);
  const seen = new Map<string, number>();
  table.forEach((raw, index) => {
    if (!isMap(raw)) return;
    const rowColumns = [...raw.keys()];
    const position = at(doc, `${pointer}/${index}`).key;
    const missing = columns.filter(c => !rowColumns.includes(c)).map(c => `${c} is missing`);
    const extra = rowColumns.filter(c => !columns.includes(c)).map(c => `${c} is extra`);
    if (missing.length || extra.length) {
      out.push(error('E213', file, position, `Row ${index + 1} of the table on ${where} does not declare the same columns as the first row: ${[...missing, ...extra].join(', ')}.`));
    }
    const signature = [...rowColumns].sort().map(c => `${c}=${text(raw.get(c)!)}`).join('\u0001');
    const first = seen.get(signature);
    if (first !== undefined) {
      out.push(error('E213', file, position, `Row ${index + 1} of the table on ${where} repeats row ${first}, which would give two iterations the same name.`));
      return;
    }
    seen.set(signature, index + 1);
  });
  return out;
}

const RANK: Record<string, number> = { given: 1, when: 2, then: 3 };
const BEFORE = ['', 'given', 'when', 'then'];

/** E212, E213 and W304: the Gherkin keywords, step tables and outlines. */
function scenarioRules(doc: Document, file: string, suite: ValueMap): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const list of stepLists(suite)) {
    let started = false;
    let highest = 0;
    let labelled = 0;
    let total = 0;
    list.steps.forEach((raw, index) => {
      if (!isMap(raw)) return;
      const stepPointer = `${list.pointer}/${index}`;
      const keywords = [...raw.keys()].filter(k => GHERKIN.includes(k));
      // A meta step use without a keyword is not an unlabelled step (design 6.4).
      if (keywords.length || !present(raw, 'meta')) total++;
      if (keywords.length > 1) {
        out.push(error('E212', file, at(doc, `${stepPointer}/${keywords[1]}`).key,
          `Step ${index + 1} of ${list.name} carries ${keywords.join(' and ')}. A step carries one Gherkin keyword.`));
      }
      const keyword = keywords[0];
      if (keyword) {
        labelled++;
        if (keyword === 'and') {
          if (!started) {
            out.push(error('E212', file, at(doc, `${stepPointer}/and`).key, `Step ${index + 1} of ${list.name} is an and with nothing before it to continue.`,
              'Start the list with given, when or then.'));
          }
        } else {
          const rank = RANK[keyword]!;
          if (rank < highest) {
            out.push(error('E212', file, at(doc, `${stepPointer}/${keyword}`).key,
              `Step ${index + 1} of ${list.name} is a ${keyword} after a ${BEFORE[highest]}. The order is given, then when, then then.`,
              'Continue with and, or move the step.'));
          }
          highest = Math.max(highest, rank);
          started = true;
        }
      }
      if (present(raw, 'table')) {
        out.push(...tableRules(raw.get('table'), `${stepPointer}/table`, `step ${index + 1} of ${list.name}`, doc, file));
        if (list.case && present(list.case, 'examples')) {
          out.push(error('E213', file, at(doc, `${stepPointer}/table`).key,
            `Step ${index + 1} of ${list.name} carries a table inside a case that already carries examples. There is one row namespace, and two row scopes would shadow each other.`,
            'Keep the table and drop the examples, or the other way round.'));
        }
      }
    });
    if (labelled > 0 && labelled < total) {
      out.push(warning('W304', file, at(doc, list.pointer).key, `${list.name} labels ${labelled} of its ${total} steps with a Gherkin keyword. Label all of them or none.`));
    }
  }
  entriesOf(suite, 'tests').forEach((c, index) => {
    if (c && present(c, 'examples')) out.push(...tableRules(c.get('examples'), `/tests/${index}/examples`, `case ${textOf(c, 'name')}`, doc, file));
  });
  return out;
}

/** E205: every limit between 1 and its ceiling. A runtime extension may add a stricter rule of its own. */
function limits(doc: Document, file: string, suite: ValueMap): Diagnostic[] {
  const out: Diagnostic[] = [];
  const declared: { pointer: string; name: string; value: Value; scope: string }[] = [];
  for (const key of ['setupTimeoutSec', 'beforeEachTimeoutSec', 'afterEachTimeoutSec', 'teardownTimeoutSec']) {
    if (present(suite, key)) declared.push({ pointer: `/${key}`, name: key, value: suite.get(key)!, scope: 'the suite' });
  }
  const defaults = suite.get('defaults');
  if (isMap(defaults)) {
    for (const key of ['timeoutSec', 'cleanupTimeoutSec']) {
      if (present(defaults, key)) declared.push({ pointer: `/defaults/${key}`, name: key, value: defaults.get(key)!, scope: 'the suite defaults' });
    }
  }
  entriesOf(suite, 'tests').forEach((c, index) => {
    if (!c) return;
    for (const key of ['timeoutSec', 'cleanupTimeoutSec', 'setupTimeoutSec']) {
      if (present(c, key)) declared.push({ pointer: `/tests/${index}/${key}`, name: key, value: c.get(key)!, scope: `case ${textOf(c, 'name')}` });
    }
  });
  for (const one of declared) {
    const ceiling = LIMIT_CEILING_SEC;
    if (typeof one.value !== 'bigint') continue;
    if (one.value < 1n || one.value > BigInt(ceiling)) {
      out.push(error('E205', file, at(doc, one.pointer).value, `${one.name} on ${one.scope} is ${one.value} seconds, outside 1 to ${ceiling}.`));
    }
  }
  return out;
}

/** How deep a meta step nests, or the cycle it is part of. */
function metaDepth(name: string, definitions: Map<string, { definition: ValueMap; pointer: string }>, trail: string[]): { depth: number; cycle?: string[] } {
  if (trail.includes(name)) return { depth: trail.length, cycle: [...trail, name] };
  const found = definitions.get(name);
  if (!found) return { depth: trail.length };
  trail.push(name);
  let deepest = trail.length;
  for (const step of entriesOf(found.definition, 'steps')) {
    const used = textOf(step, 'meta');
    if (!used) continue;
    const r = metaDepth(used, definitions, trail);
    if (r.cycle) {
      trail.pop();
      return r;
    }
    deepest = Math.max(deepest, r.depth);
  }
  trail.pop();
  return { depth: deepest };
}

export interface SemanticsOptions {
  binding: string;
  bindingCheck: boolean;
  params: [string, string][];
  /** <prefix>PARAM_<NAME> variables count as values; injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** The prefix of those variables; BDD_SUITE_ by default. */
  envPrefix?: string;
}

export function checkSemantics(doc: Document, file: string, schema: Schema, library: Library, options: SemanticsOptions): Diagnostic[] {
  const out: Diagnostic[] = [];
  const suite = doc.value as ValueMap;
  const tests = entriesOf(suite, 'tests');

  const seenCase = new Set<string>();
  tests.forEach((c, index) => {
    if (!c) return;
    const name = textOf(c, 'name');
    if (seenCase.has(name)) out.push(error('E202', file, at(doc, `/tests/${index}/name`).value, `Case ${name} is declared twice in this suite.`));
    else seenCase.add(name);
  });
  tests.forEach((c, index) => {
    if (!c) return;
    const seenCapture = new Set<string>();
    for (const phase of CASE_PHASES) {
      for (const entry of stepEntries(listOf(c, phase) ?? [], `/tests/${index}/${phase}`, phase)) {
        const name = textOf(entry.step, 'captureAs');
        if (!name) continue;
        if (seenCapture.has(name)) {
          out.push(error('E203', file, at(doc, `${entry.pointer}/captureAs`).value, `Case ${textOf(c, 'name')} already captures ${name}. The second would replace the first.`));
        } else seenCapture.add(name);
      }
    }
    out.push(...assertionShape(c.get('asserts'), `/tests/${index}/asserts`, `case ${textOf(c, 'name')}`, schema, doc, file));
  });
  for (const entry of allSteps(suite)) {
    out.push(...assertionShape(entry.step.get('asserts'), `${entry.pointer}/asserts`, `a ${entry.phase} step`, schema, doc, file));
  }
  out.push(...limits(doc, file, suite));
  out.push(...scenarioRules(doc, file, suite));

  // Meta steps: the suite's own first, then the imported ones it does not redeclare.
  const definitions = new Map<string, { definition: ValueMap; pointer: string }>();
  entriesOf(suite, 'metaSteps').forEach((m, index) => {
    if (m) definitions.set(textOf(m, 'name'), { definition: m, pointer: `/metaSteps/${index}` });
  });
  for (const name of [...library.metaSteps.keys()].sort()) if (!definitions.has(name)) definitions.set(name, { definition: library.metaSteps.get(name)!, pointer: '' });
  const names = [...definitions.keys()].sort();
  for (const entry of allSteps(suite)) {
    const used = textOf(entry.step, 'meta');
    if (!used) continue;
    const found = definitions.get(used);
    if (!found) {
      out.push(error('E206', file, at(doc, `${entry.pointer}/meta`).value, `No meta step named ${used} is declared or imported.`, nearest(used, names, 2)));
      continue;
    }
    const params = entriesOf(found.definition, 'params').filter((p): p is ValueMap => !!p);
    const declared = params.map(p => textOf(p, 'name'));
    const supplied = mapKeys(entry.step, 'with');
    for (const p of params) {
      const name = textOf(p, 'name');
      if (p.get('required') === true && !supplied.includes(name) && !present(p, 'default')) {
        out.push(error('E208', file, at(doc, `${entry.pointer}/meta`).value, `Meta step ${used} requires the parameter ${name}, and this use site does not pass it.`));
      }
    }
    for (const name of supplied) {
      if (!declared.includes(name)) {
        out.push(error('E208', file, at(doc, child(`${entry.pointer}/with`, name)).key, `Meta step ${used} declares no parameter ${name}.`, nearest(name, declared, 2)));
      }
    }
  }
  for (const name of names) {
    const r = metaDepth(name, definitions, []);
    const pointer = definitions.get(name)!.pointer;
    if (r.cycle) out.push(error('E207', file, at(doc, pointer).key, `Meta step ${name} is part of a cycle: ${r.cycle.join(' uses ')}.`));
    else if (r.depth > 5) out.push(error('E207', file, at(doc, pointer).key, `Meta step ${name} nests ${r.depth} deep, and five is the limit.`));
  }
  for (const c of library.collisions) {
    out.push(error('E209', file, at(doc, c.pointer).key, `${c.kind} ${c.name} is already declared by the imported ${c.source}.`,
      'Add override: true to say that the replacement is deliberate.'));
  }
  out.push(...library.diagnostics);

  // E210: a parameter with no value at any level, or a --param the suite does not declare.
  const params = new Map(library.params);
  entriesOf(suite, 'params').forEach((p, index) => {
    if (p) params.set(textOf(p, 'name'), { hasValue: present(p, 'default') || present(p, 'value') || present(p, 'input'), pointer: `/params/${index}` });
  });
  tests.forEach((c, caseIndex) => {
    entriesOf(c, 'params').forEach((p, paramIndex) => {
      if (!p) return;
      const name = textOf(p, 'name');
      const existing = params.get(name) ?? { hasValue: false, pointer: `/tests/${caseIndex}/params/${paramIndex}` };
      if (present(p, 'value') || present(p, 'default') || present(p, 'input')) existing.hasValue = true;
      params.set(name, existing);
    });
  });
  const given = new Set(options.params.map(([k]) => k));
  const env = options.env ?? process.env;
  const declaredNames = [...params.keys()].sort();
  for (const name of declaredNames) {
    const d = params.get(name)!;
    if (d.hasValue || given.has(name) || env[`${options.envPrefix ?? DEFAULT_ENV_PREFIX}PARAM_${name.toUpperCase()}`] !== undefined) continue;
    out.push(error('E210', file, at(doc, d.pointer).key, `Parameter ${name} has no value at any level and no default.`, `Give it a default, or pass --param ${name}=<value>.`));
  }
  for (const [name] of options.params) {
    if (!params.has(name)) {
      out.push(error('E210', file, at(doc, '').key, `--param ${name} names a parameter this suite does not declare.`, nearest(name, declaredNames, 2)));
    }
  }

  for (const entry of allSteps(suite)) {
    const action = textOf(entry.step, 'action');
    const declaration = schema.actions.get(action);
    if (!declaration) continue;
    const position = at(doc, `${entry.pointer}/action`).value;
    if (declaration.deprecated) out.push(warning('W302', file, position, `Action ${action} is marked deprecated in the catalog.`));
    if (options.bindingCheck && !declaration.bindings.includes(options.binding)) {
      out.push(error('E201', file, position, `The ${options.binding} binding does not implement ${action}. Implemented by: ${declaration.bindings.join(', ')}.`));
    }
  }
  return out;
}
