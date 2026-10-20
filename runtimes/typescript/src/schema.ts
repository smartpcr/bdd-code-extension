// The suite schema and the action catalog, read at run time (nothing is
// compiled in, so a catalog change needs no rebuild).
import * as path from 'node:path';
import { CORE_CATALOG } from './coreCatalog.js';
import { loadDocument } from './model.js';
import { diskReader, Reader } from './reader.js';
import { isList, isMap, Value, ValueMap } from './value.js';

export interface Action {
  name: string;
  bindings: string[];
  interruptible: boolean;
  deprecated: boolean;
  params: string[];
  captures: Value | undefined;
  hasShape: boolean;
}

export interface Schema {
  /** suite.schema.json with $defs.step replaced by $defs.stepEnvelope, for the whole-document pass. */
  document: Record<string, unknown>;
  defs: Record<string, unknown>;
  actions: Map<string, Action>;
  /** Sorted. */
  actionNames: string[];
  /** The assertion operators, `var` excluded, sorted. */
  assertOperators: string[];
  /** The keys every step may carry ($defs.stepCommon), sorted. */
  stepCommonKeys: string[];
}

export class SchemaError extends Error {}

const propertyNames = (definition: unknown): string[] => {
  const props = (definition as { properties?: unknown } | undefined)?.properties;
  return props && typeof props === 'object' ? Object.keys(props).sort() : [];
};
const strings = (v: Value | undefined): string[] => (isList(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const bool = (v: Value | undefined, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const str = (m: ValueMap, k: string) => (typeof m.get(k) === 'string' ? (m.get(k) as string) : '');

/** Reads suite.schema.json and actions.catalog.yaml from schemaRoot. */
export function loadSchema(schemaRoot: string, reader: Reader = diskReader): Schema {
  const schemaPath = path.join(schemaRoot, 'suite.schema.json');
  const catalogPath = path.join(schemaRoot, 'actions.catalog.yaml');
  const schemaText = reader.read(schemaPath);
  const catalogText = reader.read(catalogPath);
  if (schemaText === undefined || catalogText === undefined) {
    throw new SchemaError(`Suite schema not found at ${schemaText === undefined ? schemaPath : catalogPath}. Generate it with the spec's Build-Schema.ps1 -Catalog <catalog>.`);
  }
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(schemaText) as Record<string, unknown>;
  } catch (e) {
    throw new SchemaError(`${schemaPath} is not JSON: ${(e as Error).message}`);
  }
  const defs = document.$defs as Record<string, unknown> | undefined;
  if (!defs || typeof defs !== 'object') throw new SchemaError('suite.schema.json carries no $defs.');
  if (!('stepEnvelope' in defs)) throw new SchemaError('suite.schema.json carries no stepEnvelope definition.');
  const assertOperators = propertyNames(defs.assert).filter(n => n !== 'var');
  const stepCommonKeys = propertyNames(defs.stepCommon);
  // The whole-document pass checks every step against what all steps share;
  // each step is then checked against its own action's branch.
  defs.step = defs.stepEnvelope;

  const actions = new Map<string, Action>();
  for (const { entry, file } of catalogEntries(catalogPath, catalogText, reader)) {
    const name = str(entry, 'name');
    if (!name) continue;
    const held = actions.get(name);
    if (held) throw new SchemaError(`Action ${name} is declared twice: in ${declaredIn.get(name)} and in ${file}.`);
    declaredIn.set(name, file);
    const params = isList(entry.get('params')) ? (entry.get('params') as Value[]).filter(isMap).map(p => str(p, 'name')).filter(Boolean) : [];
    const captures = entry.get('captures');
    actions.set(name, {
      name, bindings: strings(entry.get('bindings')), interruptible: bool(entry.get('interruptible'), true),
      deprecated: bool(entry.get('deprecated'), false), params, captures, hasShape: entry.has('captures') && captures !== null,
    });
  }
  return { document, defs, actions, actionNames: [...actions.keys()].sort(), assertOperators, stepCommonKeys };
}

const declaredIn = new Map<string, string>();

/**
 * Every action entry of a catalog and of the catalogs it imports (DEC-S10):
 * imports first, depth first in listed order, each relative to the file that
 * names it; then the catalog's own. An import cycle is refused.
 */
/**
 * The import name of the core this runtime carries: spec/core.catalog.yaml as
 * built in (coreCatalog.ts), so a catalog needs no copy of the spec
 * (spec/README.md; docs/packages, DEC-P07).
 */
export const CORE_IMPORT = 'bdd-suite:core';

/** The core's action entries read through bdd-suite:core, each one's bindings cut to the importing catalog's own list when it has one. */
function coreEntries(importer: ValueMap): { entry: ValueMap; file: string }[] {
  const core = loadDocument(CORE_CATALOG).value as ValueMap;
  const keep = importer.has('bindings') ? new Set(strings(importer.get('bindings'))) : undefined;
  const list = core.get('actions');
  return (isList(list) ? list : []).filter(isMap).map(entry => {
    const bindings = entry.get('bindings');
    if (!keep || !isList(bindings)) return { entry, file: CORE_IMPORT };
    const cut = new Map(entry);
    cut.set('bindings', bindings.filter(b => typeof b === 'string' && keep.has(b)));
    return { entry: cut, file: CORE_IMPORT };
  });
}

function catalogEntries(file: string, text: string, reader: Reader, visiting: string[] = []): { entry: ValueMap; file: string }[] {
  if (!visiting.length) declaredIn.clear();
  const key = path.resolve(file);
  if (visiting.includes(key)) throw new SchemaError(`Catalog import cycle: ${[...visiting, key].join(' -> ')}`);
  let catalog;
  try {
    catalog = loadDocument(text);
  } catch (e) {
    throw new SchemaError(`${file} is not YAML: ${(e as Error).message}`);
  }
  const out: { entry: ValueMap; file: string }[] = [];
  const root = isMap(catalog.value) ? catalog.value : new Map<string, Value>();
  for (const raw of strings(root.get('imports'))) {
    if (raw === CORE_IMPORT) {
      out.push(...coreEntries(root));
      continue;
    }
    const imported = path.resolve(path.dirname(key), raw);
    const importedText = reader.read(imported);
    if (importedText === undefined) throw new SchemaError(`${file} imports ${raw}, which does not exist (${imported}).`);
    out.push(...catalogEntries(imported, importedText, reader, [...visiting, key]));
  }
  const list = root.get('actions');
  for (const entry of isList(list) ? list : []) if (isMap(entry)) out.push({ entry, file: key });
  return out;
}

/**
 * The schema with a corpus catalog overlay merged in by action name: a key
 * given replaces the catalog's, and a params entry replaces the one with the
 * same name or is appended (run-manifest.yaml's rule).
 */
export function withOverlay(base: Schema, overlay: Value): Schema {
  const copy: Schema = structuredClone({ ...base, actions: undefined }) as unknown as Schema;
  copy.actions = new Map([...base.actions].map(([k, a]) => [k, { ...a, bindings: [...a.bindings], params: [...a.params] }]));
  copy.document.$defs = copy.defs;
  const patches = isMap(overlay) ? overlay.get('actions') : undefined;
  for (const patch of isList(patches) ? patches : []) {
    if (!isMap(patch)) continue;
    const name = str(patch, 'name');
    if (!name) continue;
    const action = copy.actions.get(name);
    if (!action) throw new SchemaError(`The overlay patches ${name}, which the catalog does not declare.`);
    if (typeof patch.get('deprecated') === 'boolean') action.deprecated = patch.get('deprecated') as boolean;
    if (patch.has('bindings')) action.bindings = strings(patch.get('bindings'));
    if (typeof patch.get('interruptible') === 'boolean') action.interruptible = patch.get('interruptible') as boolean;
    const added = patch.get('params');
    for (const decl of isList(added) ? added : []) {
      if (!isMap(decl)) continue;
      const param = str(decl, 'name');
      if (!param) continue;
      if (!action.params.includes(param)) action.params.push(param);
      const branch = copy.defs[`step.${name}`] as { properties?: Record<string, unknown> } | undefined;
      if (!branch?.properties) continue;
      const shape: Record<string, unknown> = {};
      if (decl.has('type')) shape.type = decl.get('type');
      if (decl.has('description')) shape.description = decl.get('description');
      branch.properties[param] = shape;
    }
  }
  return copy;
}
