// Schema validation for the BDD Suite language mode: the editor's text checked
// against the workspace's generated suite.schema.json while it is typed. The
// YAML extension does this for files in YAML mode; it does not serve other
// language modes, so the suite handler does it itself. Findings carry the
// extension's own code (BDD060), never an E/W code (INV-2).
import Ajv2020, { ErrorObject, ValidateFunction } from 'ajv/dist/2020';
import { isMap, isScalar, Node, Pair, YAMLMap } from 'yaml';
import { Range } from './text';
import { parseYaml } from './yamlPositions';

export interface SchemaFinding {
  range: Range;
  message: string;
}

/** A compiled suite schema; the compile error's message when it does not compile. */
export function compileSuiteSchema(schema: unknown): { validate: ValidateFunction } | { error: string } {
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false, verbose: true });
    return { validate: ajv.compile(schema as object) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const unescape = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');

/** The node at a JSON pointer, walking maps by key and sequences by index. */
function nodeAt(root: unknown, pointer: string): unknown {
  let node = root;
  for (const raw of pointer.split('/').slice(1)) {
    const segment = unescape(raw);
    if (isMap(node)) node = ((node as YAMLMap).items as Pair[]).find(p => isScalar(p.key) && String(p.key.value) === segment)?.value;
    else node = (node as { items?: unknown[] } | undefined)?.items?.[Number(segment)];
  }
  return node;
}

function typesOf(schema: unknown): string {
  const alternatives = (schema as { anyOf: { type?: string; pattern?: string }[] }).anyOf
    .map(a => (a.pattern?.startsWith('^\\$\\{') ? 'a ${...} expression' : a.type ?? 'another shape'));
  return alternatives.join(' or ');
}

/**
 * The schema findings for `text`, at the key or value each concerns: a
 * missing property at the object's first key, an unexpected one at its own key,
 * a wrong type at the value. The schema's internal branching (`if`, the inner
 * errors of an `anyOf`) is not reported, only what the author can fix.
 */
export function checkAgainstSchema(text: string, validate: ValidateFunction): SchemaFinding[] {
  const parsed = parseYaml(text);
  if (parsed.error) return [{ range: parsed.error.range, message: `Not valid YAML: ${parsed.error.message}` }];
  validate(parsed.doc.toJS());
  const errors = (validate.errors ?? []) as ErrorObject[];
  const out: SchemaFinding[] = [];
  const seen = new Set<string>();
  const root = parsed.doc.contents;
  for (const e of errors) {
    if (e.keyword === 'if' || e.schemaPath.includes('/anyOf/')) continue;
    const node = nodeAt(root, e.instancePath) as Node | undefined;
    let target: unknown = node;
    let message: string;
    if (e.keyword === 'required') {
      message = `Missing required property "${(e.params as { missingProperty: string }).missingProperty}".`;
      // The object's first key, so the mark sits on the step; an empty object marks itself.
      target = ((node as YAMLMap).items[0] as Pair | undefined)?.key ?? node;
    } else if (e.keyword === 'additionalProperties') {
      const name = (e.params as { additionalProperty: string }).additionalProperty;
      message = `Property "${name}" is not allowed here.`;
      target = ((node as YAMLMap).items as Pair[]).find(p => isScalar(p.key) && String(p.key.value) === name)?.key;
    } else if (e.keyword === 'type') {
      message = `Incorrect type: expected ${(e.params as { type: string }).type}.`;
    } else if (e.keyword === 'anyOf') {
      message = `Incorrect type: expected ${typesOf(e.parentSchema)}.`;
    } else if (e.keyword === 'enum') {
      const allowed = (e.params as { allowedValues: unknown[] }).allowedValues.map(String);
      message = `Value is not accepted. Valid values: ${allowed.slice(0, 12).join(', ')}${allowed.length > 12 ? ', ...' : ''}.`;
    } else {
      message = `${e.instancePath || 'The document'} ${e.message}.`;
    }
    const range = parsed.range(target as Node | undefined);
    const key = `${range.start.line}:${range.start.character}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ range, message });
  }
  return out.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}
