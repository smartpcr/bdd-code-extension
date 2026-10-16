// The action catalog, parsed with positions (plan B1.2). Never throws: a
// problem is a CoreError on the result.
import * as path from 'path';
import { isMap, isScalar, isSeq, Node } from 'yaml';
import { fileKey } from './paths';
import { Range } from './text';
import { CaptureShape, Catalog, CatalogAction, CatalogParam, CoreError } from './types';
import { itemsOf, ParsedYaml, parseYaml, stringItems, stringOf, valueOf } from './yamlPositions';

function plain(node: unknown): unknown {
  return node && typeof (node as Node).toJSON === 'function' ? (node as Node).toJSON() : undefined;
}

export function parseShape(node: unknown): CaptureShape {
  const shape: CaptureShape = { open: false, properties: new Map() };
  if (!isMap(node)) return shape;
  shape.type = stringOf(node, 'type');
  const additional = valueOf(node, 'additionalProperties');
  shape.open = isScalar(additional) && additional.value === true;
  const props = valueOf(node, 'properties');
  if (isMap(props)) {
    for (const pair of props.items) {
      if (isScalar(pair.key)) shape.properties.set(String(pair.key.value), parseShape(pair.value));
    }
  }
  const items = valueOf(node, 'items');
  if (items) shape.items = parseShape(items);
  return shape;
}

function parseParams(node: unknown, y: ParsedYaml): CatalogParam[] {
  const out: CatalogParam[] = [];
  if (!isSeq(node)) return out;
  for (const item of node.items) {
    const name = stringOf(item, 'name');
    if (name === undefined) continue;
    const required = valueOf(item, 'required');
    out.push({
      name,
      type: stringOf(item, 'type'),
      required: isScalar(required) ? required.value === true : undefined,
      default: plain(valueOf(item, 'default')),
      description: stringOf(item, 'description'),
      range: y.range(item as Node),
    });
  }
  return out;
}

export function parseCatalog(text: string, file: string): Catalog {
  const y = parseYaml(text);
  const catalog: Catalog = { file, bindings: [], actions: new Map(), errors: [] };
  const err = (code: string, message: string, range = y.range(undefined)): void => {
    catalog.errors.push({ code, message, range } satisfies CoreError);
  };
  if (y.error) {
    err('BDD022', `The catalog is not valid YAML: ${y.error.message}`, y.error.range);
    return catalog;
  }
  const root = y.doc.contents;
  catalog.bindings = stringItems(valueOf(root, 'bindings'));
  catalog.ownBindings = [...catalog.bindings];
  for (const item of itemsOf(root, 'actions')) {
    const nameNode = valueOf(item, 'name');
    const name = stringOf(item, 'name');
    if (!nameNode || name === undefined) {
      err('BDD021', 'A catalog entry has no name.', y.range(item as Node));
      continue;
    }
    if (catalog.actions.has(name)) {
      err('BDD020', `Duplicate catalog entry ${name}; the first one is used.`, y.range(nameNode));
      continue;
    }
    const bindingsNode = valueOf(item, 'bindings');
    const interruptible = valueOf(item, 'interruptible');
    const deprecated = valueOf(item, 'deprecated');
    const action: CatalogAction = {
      name,
      nameRange: y.range(nameNode),
      entryRange: y.range(item as Node),
      summary: stringOf(item, 'summary') ?? '',
      notes: stringOf(item, 'notes'),
      deprecated: isScalar(deprecated) ? deprecated.value === true : undefined,
      bindings: stringItems(bindingsNode),
      bindingsRange: bindingsNode ? y.range(bindingsNode) : undefined,
      interruptible: !(isScalar(interruptible) && interruptible.value === false),
      params: parseParams(valueOf(item, 'params'), y),
      captures: parseShape(valueOf(item, 'captures')),
    };
    catalog.actions.set(name, action);
  }
  return catalog;
}

/**
 * A workspace catalog with everything it imports (DEC-S10): the imported
 * catalogs' actions first, depth first in listed order and each import
 * relative to the file naming it, then the catalog's own. Each imported
 * action keeps its own file and ranges, so navigation opens where it is
 * declared. A name declared twice, an import cycle, a missing or broken import
 * is an error at the root catalog's import that leads to it; the first
 * declaration is used. Never throws.
 */
export function resolveCatalog(text: string, file: string, read: (file: string) => string | undefined): Catalog {
  const catalog = parseCatalog(text, file);
  const own = catalog.actions;
  catalog.actions = new Map();
  catalog.imports = [];
  const declaredIn = new Map<string, string>();
  const add = (action: CatalogAction, from: string, range: Range): void => {
    const first = declaredIn.get(action.name);
    if (first !== undefined) {
      catalog.errors.push({ code: 'BDD020', message: `${action.name} is declared in both ${first} and ${from}; the first is used.`, range });
      return;
    }
    declaredIn.set(action.name, from);
    catalog.actions.set(action.name, from === fileKey(file) ? action : { ...action, file: from });
  };
  const visit = (rel: string, fromFile: string, range: Range, chain: string[]): void => {
    const target = fileKey(path.resolve(path.dirname(fromFile), rel));
    if (chain.includes(target)) {
      catalog.errors.push({ code: 'BDD023', message: `Catalog import cycle: ${[...chain, target].join(' -> ')}`, range });
      return;
    }
    if (catalog.imports!.includes(target)) return;
    const importedText = read(target);
    if (importedText === undefined) {
      catalog.errors.push({ code: 'BDD024', message: `Imported catalog ${rel} does not exist (${target}).`, range });
      return;
    }
    const imported = parseCatalog(importedText, target);
    for (const e of imported.errors) catalog.errors.push({ ...e, message: `${rel}: ${e.message}`, range });
    for (const next of importsOf(importedText)) visit(next.value, target, range, [...chain, target]);
    catalog.imports!.push(target);
    for (const b of imported.bindings) if (!catalog.bindings.includes(b)) catalog.bindings.push(b);
    for (const a of imported.actions.values()) add(a, target, range);
  };
  for (const entry of importsOf(text)) visit(entry.value, file, entry.range, [fileKey(file)]);
  for (const a of own.values()) add(a, fileKey(file), a.nameRange);
  return catalog;
}

/** A catalog's `imports` entries, each with its range. */
function importsOf(text: string): { value: string; range: Range }[] {
  const y = parseYaml(text);
  if (y.error) return [];
  return itemsOf(y.doc.contents, 'imports').filter(isScalar).map(n => ({ value: String(n.value), range: y.range(n as Node) }));
}

/** Dotted paths of a capture shape, to `depth` levels; an open level ends with `*`. */
export function flattenShape(shape: CaptureShape, depth = 3, prefix = ''): string[] {
  const out: string[] = [];
  if (shape.open) out.push(prefix ? `${prefix}.*` : '*');
  if (depth === 0) return out;
  for (const [key, child] of shape.properties) {
    const p = prefix ? `${prefix}.${key}` : key;
    out.push(child.type ? `${p}: ${child.type}` : p);
    out.push(...flattenShape(child, depth - 1, p));
  }
  if (shape.items) out.push(...flattenShape(shape.items, depth - 1, prefix ? `${prefix}.0` : '0'));
  return out;
}
