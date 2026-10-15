// A small stand-in for Build-Schema.ps1: generates suite.schema.json from the
// catalog the way os-context does, with one branch per action, so each step's
// parameters are checked against its own action only. The extension reads it
// beside the catalog while you type, and so:
//   * a step missing a required parameter (demo.greet without `name`) is underlined,
//   * a parameter the action does not take, or of the wrong type, is underlined,
//   * typing in a step offers that action's parameters, with their descriptions,
//   * typing `action: ` offers the catalog's action names.
// Run from the workspace root: node tools/gen-schema.mjs
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readCatalog, SCHEMA_DIR, stepEnvelope } from './catalog.mjs';

const { actions } = readCatalog();
const envelope = stepEnvelope();
const common = Object.fromEntries(Object.entries(envelope).filter(([k]) => k !== 'action' && k !== 'meta'));
const JSON_TYPES = { string: 'string', integer: 'integer', number: 'number', boolean: 'boolean', array: 'array', object: 'object' };
const expression = { type: 'string', pattern: '^\\$\\{[^}]+\\}$', description: 'A ${...} expression, resolved when the step runs.' };

/** A parameter's schema: its declared type, or a ${...} expression that yields it at run time. */
function paramSchema(p) {
  const t = JSON_TYPES[p.type];
  const typed = t ? { type: t } : {};
  const schema = t && t !== 'string' ? { anyOf: [typed, expression] } : typed;
  return { ...schema, description: `${p.required ? '(required) ' : ''}${p.description ?? ''}`.trim() || undefined };
}

const defs = {
  case: {
    type: 'object', additionalProperties: false, required: ['name', 'steps'],
    properties: {
      name: { type: 'string', description: 'The case name, unique in the suite.' },
      tags: { type: 'array', items: { type: 'string' } },
      steps: { type: 'array', items: { $ref: '#/$defs/step' } },
    },
  },
  metaStep: {
    type: 'object', additionalProperties: false, required: ['name', 'steps'],
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      params: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, required: { type: 'boolean' }, default: {} } } },
      exports: { type: 'array', items: { type: 'string' } },
      steps: { type: 'array', items: { $ref: '#/$defs/step' } },
    },
  },
  step: {
    description: 'One step: an action with its parameters, or a meta step use.',
    type: 'object',
    properties: {
      action: { enum: [...actions.keys()], description: 'The action this step runs, from the catalog.' },
      meta: { type: 'string', description: 'A meta step declared here or in an imported library.' },
    },
    allOf: [
      { if: { required: ['meta'] }, then: { $ref: '#/$defs/step.meta' } },
      ...[...actions.keys()].map(name => ({ if: { properties: { action: { const: name } }, required: ['action'] }, then: { $ref: `#/$defs/step.${name}` } })),
    ],
  },
  'step.meta': {
    type: 'object', additionalProperties: false, required: ['meta'],
    properties: { meta: { type: 'string' }, with: { type: 'object', description: 'Values for the meta step\'s parameters.' }, ...common },
  },
};
for (const a of actions.values()) {
  defs[`step.${a.name}`] = {
    description: a.summary,
    type: 'object',
    additionalProperties: false,
    required: ['action', ...a.params.filter(p => p.required).map(p => p.name)],
    properties: {
      action: { const: a.name, description: a.summary },
      ...common,
      ...Object.fromEntries(a.params.map(p => [p.name, paramSchema(p)])),
    },
  };
}

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Demo suite (generated from actions.catalog.yaml by tools/gen-schema.mjs)',
  type: 'object',
  additionalProperties: false,
  properties: {
    suite: { type: 'string', description: 'The suite name.' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    imports: { type: 'array', items: { type: 'string' }, description: 'Libraries whose meta steps this suite uses, relative to this file.' },
    metaSteps: { type: 'array', items: { $ref: '#/$defs/metaStep' } },
    tests: { type: 'array', items: { $ref: '#/$defs/case' } },
  },
  $defs: defs,
};
fs.writeFileSync(path.join(SCHEMA_DIR, 'suite.schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
console.log(`suite.schema.json regenerated: ${actions.size} actions (${[...actions.keys()].join(', ')})`);
