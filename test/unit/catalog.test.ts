// B1.2: parseCatalog, parseShape, flattenShape, actionHoverMarkdown.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { flattenShape, parseCatalog, parseShape } from '../../src/core/catalog';
import { actionHoverMarkdown } from '../../src/core/hoverText';
import { parseYaml } from '../../src/core/yamlPositions';
import { RegistrationSite } from '../../src/core/types';

const CATALOG = `catalogVersion: 1
bindings: [powershell, csharp, go, rust]
actions:
  - name: cluster.state
    summary: Read the cluster.
    bindings: [powershell]
    interruptible: false
    notes: Opens a PSDirect session.
    params:
      - { name: target, type: string, required: true, description: 'The node | guest' }
      - { name: timeoutSec, type: integer, default: 30 }
      - { name: flag, type: boolean, required: false }
      - { type: string }
    captures:
      type: object
      properties:
        Name: { type: string }
        Nodes:
          type: array
          items:
            type: object
            properties:
              Name: { type: string }
              State: { type: string }
  - name: lifecycle.get
    summary: GET a route.
    deprecated: true
    bindings: [powershell, csharp, go, rust]
    params: not-a-list
    captures: { type: object, additionalProperties: true }
  - summary: no name here
  - name: lifecycle.get
    summary: duplicate
  - name: bare
`;

test('parseCatalog reads bindings, actions, params and shapes', () => {
  const c = parseCatalog(CATALOG, '/c.yaml');
  assert.deepStrictEqual(c.bindings, ['powershell', 'csharp', 'go', 'rust']);
  assert.deepStrictEqual([...c.actions.keys()], ['cluster.state', 'lifecycle.get', 'bare']);
  const state = c.actions.get('cluster.state')!;
  assert.strictEqual(state.interruptible, false);
  assert.strictEqual(state.notes, 'Opens a PSDirect session.');
  assert.deepStrictEqual(state.params.map(p => [p.name, p.type, p.required, p.default]),
    [['target', 'string', true, undefined], ['timeoutSec', 'integer', undefined, 30], ['flag', 'boolean', false, undefined]]);
  assert.strictEqual(state.captures.open, false);
  assert.deepStrictEqual([...state.captures.properties.keys()], ['Name', 'Nodes']);
  assert.ok(state.captures.properties.get('Nodes')!.items!.properties.has('State'));
  const get = c.actions.get('lifecycle.get')!;
  assert.strictEqual(get.deprecated, true);
  assert.strictEqual(get.interruptible, true);
  assert.deepStrictEqual(get.params, []);
  assert.strictEqual(get.captures.open, true);
  const bare = c.actions.get('bare')!;
  assert.strictEqual(bare.summary, '');
  assert.deepStrictEqual(bare.bindings, []);
  assert.strictEqual(bare.bindingsRange, undefined);
  assert.strictEqual(bare.deprecated, undefined);
});

test('B1.2-2 nameRange starts at the name text', () => {
  const c = parseCatalog(CATALOG, '/c.yaml');
  const lines = CATALOG.split('\n');
  for (const a of c.actions.values()) {
    const line = lines[a.nameRange.start.line];
    assert.strictEqual(line.slice(a.nameRange.start.character, a.nameRange.end.character), a.name);
  }
});

test('BDD020 duplicate and BDD021 missing name', () => {
  const c = parseCatalog(CATALOG, '/c.yaml');
  assert.deepStrictEqual(c.errors.map(e => e.code), ['BDD021', 'BDD020']);
  assert.strictEqual(c.actions.get('lifecycle.get')!.summary, 'GET a route.');
});

test('missing bindings and actions give empty lists', () => {
  const c = parseCatalog('catalogVersion: 1\n', '/c.yaml');
  assert.deepStrictEqual(c.bindings, []);
  assert.strictEqual(c.actions.size, 0);
  assert.deepStrictEqual(c.errors, []);
});

test('malformed YAML is BDD022 at the parser position', () => {
  const c = parseCatalog('actions:\n  - name: [unclosed\n', '/c.yaml');
  assert.strictEqual(c.errors.length, 1);
  assert.strictEqual(c.errors[0].code, 'BDD022');
  assert.strictEqual(c.actions.size, 0);
});

test('B1.2-3 open and closed shapes; parseShape of a non-map', () => {
  assert.deepStrictEqual(parseShape(undefined), { open: false, properties: new Map() });
  const y = parseYaml('a: { type: object, additionalProperties: false, properties: { X: { type: string } } }');
  const shape = parseShape((y.doc.contents as any).items[0].value);
  assert.strictEqual(shape.open, false);
  assert.ok(shape.properties.has('X'));
});

test('flattenShape lists dotted paths to depth 3, marking open levels', () => {
  const c = parseCatalog(CATALOG, '/c.yaml');
  assert.deepStrictEqual(flattenShape(c.actions.get('cluster.state')!.captures),
    ['Name: string', 'Nodes: array', 'Nodes.0.Name: string', 'Nodes.0.State: string']);
  assert.deepStrictEqual(flattenShape(c.actions.get('lifecycle.get')!.captures), ['*']);
  const open = parseCatalog('actions:\n  - name: x\n    captures: { properties: { a: { additionalProperties: true, properties: { b: {} } } }, items: {} }\n', '/c');
  assert.deepStrictEqual(flattenShape(open.actions.get('x')!.captures, 1), ['a', 'a.*']);
  assert.deepStrictEqual(flattenShape(open.actions.get('x')!.captures), ['a', 'a.*', 'a.b']);
});

const site = (binding: string, line: number): RegistrationSite =>
  ({ binding, action: 'cluster.state', file: `C:\\x\\${binding}.src`, range: { start: { line, character: 0 }, end: { line, character: 1 } }, recognizer: 0 });

test('actionHoverMarkdown: params, captures, interruptible, notes, binding lines', () => {
  const c = parseCatalog(CATALOG, '/c.yaml');
  const md = actionHoverMarkdown(c.actions.get('cluster.state')!,
    [{ name: 'powershell', label: 'PowerShell' }, { name: 'go', label: 'Go' }],
    [site('powershell', 9), site('go', 3)], s => `link:${s.binding}`);
  assert.match(md, /^\*\*cluster\.state\*\* - Read the cluster\./);
  assert.match(md, /\| `target` \| string \| yes \|  \| The node \\\| guest \|/);
  assert.match(md, /\| `timeoutSec` \| integer \|  \| `30` \|  \|/);
  assert.match(md, /Captures: `Name: string`/);
  assert.match(md, /interruptible: false/);
  assert.match(md, /Opens a PSDirect session\./);
  assert.match(md, /- PowerShell: \[powershell\.src:10\]\(link:powershell\)/);
  assert.match(md, /- Go: not implemented/);
});

test('actionHoverMarkdown: deprecated, open shape, implemented without a site, no params', () => {
  const c = parseCatalog(CATALOG, '/c.yaml');
  const md = actionHoverMarkdown(c.actions.get('lifecycle.get')!, [{ name: 'rust', label: 'Rust' }], [], () => '');
  assert.match(md, /\*Deprecated\.\*/);
  assert.match(md, /open shape/);
  assert.match(md, /- Rust: implemented$/);
  assert.doesNotMatch(md, /\| Parameter/);
  const bare = actionHoverMarkdown(c.actions.get('bare')!, [], [], () => '');
  assert.match(bare, /Captures: nothing declared/);
});

test('B1.2-1 the real catalog: counts read from the file, no errors', (t) => {
  const root = process.env.OS_CONTEXT_ROOT;
  if (!root) {
    t.skip('OS_CONTEXT_ROOT is not set; the real catalog was not checked');
    return;
  }
  const file = path.join(root, 'test/e2e/schema/actions.catalog.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const c = parseCatalog(text, file);
  assert.deepStrictEqual(c.errors, []);
  const names = text.match(/^ {2}- name: /gm)!.length;
  assert.strictEqual(c.actions.size, names);
  const top = c.bindings.filter(b => b !== 'powershell');
  const portable = [...c.actions.values()].filter(a => top.every(b => a.bindings.includes(b))).length;
  const portableInText = (text.match(new RegExp(`^ {4}bindings: \\[${c.bindings.join(', ')}\\]`, 'gm')) ?? []).length;
  assert.strictEqual(portable, portableInText);
  t.diagnostic(`real catalog: ${c.actions.size} actions, ${portable} list every binding (${c.bindings.join(', ')})`);
});

test('a parameter with only a name renders empty cells', () => {
  const c = parseCatalog('actions:\n  - name: x\n    params:\n      - { name: p }\n', '/c');
  const md = actionHoverMarkdown(c.actions.get('x')!, [], [], () => '');
  assert.match(md, /\| `p` \|  \|  \|  \|  \|/);
});

test('parseYaml.range of a missing node is the start of the text; helpers on non-maps', async () => {
  const { parseYaml: py, pairOf, stringOf, itemsOf, stringItems } = await import('../../src/core/yamlPositions');
  const y = py('a: 1\n');
  assert.deepStrictEqual(y.range(undefined), { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
  assert.strictEqual(pairOf('scalar', 'a'), undefined);
  assert.strictEqual(stringOf(undefined, 'a'), undefined);
  assert.deepStrictEqual(itemsOf(undefined, 'a'), []);
  assert.deepStrictEqual(stringItems(undefined), []);
});
