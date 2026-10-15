// E100-E105: what the schema refuses, at the place the corpus names.
//
// Two passes, as in every binding. The whole document is checked against the
// schema with $defs.step replaced by what all steps share, and each step is
// then checked against its own action's branch. A generated union of every
// action would report every branch it did not take; this way one step is
// never checked against another action's parameters.
import { createRequire } from 'node:module';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { Diagnostic, error } from '../diag.js';
import { at, Document, escape } from '../model.js';
import { Schema } from '../schema.js';
import { nearest } from '../spelling.js';
import { allSteps, StepEntry, stepLists, textOf } from '../walk.js';
import { isMap, toPlain } from '../value.js';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js') as typeof import('ajv/dist/2020.js').default;

type Failure =
  | { kind: 'required'; pointer: string; name: string }
  | { kind: 'unexpected'; pointer: string; name: string }
  | { kind: 'refused'; pointer: string; message: string };

const pointerName = (pointer: string) => (pointer ? `the suite at ${pointer}` : 'the suite');

/** One Ajv per loaded schema: the document's validator and each step branch compile once. */
interface Compiled {
  document: ValidateFunction;
  branches: Map<string, ValidateFunction>;
  ajv: InstanceType<typeof Ajv2020>;
}
const cache = new WeakMap<Schema, Compiled>();

function compiledFor(schema: Schema): Compiled {
  let c = cache.get(schema);
  if (!c) {
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    ajv.addSchema({ $id: 'suite-defs', $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: schema.defs });
    c = { document: ajv.compile(schema.document), branches: new Map(), ajv };
    cache.set(schema, c);
  }
  return c;
}

/** The validator of one step branch: `step.<action>` or `step.meta`. */
function branch(schema: Schema, name: string): ValidateFunction {
  const c = compiledFor(schema);
  let v = c.branches.get(name);
  if (!v) {
    v = c.ajv.compile({ $ref: `suite-defs#/$defs/${escape(name)}` });
    c.branches.set(name, v);
  }
  return v;
}

const unescape = (segment: string) => segment.replace(/~1/g, '/').replace(/~0/g, '~');

/** The leaf failures, in the order the schema reports them; a combinator's own summary is not one. */
function failures(validate: ValidateFunction, instance: unknown): Failure[] {
  if (validate(instance)) return [];
  const out: Failure[] = [];
  for (const e of validate.errors as ErrorObject[]) {
    const pointer = e.instancePath;
    switch (e.keyword) {
      case 'if':
      case 'anyOf':
        continue;
      case 'oneOf':
        if (!(e.params as { passingSchemas?: unknown }).passingSchemas) continue;
        break;
      case 'required':
        out.push({ kind: 'required', pointer, name: (e.params as { missingProperty: string }).missingProperty });
        continue;
      case 'additionalProperties':
      case 'unevaluatedProperties': {
        const p = e.params as { additionalProperty?: string; unevaluatedProperty?: string };
        const name = p.additionalProperty ?? p.unevaluatedProperty ?? '';
        out.push({ kind: 'unexpected', pointer: `${pointer}/${escape(name)}`, name });
        continue;
      }
      case 'false schema':
        out.push({ kind: 'unexpected', pointer, name: unescape(pointer.slice(pointer.lastIndexOf('/') + 1)) });
        continue;
    }
    out.push({ kind: 'refused', pointer, message: `${e.message ?? e.keyword}`.replace(/\s+/g, ' ') });
  }
  return out;
}

const isShaped = (pointer: string, ...shape: string[]): boolean => {
  if (!pointer) return false;
  const segments = pointer.split('/').slice(1);
  return segments.length === shape.length && shape.every((s, i) => (s === '#' ? /^[0-9]+$/.test(segments[i]!) : segments[i] === s));
};

const keysOf = (definition: unknown): string[] => {
  const props = (definition as { properties?: unknown } | undefined)?.properties;
  return props && typeof props === 'object' ? Object.keys(props).sort() : [];
};

/** The keys legal where an unexpected one was found, and the action whose parameter it would be. */
function legalKeys(parent: string, schema: Schema, step: StepEntry | undefined): { action: string; keys: string[] } {
  if (step) {
    const name = textOf(step.step, 'action');
    const declared = schema.actions.get(name);
    if (declared) return { action: name, keys: [...schema.stepCommonKeys, ...declared.params] };
    return { action: '', keys: keysOf(schema.defs['step.meta']) };
  }
  const d = schema.defs;
  let definition: unknown;
  if (parent === '') definition = schema.document;
  else if (parent === '/defaults') definition = d.defaults;
  else if (isShaped(parent, 'tests', '#')) definition = d.case;
  else if (isShaped(parent, 'tests', '#', 'asserts', '#')) definition = d.assert;
  else if (isShaped(parent, 'metaSteps', '#')) definition = d.metaStep;
  else if (isShaped(parent, 'metaSteps', '#', 'params', '#')) definition = d.metaParamDecl;
  else if (/[0-9]$/.test(parent) && parent.includes('params/')) definition = d.paramDecl;
  return { action: '', keys: keysOf(definition) };
}

function toDiagnostic(f: Failure, doc: Document, file: string, schema: Schema, step?: StepEntry): Diagnostic {
  if (f.kind === 'required') {
    return error('E102', file, at(doc, f.pointer).key, `Required key ${f.name} is missing from ${pointerName(f.pointer)}.`);
  }
  if (f.kind === 'unexpected') {
    const parent = f.pointer.slice(0, f.pointer.lastIndexOf('/'));
    const { action, keys } = legalKeys(parent, schema, step);
    const suggestion = nearest(f.name, keys, 2);
    const position = at(doc, f.pointer).key;
    const hint = suggestion ? `Did you mean ${suggestion}` : undefined;
    return action
      ? error('E105', file, position, `Action ${action} takes no parameter ${f.name}.`, hint)
      : error('E101', file, position, `Unknown key ${f.name} in ${pointerName(parent)}.`, hint);
  }
  return error('E103', file, at(doc, f.pointer).value, `${pointerName(f.pointer)} has a value the schema refuses: ${f.message}.`);
}

/** E101-E105 for one loaded document whose root is a mapping. */
export function checkStructure(doc: Document, file: string, schema: Schema): Diagnostic[] {
  const found: Diagnostic[] = [];
  const suite = isMap(doc.value) ? doc.value : undefined;
  for (const f of failures(compiledFor(schema).document, toPlain(doc.value))) found.push(toDiagnostic(f, doc, file, schema));

  const checked: { entry: StepEntry; branch: string }[] = [];
  for (const entry of allSteps(suite)) {
    const action = textOf(entry.step, 'action');
    if (action) {
      if (!schema.actions.has(action)) {
        const suggestion = nearest(action, schema.actionNames, 3);
        found.push(error('E104', file, at(doc, `${entry.pointer}/action`).value, `Unknown action ${action}.`,
          suggestion ? `Did you mean ${suggestion}` : 'No action of that name is declared in actions.catalog.yaml.'));
        continue;
      }
      checked.push({ entry, branch: `step.${action}` });
    } else if (entry.step.get('meta') !== undefined && entry.step.get('meta') !== null) {
      checked.push({ entry, branch: 'step.meta' });
    } else {
      found.push(error('E102', file, at(doc, entry.pointer).key, 'A step declares no action and no meta. One of the two is required.'));
    }
  }
  // A step list entry that is not a mapping cannot be a step.
  for (const list of stepLists(suite)) {
    list.steps.forEach((raw, index) => {
      if (raw === null || isMap(raw)) return;
      found.push(error('E103', file, at(doc, `${list.pointer}/${index}`).value, 'A step must be a mapping with an action.'));
    });
  }
  // Each step against its own action's branch, its findings moved under the step's pointer.
  for (const { entry, branch: name } of checked) {
    for (const f of failures(branch(schema, name), toPlain(entry.step))) {
      found.push(toDiagnostic({ ...f, pointer: entry.pointer + f.pointer }, doc, file, schema, entry));
    }
  }
  return found;
}
