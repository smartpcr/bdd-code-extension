// The action catalog, parsed with positions (plan B1.2). Never throws: a
// problem is a CoreError on the result.
import { isMap, isScalar, isSeq, Node } from 'yaml';
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
