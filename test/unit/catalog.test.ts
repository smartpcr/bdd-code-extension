// B1.2: parseCatalog, parseShape, flattenShape, actionHoverMarkdown.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { flattenShape, parseCatalog, parseShape, resolveCatalog } from '../../src/core/catalog';
import { fileKey } from '../../src/core/paths';
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

// The sample workspace in this repository (D8): a real catalog that imports the core.
const SAMPLE = path.resolve(__dirname, '../../../samples/workspace');

test('B1.2-1 the real catalog: counts read from the file, no errors', (t) => {
  const file = path.join(SAMPLE, 'test/e2e/schema/actions.catalog.yaml');
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
  // With its import resolved (DEC-S10), the core's actions join the sample's, each keeping its file.
  const resolved = resolveCatalog(text, file, f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined));
  assert.deepStrictEqual(resolved.errors, []);
  const core = path.resolve(SAMPLE, '../../spec/core.catalog.yaml');
  assert.deepStrictEqual(resolved.imports, [fileKey(core)]);
  const coreNames = fs.readFileSync(core, 'utf8').match(/^ {2}- name: /gm)!.length;
  assert.strictEqual(resolved.actions.size, names + coreNames);
  assert.strictEqual(resolved.actions.get('wait')!.file, fileKey(core));
  assert.strictEqual(resolved.actions.get('inventory.get')!.file, undefined);
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

// DEC-S10: a workspace catalog imports others; the index sees one catalog.
const W = path.resolve('/ws/test/e2e/schema');
const k = (f: string) => fileKey(path.join(W, f));
const entry = (name: string, bindings = '[go]') => `  - name: ${name}\n    summary: ${name}.\n    bindings: ${bindings}\n    interruptible: true\n    captures: { type: any }\n`;
const files = (map: Record<string, string>) => (file: string) => {
  const hit = Object.entries(map).find(([f]) => k(f) === fileKey(file));
  return hit?.[1];
};

test('resolveCatalog: imports first, depth first; each imported action keeps its file; a diamond is read once; bindings merge', () => {
  const read = files({
    'core.yaml': `catalogVersion: 1\nbindings: [powershell]\nactions:\n${entry('core.set', '[powershell]')}`,
    'team/base.yaml': `catalogVersion: 1\nimports: [../core.yaml]\nbindings: [rust]\nactions:\n${entry('team.list')}`,
  });
  const c = resolveCatalog(`catalogVersion: 1\nimports: [core.yaml, team/base.yaml, { not: a path }]\nbindings: [go]\nactions:\n${entry('shop.order')}`, k('actions.catalog.yaml'), read);
  assert.deepStrictEqual([...c.actions.keys()], ['core.set', 'team.list', 'shop.order']);
  assert.deepStrictEqual([c.actions.get('core.set')!.file, c.actions.get('team.list')!.file, c.actions.get('shop.order')!.file], [k('core.yaml'), k('team/base.yaml'), undefined]);
  assert.deepStrictEqual(c.imports, [k('core.yaml'), k('team/base.yaml')]);
  assert.deepStrictEqual(c.bindings, ['go', 'powershell', 'rust']);
  assert.deepStrictEqual(c.ownBindings, ['go'], "an import does not widen the workspace's own bindings");
  assert.deepStrictEqual(c.errors, []);
});

test('resolveCatalog: a name declared twice, a cycle, a missing import and a broken one are errors at the root import', () => {
  const read = files({
    'core.yaml': `catalogVersion: 1\nactions:\n${entry('core.set')}`,
    'again.yaml': `catalogVersion: 1\nactions:\n${entry('core.set')}`,
    'a.yaml': 'catalogVersion: 1\nimports: [b.yaml]\n',
    'b.yaml': 'catalogVersion: 1\nimports: [a.yaml]\n',
    'broken.yaml': 'actions: [\n',
  });
  const root = `catalogVersion: 1\nimports: [core.yaml, again.yaml, a.yaml, gone.yaml, broken.yaml]\nactions:\n${entry('core.set')}`;
  const c = resolveCatalog(root, k('actions.catalog.yaml'), read);
  const codes = c.errors.map(e => `${e.code} ${e.range.start.line}:${e.range.start.character}`);
  assert.deepStrictEqual(codes, ['BDD020 1:21', 'BDD023 1:33', 'BDD024 1:41', 'BDD022 1:52', 'BDD020 3:10']);
  assert.match(c.errors[0]!.message, /core\.set is declared in both .*core\.yaml and .*again\.yaml; the first is used/);
  assert.match(c.errors[1]!.message, /import cycle: .*a\.yaml -> .*b\.yaml -> .*a\.yaml/);
  assert.match(c.errors[3]!.message, /^broken\.yaml: The catalog is not valid YAML/);
  assert.equal(c.actions.get('core.set')!.file, k('core.yaml'), 'the first declaration is used');
});

test('resolveCatalog: a catalog that is not YAML has no imports to follow', () => {
  const c = resolveCatalog('imports: [x.yaml\n', k('actions.catalog.yaml'), () => { throw new Error('never read'); });
  assert.deepStrictEqual([c.errors.map(e => e.code), c.imports, c.actions.size], [['BDD022'], [], 0]);
});
