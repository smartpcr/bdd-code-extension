// B3.3, B3.4, B3.5: scopeAt per rule and position, shapeAt, capturePathAt,
// line contexts, metaCompletions, the capture hover text.
import * as assert from 'assert';
import * as path from 'path';
import { test } from 'node:test';
import { parseCatalog } from '../../src/core/catalog';
import { actionPrefix, assertSubjectPrefix, metaPrefix, requiredParamsSnippet, stepKeysAround, withKeyPrefix } from '../../src/core/completionContext';
import { actionSortKey } from '../../src/core/coverage';
import { captureHoverMarkdown } from '../../src/core/hoverText';
import { capturePathAt, scopeAt, shapeAt, subjectStatus } from '../../src/core/scope';
import { parseSuite } from '../../src/core/suites';
import { Pos } from '../../src/core/text';
import { WorkspaceIndex } from '../../src/core/workspaceIndex';

const dir = path.resolve('/r/s');
const f = (n: string) => path.join(dir, n);

const SUITE = `suite: s
imports: [lib.yml]
params:
  - { name: node, type: string }
vars:
  limit: 3
setup:
  - action: core.set
    captureAs: agent
  - action: core.noop
    captureAs: setup2
beforeEach:
  - meta: select-lab
  - action: core.noop
    captureAs: each
afterEach:
  - action: core.noop
    captureAs: after1
  - action: core.noop
teardown:
  - action: core.noop
    captureAs: td
  - action: core.noop
metaSteps:
  - name: local
    params:
      - { name: p1, required: true }
      - { name: p2 }
    exports: [m1]
    steps:
      - action: core.set
        captureAs: m1
      - action: core.noop
tests:
  - name: c1
    params:
      - { name: extra, value: 1 }
    vars:
      v1: 1
    setup:
      - action: core.noop
        captureAs: cs0
      - action: core.noop
    steps:
      - action: cluster.state
        captureAs: cs
        asserts:
          - var: cs.State
            equals: Up
      - action: core.noop
        node: x
      - action: cluster.state
        captureAs: views
        table:
          - { node: a, drain: true }
      - meta: local
        with: { p1: 1 }
      - meta: deep
      - meta: nowhere
      - action: core.noop
        captureAs: late
    asserts:
      - var: x
        equals: y
    cleanup:
      - action: core.noop
        captureAs: cl1
      - action: core.noop
  - name: c2
    examples:
      - { node: a, mode: b }
    steps:
      - action: core.noop
`;
const LIB = `params:
  - { name: fixtureDir }
vars:
  libvar: 1
metaSteps:
  - name: select-lab
    exports: [source]
    steps:
      - action: lifecycle.select
        captureAs: source
  - name: deep
    exports: [deepcap, ghost]
    steps:
      - meta: inner
  - name: inner
    exports: [deepcap]
    steps:
      - action: core.set
        captureAs: deepcap
`;
const CATALOG = `bindings: [powershell, rust]
actions:
  - name: cluster.state
    bindings: [powershell]
    captures:
      type: object
      properties:
        State: { type: string }
        Nodes: { type: array, items: { type: object, properties: { Name: { type: string } } } }
        Raw: { type: object, additionalProperties: true }
  - name: core.set
    bindings: [powershell, rust]
    captures: { additionalProperties: true }
  - name: lifecycle.select
    bindings: [powershell, rust]
    captures: { type: object, additionalProperties: true, properties: { id: { type: string } } }
`;

const ix = new WorkspaceIndex();
ix.updateCatalog(parseCatalog(CATALOG, '/r/catalog.yaml'));
ix.updateSuite(parseSuite(SUITE, f('s.yml')));
ix.updateSuite(parseSuite(LIB, f('lib.yml')));
const suite = ix.suite(f('s.yml'))!;
const lines = SUITE.split('\n');
/** The position inside the `n`-th line containing `needle`, `dx` characters in. */
const pos = (needle: string, dx = 0, n = 0): Pos => {
  const hits = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes(needle));
  const [l, i] = hits[n];
  return { line: i, character: l.indexOf(needle) + dx };
};
const caps = (p: Pos, file = f('s.yml')) => [...scopeAt(ix, file, p).captures.keys()].sort();

test('the index records with and asserts ranges and required meta params', () => {
  const step = suite.steps.find(s => s.meta === 'local')!;
  assert.deepStrictEqual(step.withKeys.map(k => k.name), ['p1']);
  assert.ok(step.withRange);
  assert.ok(suite.steps.find(s => s.captureAs === 'cs')!.assertsRange);
  assert.deepStrictEqual(suite.metaSteps.find(m => m.name === 'local')!.required, ['p1']);
});

test('suite setup: only earlier setup steps', () => {
  assert.deepStrictEqual(caps(pos('captureAs: setup2')), ['agent']);
});

test('beforeEach: setup, then earlier beforeEach steps (a meta use brings its exports)', () => {
  assert.deepStrictEqual(caps(pos('captureAs: each')), ['agent', 'setup2', 'source']);
});

test('afterEach and teardown', () => {
  assert.deepStrictEqual(caps(pos('captureAs: after1', 0, 0)), ['agent', 'each', 'setup2', 'source']);
  assert.deepStrictEqual(caps({ line: pos('captureAs: after1').line + 1, character: 6 }), ['after1', 'agent', 'each', 'setup2', 'source']);
  assert.deepStrictEqual(caps(pos('captureAs: td')), ['agent', 'setup2']);
  assert.deepStrictEqual(caps({ line: pos('captureAs: td').line + 1, character: 6 }), ['agent', 'setup2', 'td']);
});

test('case setup: setup, beforeEach, earlier case-setup steps', () => {
  assert.deepStrictEqual(caps(pos('captureAs: cs0')), ['agent', 'each', 'setup2', 'source']);
  assert.deepStrictEqual(caps({ line: pos('captureAs: cs0').line + 1, character: 8 }), ['agent', 'cs0', 'each', 'setup2', 'source']);
});

test('B3.3-1/2 case steps: hooks, case setup, earlier steps only; never a later step or another case', () => {
  const second = caps(pos('node: x'));
  assert.deepStrictEqual(second, ['agent', 'cs', 'cs0', 'each', 'setup2', 'source']);
  assert.ok(!second.includes('late') && !second.includes('views'));
  const c2 = caps(pos('mode: b'));
  assert.ok(!c2.includes('cs') && c2.includes('agent'));
});

test('a step does not see its own capture, except in its own asserts', () => {
  assert.ok(!caps(pos('captureAs: cs')).includes('cs'));
  assert.ok(caps(pos('var: cs.State')).includes('cs'));
});

test('B3.3-4 meta exports appear after the meta step, nested exports followed; a missing export or meta is skipped', () => {
  const after = scopeAt(ix, f('s.yml'), pos('captureAs: late'));
  assert.ok(after.captures.has('m1'));
  assert.ok(after.captures.has('deepcap'));
  assert.strictEqual(after.captures.get('deepcap')!.step.action, 'core.set');
  assert.ok(!after.captures.has('ghost'));
  assert.ok(!caps(pos('meta: local')).includes('m1'));
});

test('case asserts and cleanup: all case steps', () => {
  const asserts = caps({ line: pos('var: x').line, character: 10 });
  assert.ok(asserts.includes('late') && asserts.includes('views'));
  assert.ok(!asserts.includes('cl1'));
  const cleanup = caps({ line: pos('captureAs: cl1').line + 1, character: 10 });
  assert.ok(cleanup.includes('late') && cleanup.includes('cl1'));
  assert.ok(!caps(pos('captureAs: cl1')).includes('cl1'));
});

test('inside a meta step definition: earlier steps of the definition and its own params', () => {
  const s = scopeAt(ix, f('s.yml'), { line: pos('captureAs: m1').line + 1, character: 8 });
  assert.deepStrictEqual([...s.captures.keys()], ['m1']);
  assert.deepStrictEqual(s.params, ['p1', 'p2']);
  assert.deepStrictEqual(caps(pos('captureAs: m1')), []);
});

test('params: suite, imported, case; vars: suite, imported, case; outside any step the setup captures', () => {
  const s = scopeAt(ix, f('s.yml'), pos('node: x'));
  assert.deepStrictEqual(s.params, ['node', 'fixtureDir', 'extra']);
  assert.deepStrictEqual(s.vars.sort(), ['libvar', 'limit', 'v1']);
  const root = scopeAt(ix, f('s.yml'), pos('limit: 3'));
  assert.deepStrictEqual([...root.captures.keys()].sort(), ['agent', 'setup2']);
  assert.deepStrictEqual(root.vars.sort(), ['libvar', 'limit']);
  assert.strictEqual(root.rows, undefined);
});

test('B3.3-3 rows only in a table step or an examples case', () => {
  assert.deepStrictEqual(scopeAt(ix, f('s.yml'), pos('node: a, drain')).rows, ['node', 'drain']);
  const c2 = suite.steps.find(s => s.home.kind === 'case' && s.home.caseName === 'c2')!;
  assert.deepStrictEqual(scopeAt(ix, f('s.yml'), c2.actionRange!.start).rows, ['node', 'mode']);
  assert.strictEqual(scopeAt(ix, f('s.yml'), pos('node: x')).rows, undefined);
});

test('a file the index does not know has an empty scope; an import cycle and a missing import are harmless', () => {
  assert.deepStrictEqual(scopeAt(ix, f('none.yml'), { line: 0, character: 0 }), { captures: new Map(), params: [], vars: [] });
  const cyc = new WorkspaceIndex();
  cyc.updateSuite(parseSuite('suite: a\nimports: [b.yml, gone.yml]\nparams: [{ name: pa }]\ntests:\n  - name: c\n    steps:\n      - action: x\n', f('a.yml')));
  cyc.updateSuite(parseSuite('imports: [a.yml, b.yml]\nparams: [{ name: pb }]\n', f('b.yml')));
  assert.deepStrictEqual(scopeAt(cyc, f('a.yml'), { line: 6, character: 10 }).params, ['pa', 'pb']);
  const deep = new WorkspaceIndex();
  for (let i = 0; i < 8; i++) deep.updateSuite(parseSuite(`imports: [l${i + 1}.yml]\nparams: [{ name: p${i} }]\n`, f(`l${i}.yml`)));
  deep.updateSuite(parseSuite('suite: z\nimports: [l0.yml]\n', f('z.yml')));
  const ps = scopeAt(deep, f('z.yml'), { line: 0, character: 0 }).params;
  assert.ok(ps.includes('p0') && !ps.includes('p7'));
});

test('a meta export more than META_DEPTH_LIMIT uses deep is not followed', () => {
  const d = new WorkspaceIndex();
  let lib = 'metaSteps:\n';
  for (let i = 0; i < 8; i++) lib += `  - name: m${i}\n    exports: [x]\n    steps:\n      - meta: m${i + 1}\n`;
  lib += '  - name: m8\n    exports: [x]\n    steps:\n      - action: core.set\n        captureAs: x\n';
  d.updateSuite(parseSuite(lib, f('d.yml')));
  d.updateSuite(parseSuite('suite: q\nimports: [d.yml]\ntests:\n  - name: c\n    steps:\n      - meta: m0\n      - action: core.noop\n', f('q.yml')));
  assert.strictEqual(scopeAt(d, f('q.yml'), { line: 6, character: 10 }).captures.has('x'), false);
  d.updateSuite(parseSuite('suite: q\nimports: [d.yml]\ntests:\n  - name: c\n    steps:\n      - meta: m6\n      - action: core.noop\n', f('q.yml')));
  assert.strictEqual(scopeAt(d, f('q.yml'), { line: 6, character: 10 }).captures.has('x'), true);
});

test('B3.4 shapeAt: closed, nested, list, open, table', () => {
  const state = ix.catalog!.actions.get('cluster.state')!;
  const set = ix.catalog!.actions.get('core.set')!;
  const select = ix.catalog!.actions.get('lifecycle.select')!;
  const props = (s: ReturnType<typeof shapeAt>) => (s && s !== 'open' ? [...s.properties.keys()] : s);
  assert.deepStrictEqual(props(shapeAt(state, [], false)), ['State', 'Nodes', 'Raw']);
  assert.deepStrictEqual(props(shapeAt(state, ['Nodes', '0'], false)), ['Name']);
  assert.strictEqual(shapeAt(state, ['Nope'], false), undefined);
  assert.strictEqual(shapeAt(state, ['State', '0'], false), undefined);
  assert.strictEqual(shapeAt(state, ['Raw'], false), 'open');
  assert.strictEqual(shapeAt(state, ['Raw', 'deeper'], false), 'open');
  assert.strictEqual(shapeAt(set, [], false), 'open');
  assert.deepStrictEqual(props(shapeAt(select, [], false)), ['id']);
  assert.strictEqual(shapeAt(select, ['other'], false), 'open');
  const list = shapeAt(state, [], true);
  assert.ok(list && list !== 'open' && list.type === 'array' && list.items === state.captures);
  assert.strictEqual(shapeAt(state, ['State'], true), undefined, 'B3.4-2 a table capture needs an index first');
  assert.deepStrictEqual(props(shapeAt(state, ['0'], true)), ['State', 'Nodes', 'Raw']);
});

test('capturePathAt: the capture path under the offset', () => {
  const e = '${lower(capture.cs.Nodes.0.Name) + capture.x}';
  assert.deepStrictEqual(capturePathAt(e, 12), ['cs', 'Nodes', '0', 'Name']);
  assert.deepStrictEqual(capturePathAt(e, e.indexOf('capture.x') + 9), ['x']);
  assert.strictEqual(capturePathAt(e, 2), undefined);
  assert.strictEqual(capturePathAt('${param.capture.x}', 10), undefined);
});

test('line contexts: action, meta, with keys', () => {
  assert.strictEqual(actionPrefix('      - action: clu'), 'clu');
  assert.strictEqual(actionPrefix('        action: '), '');
  assert.strictEqual(actionPrefix('        node: x'), undefined);
  assert.strictEqual(metaPrefix('  - meta: sel'), 'sel');
  assert.strictEqual(metaPrefix('  - meta: a b'), undefined);
  const L = ['    - meta: m', '      with:', '        lab', '', '        ', '      other:', '        x', '      with: { a: 1, b', '  top', 'x:'];
  assert.strictEqual(withKeyPrefix(L, 2, 11), 'lab');
  assert.strictEqual(withKeyPrefix(L, 4, 8), '');
  assert.strictEqual(withKeyPrefix(L, 6, 9), undefined);
  assert.strictEqual(withKeyPrefix(L, 7, 25), 'b');
  assert.strictEqual(withKeyPrefix(['      with: {', ''], 0, 13), '');
  assert.strictEqual(withKeyPrefix(L, 8, 5), undefined);
  assert.strictEqual(withKeyPrefix(['  a: b'], 0, 6), undefined);
  assert.strictEqual(withKeyPrefix(['x'], 0, 1), undefined);
});

test('actionSortKey: the target first', () => {
  assert.strictEqual(actionSortKey('b', ['rust'], 'rust'), '0b');
  assert.strictEqual(actionSortKey('a', ['powershell'], 'rust'), '1a');
});

test('B3.5-1 metaCompletions: local and imported, one per name, the visible one', () => {
  const metas = ix.metaCompletions(f('s.yml'));
  assert.deepStrictEqual(metas.map(m => m.def.name), ['deep', 'inner', 'local', 'select-lab']);
  const shadow = new WorkspaceIndex();
  shadow.updateSuite(parseSuite('suite: x\nimports: [l.yml]\nmetaSteps:\n  - name: dup\n', f('x.yml')));
  shadow.updateSuite(parseSuite('metaSteps:\n  - name: dup\n', f('l.yml')));
  assert.deepStrictEqual(shadow.metaCompletions(f('x.yml')).map(m => path.basename(m.file)), ['x.yml']);
});

test('captureHoverMarkdown: not captured, producer and type, open, not in shape, table', () => {
  assert.match(captureHoverMarkdown(['x'], undefined, undefined, ''), /`x` is not captured before this point/);
  const src = { file: 'C:\\s\\a.yml', line: 4, action: 'cluster.state', fromTable: false };
  const state = ix.catalog!.actions.get('cluster.state')!;
  const md = captureHoverMarkdown(['cs'], src, state.captures, 'link');
  assert.match(md, /Captured by `cluster\.state` at \[a\.yml:5\]\(link\)\./);
  assert.match(md, /Type: `object`/);
  assert.match(md, /Properties: `State`, `Nodes`, `Raw`/);
  assert.match(captureHoverMarkdown(['cs', 'Raw', 'k'], src, 'open', 'l'), /Open shape/);
  assert.match(captureHoverMarkdown(['cs', 'Nope'], src, undefined, 'l'), /`Nope` is not in the declared capture shape/);
  const t = captureHoverMarkdown(['v', '0'], { ...src, action: undefined, fromTable: true }, { open: true, properties: new Map() }, 'l');
  assert.match(t, /Captured by a step at/);
  assert.match(t, /a table step/);
  assert.match(t, /Type: `unspecified` \(open: other keys may appear\)/);
});

test('a with key with no value at all is a range over the key', () => {
  const s = parseSuite('suite: e\ntests:\n  - name: c\n    steps:\n      - meta: m\n        ? with\n', f('e.yml'));
  const r = s.steps[0].withRange!;
  assert.deepStrictEqual([r.start.line, r.start.character, r.end.line, r.end.character], [5, 10, 5, 14]);
});

test('requiredParamsSnippet: the action, then each required parameter not yet written, at the step\'s key column', () => {
  assert.strictEqual(requiredParamsSnippet('demo.greet', ['name'], 8, new Set(['action'])), 'demo.greet\n        name: $1');
  assert.strictEqual(requiredParamsSnippet('a.b', ['x', 'y'], 2, new Set(['x']), '\r\n'), 'a.b\r\n  y: $1');
  assert.strictEqual(requiredParamsSnippet('a.b', [], 2, new Set()), 'a.b');
  assert.strictEqual(requiredParamsSnippet('a$b}', ['p$'], 0, new Set()), String.raw`a\$b\}` + '\n' + String.raw`p\$: $1`, 'snippet syntax in a name is escaped');
});

test('stepKeysAround: the key column of `action:` and the step\'s keys at that column, past nested values', () => {
  const lines = [
    'tests:',
    '  - name: c',
    '    steps:',
    '      - given: a step',
    '        asserts:',
    '          - subject: x',
    '            equals: y',
    '        action: demo.gr',
    '        name: world',
    '        with:',
    '          deep: 1',
    '        captureAs: g',
    '      - when: the next step',
    '        action: other',
  ];
  assert.deepStrictEqual(stepKeysAround(lines, 7), { keyColumn: 8, keys: new Set(['given', 'asserts', 'action', 'name', 'with', 'captureAs']) });
  assert.deepStrictEqual(stepKeysAround(['steps:', '', '  - action: x', '', '    to: 3', '  - action: y'], 2), { keyColumn: 4, keys: new Set(['action', 'to']) },
    'blank lines are skipped both ways');
  assert.deepStrictEqual(stepKeysAround(['  - given: g', '', '    action: x'], 2), { keyColumn: 4, keys: new Set(['given', 'action']) });
  assert.deepStrictEqual(stepKeysAround(['  steps:', '      action: x', '    note', '      later: 1'], 1), { keyColumn: 6, keys: new Set(['action']) },
    'a shallower line ends the step');
  assert.deepStrictEqual(stepKeysAround(['    plain text', '      action: x', '      a line'], 1), { keyColumn: 6, keys: new Set(['action']) },
    'a line that is not a key ends the step');
  assert.deepStrictEqual(stepKeysAround(['not an action line'], 0), { keyColumn: 0, keys: new Set() });
});

test('subjectStatus: the capture in scope, each field in the action\'s shape, open past an open shape or a capture with no catalog action', () => {
  const at = pos('var: cs.State', 5);
  const status = (p: Pos, ...path: string[]) => subjectStatus(ix, f('s.yml'), p, path);
  assert.deepStrictEqual(status(at, 'cs', 'State'), ['known', 'known'], 'a step\'s own asserts see its capture');
  assert.deepStrictEqual(status(at, 'cs', 'Nodes', '0', 'Name'), ['known', 'known', 'known', 'known']);
  assert.deepStrictEqual(status(at, 'cs', 'Nope', 'deeper'), ['known', 'unknown', 'unknown']);
  assert.deepStrictEqual(status(at, 'cs', 'Raw', 'anything'), ['known', 'open', 'open']);
  assert.deepStrictEqual(status(at, 'ghost', 'x'), ['unknown', 'open']);
  const caseAsserts = pos('var: x', 5);
  assert.deepStrictEqual(status(caseAsserts, 'each', 'y'), ['known', 'open'], 'core.noop is not in this catalog, so nothing is declared');
  assert.deepStrictEqual(status(caseAsserts, 'late'), ['known'], 'the case asserts see every case step');
});

test('assertSubjectPrefix: after var: in an asserts item, the segments, the partial name and where it starts', () => {
  const lines = [
    '    asserts:',
    '      - var: location.sta',
    '        equals: x',
    '      - isTrue: true',
    '        var: ',
    '      - var: a.b.',
    '    with:',
    '      - var: no',
    '      - isTrue: true',
    '        var: no',
  ];
  assert.deepStrictEqual(assertSubjectPrefix(lines, 1, lines[1].length), { segments: ['location'], prefix: 'sta', start: 22 });
  assert.deepStrictEqual(assertSubjectPrefix(lines, 4, lines[4].length), { segments: [], prefix: '', start: 13 }, 'var: below the dash');
  assert.deepStrictEqual(assertSubjectPrefix(lines, 5, lines[5].length), { segments: ['a', 'b'], prefix: '', start: 17 });
  assert.strictEqual(assertSubjectPrefix(lines, 7, lines[7].length), undefined, 'a list that is not asserts');
  assert.strictEqual(assertSubjectPrefix(lines, 9, lines[9].length), undefined, 'below the dash, in a list that is not asserts');
  assert.strictEqual(assertSubjectPrefix(lines, 2, lines[2].length), undefined, 'not after var:');
  assert.strictEqual(assertSubjectPrefix(['    var: a'], 0, 10), undefined, 'no list item above');
  assert.strictEqual(assertSubjectPrefix(['  plain', '    var: a'], 1, 10), undefined, 'a key above is not a list item');
  assert.strictEqual(assertSubjectPrefix(['  - var: a'], 0, 10), undefined, 'nothing above the item');
  const spaced = ['asserts:', '', '  - isTrue: true', '      nested: 1', '', '    var: ab'];
  assert.deepStrictEqual(assertSubjectPrefix(spaced, 5, 11), { segments: [], prefix: 'ab', start: 9 }, 'blank and deeper lines are passed over');
});
