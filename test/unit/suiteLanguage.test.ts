// The BDD Suite language mode's pure parts: semantic tokens, schema findings,
// and the step context key completion reads.
import * as assert from 'assert';
import { test } from 'node:test';
import { keyPrefix, stepAtColumn } from '../../src/core/completionContext';
import { checkAgainstSchema, compileSuiteSchema } from '../../src/core/schemaCheck';
import { ActionStatus, suiteTokens, TokenContext } from '../../src/core/suiteTokens';

const SUITE = `suite: s
imports: [lib.yml]
tests:
  - name: c
    steps:
      - given: a greeting
        action: demo.greet
        name: world
        nmae: typo
        captureAs: greeting
      - when: counted
        action: demo.count
        to: 3
      - then: ordered
        meta: place-order
        with: { item: book, note: n, colour: red }
      - and: unknown meta
        meta: nowhere
        with: { x: 1 }
      - action: no.such
        anything: 1
      - action: { not: a scalar }
      - meta: place-order
        with: [listed]
metaSteps:
  - name: inner
    steps:
      - action: demo.greet
        name: x
beforeEach:
  - given: a hook
    why: hooks are steps too
    action: demo.count
    timeoutSec: 5
afterEach: not a list
cases:
  asserts:
    - var: greeting.items.0
      equals: hi
    - isTrue: true
      var: "nope.x"
    - var: bad-path!
      count: 2
    - var: 3
    - equals: \${capture.greeting}
    - just a string
`;

const ctx: TokenContext = {
  envelope: new Set(['given', 'when', 'then', 'and', 'captureAs', 'why', 'timeoutSec']),
  action(name) {
    const status: Record<string, ActionStatus> = { 'demo.greet': 'implemented', 'demo.count': 'notInTarget' };
    if (!status[name]) return { status: 'undeclared' };
    return { status: status[name], params: name === 'demo.greet' ? [{ name: 'name', required: true }] : [{ name: 'to', required: false }] };
  },
  meta: name => (name === 'place-order' ? [{ name: 'item', required: true }, { name: 'note', required: false }] : undefined),
  subject: (_pos, path) => path.map((s, i) => (s === 'nope' ? 'unknown' : i === 2 ? 'open' : 'known')),
};

test('suiteTokens: actions by status, keys by who declares them, meta steps and their with: keys, in every step list', () => {
  const tokens = suiteTokens(SUITE, ctx).map(t => `${t.line + 1}:${t.character + 1} ${SUITE.split('\n')[t.line].slice(t.character, t.character + t.length)} ${t.type}${t.modifiers.length ? `.${t.modifiers.join('.')}` : ''}`);
  // given/when/then/and, why and captureAs are the grammar's to colour: no property token paints over them.
  // Every other value is typed; prose (the Gherkin sentences, why) and ${...} expressions are left to the grammar.
  assert.deepStrictEqual(tokens, [
    '1:8 s string',
    '2:11 lib.yml string',
    '4:11 c string',
    '7:17 demo.greet action.implemented',
    '8:9 name parameter.required',
    '8:15 world string',
    '9:9 nmae parameter.unknown',
    '9:15 typo string',
    '10:20 greeting variable.declaration',
    '12:17 demo.count action.notInTarget',
    '13:9 to parameter',
    '13:13 3 number',
    '15:15 place-order metaStep',
    '16:17 item parameter.required',
    '16:23 book string',
    '16:29 note parameter',
    '16:35 n string',
    '16:38 colour parameter.unknown',
    '16:46 red string',
    '18:15 nowhere metaStep.undeclared',
    '19:17 x parameter',
    '19:20 1 number',
    '20:17 no.such action.undeclared',
    '21:9 anything parameter',
    '21:19 1 number',
    '22:24 a scalar string',
    '23:15 place-order metaStep',
    '24:16 listed string',
    '26:11 inner string',
    '28:17 demo.greet action.implemented',
    '29:9 name parameter.required',
    '29:15 x string',
    '33:13 demo.count action.notInTarget',
    '34:5 timeoutSec property',
    '34:17 5 number',
    '35:12 not a list string',
    '38:12 greeting variable',
    '38:21 items field',
    '38:27 0 field',
    '39:15 hi string',
    '40:15 true keyword',
    '41:13 nope variable.unknown',
    '41:18 x field',
    '42:12 bad-path! string',
    '43:14 2 number',
    '44:12 3 number',
    '46:7 just a string string',
  ]);
});

test('suiteTokens: an assertion subject is all known without a subject context; null is a keyword', () => {
  const text = 'asserts:\n  - var: a.b\n    isNull: null\n';
  const { subject: _, ...plain } = ctx;
  const tokens = suiteTokens(text, plain).map(t => `${t.type}${t.modifiers.length ? `.${t.modifiers.join('.')}` : ''}`);
  assert.deepStrictEqual(tokens, ['variable', 'field', 'keyword']);
});

test('suiteTokens: a document that is not a mapping has only values, and a multi-line value is skipped', () => {
  assert.deepStrictEqual(suiteTokens('- just\n- a list\n', ctx).map(t => t.type), ['string', 'string']);
  const complexKey = 'tests:\n  - name: c\n    steps:\n      - action: demo.count\n        ? [a, b]\n        : value\n';
  assert.deepStrictEqual(suiteTokens(complexKey, ctx).map(t => t.type), ['string', 'action', 'string'], 'a key that is not a scalar gets no token');
  const multi = 'tests:\n  - name: c\n    steps:\n      - action: "demo.\n          greet"\n';
  assert.deepStrictEqual(suiteTokens(multi, ctx).map(t => t.type), ['string'], 'only name: c; the action spans two lines');
});

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    tests: { type: 'array', items: { $ref: '#/$defs/step' } },
    level: { enum: ['a', 'b'] },
    many: { enum: Array.from({ length: 15 }, (_, i) => `v${i}`) },
    'a/b': { type: 'object', properties: { inner: { type: 'integer' } } },
    short: { type: 'string', maxLength: 2 },
  },
  $defs: {
    step: {
      type: 'object',
      allOf: [{ if: { properties: { action: { const: 'demo.count' } }, required: ['action'] }, then: { $ref: '#/$defs/step.demo.count' } }],
    },
    'step.demo.count': {
      type: 'object', additionalProperties: false, required: ['action', 'to'],
      properties: { action: { const: 'demo.count' }, to: { anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^\\$\\{[^}]+\\}$' }] }, when: { type: 'string' } },
    },
  },
};

test('checkAgainstSchema: missing, unexpected and wrongly typed keys at the key or value, the schema\'s branching left out', () => {
  const compiled = compileSuiteSchema(SCHEMA);
  assert.ok('validate' in compiled);
  const text = [
    'tests:',
    '  - action: demo.count',
    '    when: x',
    '  - action: demo.count',
    '    to: three',
    '    extra: 1',
    'level: c',
    'many: x',
    'a/b: { inner: no }',
    'short: long',
  ].join('\n');
  const found = checkAgainstSchema(text, compiled.validate).map(f => `${f.range.start.line + 1}:${f.range.start.character + 1} ${f.message}`);
  assert.deepStrictEqual(found, [
    '2:5 Missing required property "to".',
    '5:9 Incorrect type: expected integer or a ${...} expression.',
    '6:5 Property "extra" is not allowed here.',
    '7:8 Value is not accepted. Valid values: a, b.',
    '8:7 Value is not accepted. Valid values: v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, ....',
    '9:15 Incorrect type: expected integer.',
    '10:8 /short must NOT have more than 2 characters.',
  ]);
});

test('checkAgainstSchema: broken YAML is one finding; a root that fails is reported at the start; a duplicate is reported once', () => {
  const compiled = compileSuiteSchema(SCHEMA);
  assert.ok('validate' in compiled);
  assert.match(checkAgainstSchema('a: [1', compiled.validate)[0].message, /^Not valid YAML: /);
  const rootType = compileSuiteSchema({ type: 'object', required: ['x'] });
  assert.ok('validate' in rootType);
  assert.deepStrictEqual(checkAgainstSchema('- 1\n', rootType.validate).map(f => f.message), ['Incorrect type: expected object.']);
  assert.deepStrictEqual(checkAgainstSchema('{}\n', rootType.validate).map(f => [f.message, f.range.start.line]), [['Missing required property "x".', 0]],
    'an empty map has no first key; the map itself is the position');
  const anyOfOther = compileSuiteSchema({ type: 'object', properties: { v: { anyOf: [{ type: 'integer' }, { const: 5 }] } } });
  assert.ok('validate' in anyOfOther);
  assert.deepStrictEqual(checkAgainstSchema('v: x\n', anyOfOther.validate).map(f => f.message), ['Incorrect type: expected integer or another shape.']);
  const noAnyOf = compileSuiteSchema({ type: 'object', properties: { v: { not: { type: 'string' }, anyOf: undefined } } });
  assert.ok('validate' in noAnyOf);
  assert.deepStrictEqual(checkAgainstSchema('v: x\nv2: y\n', noAnyOf.validate).map(f => f.message), ['/v must NOT be valid.']);
  const twice = compileSuiteSchema({
    type: 'object', minProperties: 3, allOf: [{ required: ['x'] }, { required: ['x'] }],
    properties: { a: { type: 'integer' }, b: { type: 'integer' } },
  });
  assert.ok('validate' in twice);
  assert.deepStrictEqual(checkAgainstSchema('{ b: no, a: no }\n', twice.validate).map(f => `${f.range.start.character} ${f.message}`), [
    '0 The document must NOT have fewer than 3 properties.',
    '2 Missing required property "x".',
    '5 Incorrect type: expected integer.',
    '12 Incorrect type: expected integer.',
  ], 'the same finding twice is reported once; on one line, by column');
  assert.deepStrictEqual(checkAgainstSchema('x: 1\na: 2\nb: 3\n', twice.validate), [], 'a valid document has no findings');
});

test('compileSuiteSchema: a schema that does not compile gives its message', () => {
  const r = compileSuiteSchema({ type: 'nonsense' });
  assert.ok('error' in r && r.error.length > 0);
});

test('stepAtColumn and keyPrefix: the step around a new key line, with its values, and whether it is a list item', () => {
  const lines = ['steps:', '  - given: g', '    action: demo.count', '    ', '    to: 3', '  - when: next'];
  assert.deepStrictEqual(stepAtColumn(lines, 3, 4), { keys: new Map([['given', 'g'], ['action', 'demo.count'], ['to', '3']]), item: true });
  assert.deepStrictEqual(stepAtColumn(['suite: s', '  '], 1, 0), { keys: new Map([['suite', 's']]), item: false }, 'top-level keys are not a step');
  assert.deepStrictEqual(keyPrefix('    na'), { column: 4, typed: 'na' });
  assert.deepStrictEqual(keyPrefix('    '), { column: 4, typed: '' });
  assert.strictEqual(keyPrefix('    name: x'), undefined);
  assert.strictEqual(keyPrefix('na'), undefined, 'a key at the margin is not inside a step');
});
