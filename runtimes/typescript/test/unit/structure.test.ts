// schema.ts, validate/structure.ts and validate/index.ts on the real schema
// and small fixtures: one test per error mapping and per refusal.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadDocument } from '../../src/model.js';
import { corpusSchema, repo } from '../where.js';
import { overlayReader } from '../../src/reader.js';
import { loadSchema, SchemaError, withOverlay } from '../../src/schema.js';
import { validateFile } from '../../src/validate/index.js';

const root = repo;
const schema = loadSchema(corpusSchema);
const options = { binding: 'typescript', bindingCheck: false, params: [] as [string, string][] };

function lint(text: string, s = schema) {
  const file = path.join(root, 'scratch.yml');
  return validateFile(file, 'scratch.yml', s, options, overlayReader({ [file]: text }))
    // Structure only: the semantic and dataflow passes have their own tests.
    .filter(d => /^E1/.test(d.code))
    .map(d => `${d.code} ${d.position.line}:${d.position.column}${d.suggestion ? ` (${d.suggestion})` : ''}`);
}

test('loadSchema: the catalog\'s actions, the operators, the common keys, step replaced by the envelope', () => {
  // The core's six and the corpus's eight fixture actions, the core imported (DEC-S10).
  // fixture.throw is declared only; the pending execute/worker-throws.yml is the one suite that runs it.
  assert.equal(schema.actions.size, 14);
  const set = schema.actions.get('core.set')!;
  assert.deepEqual([set.params, set.interruptible, set.deprecated, set.hasShape], [['value'], true, false, true]);
  assert.ok(schema.actionNames.every((n, i, a) => i === 0 || a[i - 1]! < n));
  assert.ok(schema.assertOperators.includes('equals') && !schema.assertOperators.includes('var'));
  assert.ok(schema.stepCommonKeys.includes('captureAs'));
  assert.equal(schema.defs.step, schema.defs.stepEnvelope);
});

test('loadSchema refuses what it cannot use', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-schema-'));
  const write = (schemaText: string | undefined, catalogText: string | undefined) => {
    for (const [f, t] of [['suite.schema.json', schemaText], ['actions.catalog.yaml', catalogText]] as const) {
      const p = path.join(dir, f);
      if (t === undefined) fs.rmSync(p, { force: true });
      else fs.writeFileSync(p, t);
    }
    return () => loadSchema(dir);
  };
  assert.throws(write(undefined, 'actions: []'), /Suite schema not found at .*suite\.schema\.json/);
  assert.throws(write('{}', undefined), /Suite schema not found at .*actions\.catalog\.yaml/);
  assert.throws(write('{', 'a: 1'), /is not JSON/);
  assert.throws(write('{}', 'a: 1'), /carries no \$defs/);
  assert.throws(write('{"$defs":{}}', 'a: 1'), /no stepEnvelope/);
  assert.throws(write('{"$defs":{"stepEnvelope":{}}}', 'a: [1'), SchemaError);
  const ok = write('{"$defs":{"stepEnvelope":{}}}', 'actions:\n  - x\n  - { summary: no name }\n  - name: a.b\n    params: [x, { name: p }, { type: string }]\n    captures: null\n')();
  assert.deepEqual([...ok.actions.values()].map(a => [a.name, a.params, a.hasShape, a.bindings]), [['a.b', ['p'], false, []]]);
  assert.deepEqual(write('{"$defs":{"stepEnvelope":{}}}', '- not a mapping\n')().actions.size, 0);
});

test('withOverlay: keys replace keys, a parameter is appended or replaced, the base is untouched', () => {
  const overlay = loadDocument(`actions:
  - name: fixture.suspend
    params:
      - { name: newParameter, type: string, description: overlay }
      - { name: node }
      - { type: string }
    bindings: [powershell, typescript]
    deprecated: true
    interruptible: false
  - x
  - { bindings: [] }
  - name: core.noop
    params: [notAMap]
`).value;
  const s = withOverlay(schema, overlay);
  const a = s.actions.get('fixture.suspend')!;
  assert.deepEqual([a.bindings, a.deprecated, a.interruptible], [['powershell', 'typescript'], true, false]);
  assert.ok(a.params.includes('newParameter'));
  assert.equal(a.params.filter(p => p === 'node').length, 1);
  assert.ok(!schema.actions.get('fixture.suspend')!.params.includes('newParameter'), 'the base is not changed');
  assert.deepEqual((s.defs['step.fixture.suspend'] as { properties: Record<string, unknown> }).properties.newParameter,
    { type: 'string', description: 'overlay' });
  assert.throws(() => withOverlay(schema, loadDocument('actions:\n  - name: no.such\n').value), /does not declare/);
  assert.equal(withOverlay(schema, null).actions.size, schema.actions.size);
  const noBranch = { ...schema, defs: { ...schema.defs, 'step.core.set': {} } };
  assert.ok(withOverlay(noBranch, loadDocument('actions:\n  - name: core.set\n    params: [{ name: extra }]\n').value).actions.get('core.set')!.params.includes('extra'));
});

test('E100 at 1:1 for a file the parser refuses and for a root that is not a mapping; an unreadable file throws', () => {
  assert.deepEqual(lint('a: [1, 2\n'), ['E100 1:1']);
  assert.deepEqual(lint('- 1\n'), ['E100 1:1']);
  assert.throws(() => validateFile(path.join(root, 'no-such.yml'), 'x', schema, options), /cannot be read/);
});

test('E101 an unknown key, with a suggestion, at the key; nested shapes name their own legal keys', () => {
  assert.deepEqual(lint('suite: s\nsuiet: x\ntests:\n  - name: c\n    steps: [{ action: core.noop }]\n'), ['E101 2:1 (Did you mean suite)']);
  assert.deepEqual(lint('suite: s\ndefaults:\n  clustr: x\ntests:\n  - name: c\n    steps: [{ action: core.noop }]\n'), ['E101 3:3 (Did you mean cluster)']);
  assert.deepEqual(lint('suite: s\ntests:\n  - name: c\n    stepz: []\n    steps: [{ action: core.noop }]\n'), ['E101 4:5 (Did you mean steps)']);
  assert.deepEqual(lint('suite: s\ntests:\n  - name: c\n    steps: [{ action: core.noop }]\n    asserts:\n      - { var: x, equalz: 1 }\n')[0], 'E101 6:19 (Did you mean equals)');
  assert.deepEqual(lint('suite: s\nmetaSteps:\n  - name: m\n    steps: [{ action: core.noop }]\n    paramz: []\ntests:\n  - name: c\n    steps: [{ action: core.noop }]\n'), ['E101 5:5 (Did you mean params)']);
  assert.deepEqual(lint('suite: s\nmetaSteps:\n  - name: m\n    steps: [{ action: core.noop }]\n    params:\n      - { name: p, tipe: string }\ntests:\n  - name: c\n    steps: [{ action: core.noop }]\n'), ['E101 6:20 (Did you mean type)']);
  assert.deepEqual(lint('suite: s\nparams:\n  - { name: p, defualt: 1 }\ntests:\n  - name: c\n    steps: [{ action: core.noop }]\n'), ['E101 3:16 (Did you mean default)']);
});

test('E102 a missing required key at its parent\'s key, and a step with neither action nor meta', () => {
  assert.deepEqual(lint('tests:\n  - name: c\n    steps: [{ action: core.noop }]\n'), ['E102 1:1']);
  assert.deepEqual(lint('suite: s\ntests:\n  - steps:\n      - given: nothing to do\n'), ['E102 3:5', 'E102 4:9']);
});

test('E103 a refused value at the value, a step that is not a mapping, and E104 an unknown action', () => {
  assert.deepEqual(lint('suite: s\nsetupTimeoutSec: soon\ntests:\n  - name: c\n    steps: [{ action: core.noop }]\n'), ['E103 2:18']);
  assert.deepEqual(lint('suite: s\ntests:\n  - name: c\n    steps:\n      - just-text\n'), ['E103 5:9', 'E103 5:9']);
  assert.deepEqual(lint('suite: s\ntests:\n  - name: c\n    steps:\n      - action: fixture.suspned\n'), ['E104 5:17 (Did you mean fixture.suspend)']);
  assert.deepEqual(lint('suite: s\ntests:\n  - name: c\n    steps:\n      - action: totally.unknown.thing\n'),
    ['E104 5:17 (No action of that name is declared in actions.catalog.yaml.)']);
});

test('E105 a parameter the action does not take, inside the step; meta steps take only their own keys (a tie goes to the name that sorts first)', () => {
  assert.deepEqual(lint('suite: s\ntests:\n  - name: c\n    steps:\n      - action: core.set\n        value: 1\n        valu: 2\n'), ['E105 7:9 (Did you mean value)']);
  assert.deepEqual(lint('suite: s\ntests:\n  - name: c\n    steps:\n      - meta: m\n        wiht: {}\n'), ['E101 6:9 (Did you mean why)']);
  assert.deepEqual(lint('suite: s\ntests:\n  - name: c\n    steps:\n      - action: core.set\n'), ['E102 5:9']);
});

test('the mappings a combinator or a false schema produces: summaries skipped, leaves kept', () => {
  const defs = { stepEnvelope: {} };
  const synthetic = {
    ...schema, defs,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', $defs: defs,
      properties: {
        any: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        one: { oneOf: [{ type: 'integer' }, { type: 'number' }] },
        cond: { if: { type: 'string' }, then: { minLength: 3 } },
        gone: false,
      },
    },
  };
  assert.deepEqual(lint('any: []\none: 1\ncond: ab\ngone: 1\n', synthetic), ['E103 1:6', 'E103 1:6', 'E103 2:6', 'E103 3:7', 'E101 4:1 (Did you mean gone)'], 'a key the schema forbids by name is still one it lists, as in Go');
});
