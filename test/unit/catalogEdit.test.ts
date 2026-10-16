// B5.1: the catalog entry, where it goes, and the catalog half of implementing.
import * as assert from 'assert';
import { test } from 'node:test';
import {
  addBindingEdit, commonStepKeys, eolOf, findCatalogInsertOffset, inferType, offsetOf, planDeclare, renderCatalogEntry,
} from '../../src/core/catalogEdit';
import { parseCatalog } from '../../src/core/catalog';

const catalog = [
  'catalogVersion: 1',
  'bindings: [powershell, csharp, go, rust]',
  '',
  'actions:',
  '  - name: core.noop',
  '    summary: Do nothing.',
  '    bindings: [powershell, csharp, go, rust]',
  '    interruptible: true',
  '    captures:',
  '      type: object',
  '',
  '  - name: lifecycle.get',
  '    summary: Get.',
  '    bindings: [powershell, go]',
  '    interruptible: true',
  '    # a comment inside the entry',
  '    captures: { type: object, additionalProperties: true }',
  '',
  '  - name: core.set',
  '    summary: Set.',
  '    bindings: [go, powershell]',
  '    interruptible: true',
  '    captures: { type: any }',
  '',
].join('\n');

const apply = (text: string, edits: { start: number; end: number; text: string }[]) =>
  [...edits].sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);

test('inferType: the type table, and the values that cannot say', () => {
  const rows: [unknown, string, boolean][] = [
    ['hello', 'string', false], ['${capture.x}', 'string', true], [2, 'integer', false], [1.5, 'number', false],
    [true, 'boolean', false], [[1], 'array', false], [{ a: 1 }, 'object', false], [null, 'any', true], [undefined, 'any', true],
  ];
  for (const [value, type, todo] of rows) assert.deepStrictEqual(inferType(value), { type, todo }, String(value));
});

test('commonStepKeys reads $defs.stepEnvelope.properties, and says nothing when it cannot', () => {
  assert.deepStrictEqual(commonStepKeys('{"$defs":{"stepEnvelope":{"properties":{"action":{},"why":{}}}}}'), ['action', 'why']);
  assert.strictEqual(commonStepKeys('{"$defs":{}}'), undefined);
  assert.strictEqual(commonStepKeys('not json'), undefined);
});

test('renderCatalogEntry: two-space style, typed params, a TODO for a value that cannot say, an open capture', () => {
  assert.strictEqual(renderCatalogEntry('demo.echo', [{ name: 'text', value: 'hello' }, { name: 'times', value: 2 },
    { name: 'from', value: '${capture.a}' }, { name: 'odd key', value: true }], '\n', ['powershell']), [
    '  - name: demo.echo',
    '    summary: TODO describe demo.echo.',
    '    bindings: [powershell]',
    '    interruptible: true',
    '    params:',
    '      - { name: text, type: string }',
    '      - { name: times, type: integer }',
    '      - { name: from, type: string }  # TODO type',
    '      - { name: "odd key", type: boolean }',
    '    captures: { type: object, additionalProperties: true }',
    '',
  ].join('\n'));
  assert.ok(!renderCatalogEntry('demo.none', [], '\r\n').includes('params:'));
  assert.ok(renderCatalogEntry('demo.none', [], '\r\n').endsWith('true }\r\n'));
  assert.match(renderCatalogEntry('demo.none', []), /\n {4}bindings: \[\]\n/, 'no binding lists none');
});

test('findCatalogInsertOffset: after the family\'s last entry, else after the last, else under actions:', () => {
  const core = findCatalogInsertOffset(catalog, 'core.echo');
  assert.ok('offset' in core);
  assert.strictEqual(catalog.slice(0, core.offset).split('\n').slice(-2)[0], '    captures: { type: any }');
  const life = findCatalogInsertOffset(catalog, 'lifecycle.demo');
  assert.ok('offset' in life);
  assert.strictEqual(catalog.slice(0, life.offset).split('\n').slice(-2)[0], '    captures: { type: object, additionalProperties: true }');
  assert.strictEqual(life.prefix, '\n');
  const other = findCatalogInsertOffset(catalog, 'demo.echo');
  assert.ok('offset' in other && other.offset === (core as { offset: number }).offset);
  const empty = findCatalogInsertOffset('bindings: [powershell]\nactions:\nlater: 1\n', 'demo.echo');
  assert.deepStrictEqual(empty, { offset: 'bindings: [powershell]\nactions:\n'.length, prefix: '' });
  const noBreak = findCatalogInsertOffset('actions:', 'demo.echo');
  assert.deepStrictEqual(noBreak, { offset: 8, prefix: '\n' });
  const lastLine = findCatalogInsertOffset('actions:\n  - name: a.b\n    summary: x', 'a.c');
  assert.deepStrictEqual(lastLine, { offset: 'actions:\n  - name: a.b\n    summary: x'.length, prefix: '\n\n' });
  const nextKey = findCatalogInsertOffset('actions:\n  - name: a.b\n\nafter: 1\n  - name: a.z\n', 'a.c');
  assert.deepStrictEqual(nextKey, { offset: 'actions:\n  - name: a.b\n'.length, prefix: '\n' });
  assert.deepStrictEqual(findCatalogInsertOffset('bindings: []\n', 'a.b'), { refused: 'The catalog has no top-level `actions:` key.' });
});

const declareInput = (over: Partial<Parameters<typeof planDeclare>[0]> = {}) => ({
  catalogFile: 'C:/r/actions.catalog.yaml', catalogText: catalog, declared: (n: string) => n === 'core.noop', name: 'demo.echo',
  stepParams: [{ name: 'action', value: 'demo.echo' }, { name: 'when', value: 'x' }, { name: 'text', value: 'hello' }, { name: 'times', value: 2 }],
  commonKeys: ['action', 'given', 'when', 'then', 'and', 'why'], binding: 'powershell',
  stub: [{ file: 'C:/r/DemoEcho.ps1', start: 0, end: 0, text: 'stub\n', create: true }], ...over,
});

test('B5.1-4 planDeclare: common step keys never become parameters; the target binding\'s stub is created', () => {
  const plan = planDeclare(declareInput());
  assert.ok('edits' in plan);
  const out = apply(catalog, plan.edits.filter(e => !e.create));
  assert.match(out, /- name: demo\.echo\n {4}summary: TODO describe demo\.echo\.\n {4}bindings: \[powershell\]\n {4}interruptible: true\n {4}params:\n {6}- \{ name: text, type: string \}\n {6}- \{ name: times, type: integer \}\n {4}captures/);
  assert.ok(!/name: (action|when),/.test(out));
  assert.deepStrictEqual(plan.edits[1], { file: 'C:/r/DemoEcho.ps1', start: 0, end: 0, text: 'stub\n', create: true });
  const parsed = parseCatalog(out, 'C:/r/actions.catalog.yaml');
  assert.deepStrictEqual(parsed.errors, []);
  assert.deepStrictEqual([...parsed.actions.keys()], ['core.noop', 'lifecycle.get', 'core.set', 'demo.echo']);
});

test('planDeclare: a C# target lists csharp and carries the registry edits; no stub template lists no binding', () => {
  const registry = [{ file: 'C:/r/Ext.cs', start: 10, end: 10, text: '["demo.echo"] = Actions.DemoEcho,\n' }, { file: 'C:/r/Actions.cs', start: 5, end: 5, text: 'stub' }];
  const cs = planDeclare(declareInput({ binding: 'csharp', stub: registry }));
  assert.ok('edits' in cs);
  assert.match(apply(catalog, cs.edits.slice(0, 1)), /- name: demo\.echo\n {4}summary: [^\n]*\n {4}bindings: \[csharp\]\n/);
  assert.deepStrictEqual(cs.edits.slice(1), registry);
  const none = planDeclare(declareInput({ binding: undefined, stub: [] }));
  assert.ok('edits' in none && none.edits.length === 1);
  assert.match(apply(catalog, none.edits), /- name: demo\.echo\n {4}summary: [^\n]*\n {4}bindings: \[\]\n/);
});

test('B5.1-3 and the other refusals of planDeclare', () => {
  assert.deepStrictEqual(planDeclare(declareInput({ name: 'core.noop' })), { refused: 'core.noop is already in the catalog.' });
  assert.match((planDeclare(declareInput({ name: 'bad name' })) as { refused: string }).refused, /not an action name/);
  assert.match((planDeclare(declareInput({ commonKeys: undefined })) as { refused: string }).refused, /stepEnvelope/);
  assert.deepStrictEqual(planDeclare(declareInput({ catalogText: 'bindings: []\n' })), { refused: 'The catalog has no top-level `actions:` key.' });
});

test('addBindingEdit: the binding joins the list in the catalog\'s order; listed is no edit; no list refuses', () => {
  const parsed = parseCatalog(catalog, 'C:/r/c.yaml');
  const order = parsed.bindings;
  const set = parsed.actions.get('core.set')!;
  const edit = addBindingEdit('C:/r/c.yaml', catalog, set, 'rust', order);
  assert.ok(edit && 'start' in edit);
  assert.match(apply(catalog, [edit]), /name: core\.set\n {4}summary: Set\.\n {4}bindings: \[powershell, go, rust\]/);
  const typescript = addBindingEdit('C:/r/c.yaml', catalog, set, 'typescript', order) as { text: string };
  assert.strictEqual(typescript.text, '[powershell, go, typescript]', 'a binding the top-level list lacks goes last');
  assert.strictEqual((addBindingEdit('C:/r/c.yaml', catalog, { ...set, bindings: ['zeta'] }, 'typescript', order) as { text: string }).text,
    '[zeta, typescript]', 'two unlisted bindings keep their order');
  assert.strictEqual(addBindingEdit('C:/r/c.yaml', catalog, set, 'go', order), undefined);
  assert.deepStrictEqual(addBindingEdit('C:/r/c.yaml', catalog, { ...set, bindingsRange: undefined }, 'rust', order),
    { refused: 'core.set has no `bindings:` list to add rust to.' });
});

test('eolOf and offsetOf', () => {
  assert.strictEqual(eolOf('a\r\nb'), '\r\n');
  assert.strictEqual(eolOf('a\nb'), '\n');
  assert.strictEqual(offsetOf('ab\ncd\n', { line: 1, character: 1 }), 4);
  assert.strictEqual(offsetOf('ab', { line: 3, character: 0 }), 2);
  assert.strictEqual(offsetOf('ab', { line: 0, character: 9 }), 2);
});
