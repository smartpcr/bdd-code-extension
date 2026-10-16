// B4.1, B4.3: the binding table, drift and the program cross-check.
import * as assert from 'assert';
import { test } from 'node:test';
import {
  actionStatus, commonSource, compareProgramSet, computeCoverage, CoverageRow, driftCount, globDirectory, expectedBindings, missingImplementations, programAgrees, toMarkdownTable, workspaceBindings,
} from '../../src/core/coverage';

const catalog = {
  bindings: ['powershell', 'go'],
  actions: new Map<string, { bindings: string[] }>([
    ['a.one', { bindings: ['powershell', 'go'] }],
    ['a.two', { bindings: ['powershell', 'go'] }],
    ['ps.only', { bindings: ['powershell'] }],
  ]),
};
const bindings = [
  { name: 'powershell', label: 'PowerShell', sources: ['scripts/e2e/actions/*.ps1'] },
  { name: 'go', label: 'Go', sources: ['test/e2e/bindings/go/internal/**/*.go', 'test/e2e/bindings/go/cmd/*.go'] },
];
const site = (binding: string, action: string, recognizer = 0) => ({ binding, action, recognizer });
const clean = [site('powershell', 'a.one'), site('powershell', 'a.two'), site('powershell', 'ps.only'),
  site('go', 'a.one'), site('go', 'a.two', 1)];

test('B4.1-1 a clean tree: Declared equals the catalog, Found equals Declared, no drift', () => {
  const rows = computeCoverage(catalog, clean, bindings);
  assert.deepStrictEqual(rows.map(r => [r.label, r.source, r.declared.length, r.found.length, driftCount(r)]), [
    ['PowerShell', 'scripts/e2e/actions/', 3, 3, 0],
    ['Go', 'test/e2e/bindings/go/', 2, 2, 0],
  ]);
});

test('B4.1-2 removing one site moves exactly that name to declaredNotFound', () => {
  const rows = computeCoverage(catalog, clean.filter(s => !(s.binding === 'go' && s.action === 'a.two')), bindings);
  assert.deepStrictEqual(rows[1].declaredNotFound, ['a.two']);
  assert.deepStrictEqual(rows[1].foundNotDeclared, []);
  assert.strictEqual(driftCount(rows[1]), 1);
  assert.strictEqual(driftCount(rows[0]), 0);
});

test('extra, duplicate (same recognizer only) and other-binding sites', () => {
  const rows = computeCoverage(catalog, [...clean, site('go', 'extra'), site('go', 'a.one'), site('go', 'a.two', 0),
    site('python', 'a.one')], bindings);
  assert.deepStrictEqual(rows[1].foundNotDeclared, ['extra']);
  assert.deepStrictEqual(rows[1].duplicates, ['a.one']);
  assert.strictEqual(driftCount(rows[1]), 2);
  assert.strictEqual(rows.length, 2, 'a site of a binding the catalog does not list adds no row');
});

test('DEC-S10 an imported (core) action is no row\'s Declared, Found or drift: the runtime registers it', () => {
  const actions = new Map<string, { bindings: string[]; file?: string }>(catalog.actions);
  actions.set('core.noop', { bindings: ['powershell', 'go'], file: 'C:\\spec\\core.catalog.yaml' });
  const withCore = { ...catalog, actions };
  const rows = computeCoverage(withCore, [...clean, site('go', 'core.noop')], bindings);
  assert.deepStrictEqual(rows.map(r => [r.declared.includes('core.noop'), driftCount(r)]), [[false, 0], [false, 1]]);
  assert.deepStrictEqual(rows[1].foundNotDeclared, ['core.noop'], 'a workspace that registers a core name itself is drift');
});

test('rows: the catalog own bindings only, not the ones an import adds; none listed falls back to all', () => {
  const rows = computeCoverage({ ...catalog, bindings: ['go', 'powershell'], ownBindings: ['go'] }, clean, bindings);
  assert.deepStrictEqual(rows.map(r => r.binding), ['go']);
  assert.deepStrictEqual(expectedBindings({ bindings: ['powershell', 'go'], ownBindings: [] }), ['powershell', 'go']);
  assert.deepStrictEqual(expectedBindings({ bindings: ['powershell', 'go'] }), ['powershell', 'go']);
});

test('a catalog binding with no settings uses its name and no source', () => {
  const rows = computeCoverage({ ...catalog, bindings: ['rust'] }, [], []);
  assert.deepStrictEqual([rows[0].label, rows[0].source, rows[0].declared], ['rust', '', []]);
});

test('globDirectory and commonSource', () => {
  assert.strictEqual(globDirectory('scripts/e2e/actions/*.ps1'), 'scripts/e2e/actions/');
  assert.strictEqual(globDirectory('src/**/*.rs'), 'src/');
  assert.strictEqual(globDirectory('*.cs'), '');
  assert.strictEqual(globDirectory('a/{b,c}/x.go'), 'a/');
  assert.strictEqual(commonSource([]), '');
  assert.strictEqual(commonSource(['a/b/c/*.x', 'a/b/d/*.y']), 'a/b/');
  assert.strictEqual(commonSource(['a/b/*.x', 'z/*.y']), '');
});

test('B4.3 compareProgramSet: agreement and each kind of difference', () => {
  const [ps] = computeCoverage(catalog, clean, bindings);
  const same = compareProgramSet(ps, ['ps.only', 'a.one', 'a.two']);
  assert.strictEqual(programAgrees(same), true);
  assert.deepStrictEqual(same.ok && same.names, ['a.one', 'a.two', 'ps.only']);
  const diff = compareProgramSet({ ...ps, found: ['a.one', 'a.two', 'ps.only', 'src.only'] }, ['a.one', 'prog.only']);
  assert.ok(diff.ok);
  assert.deepStrictEqual(diff.ok && [diff.programOnly, diff.programMissing, diff.notInSource, diff.sourceOnly],
    [['prog.only'], ['a.two', 'ps.only'], ['prog.only'], ['a.two', 'ps.only', 'src.only']]);
  assert.strictEqual(programAgrees(diff), false);
  assert.strictEqual(programAgrees(undefined), undefined);
  assert.strictEqual(programAgrees({ ok: false, failure: 'x' }), false);
});

test('toMarkdownTable: without and with a program column', () => {
  const rows: CoverageRow[] = computeCoverage(catalog, clean, bindings);
  assert.strictEqual(toMarkdownTable(rows), [
    '| Binding | Source | Declared | Found | Drift |',
    '| --- | --- | --- | --- | --- |',
    '| PowerShell | `scripts/e2e/actions/` | 3 | 3 | 0 |',
    '| Go | `test/e2e/bindings/go/` | 2 | 2 | 0 |',
  ].join('\n'));
  rows[0].program = compareProgramSet(rows[0], ['a.one', 'a.two', 'ps.only']);
  rows[1].program = { ok: false, failure: 'not-found' };
  const withProgram = toMarkdownTable([...rows, { ...rows[1], label: 'X', source: '', program: undefined },
    { ...rows[1], label: 'Y', program: compareProgramSet(rows[1], []) }]);
  assert.match(withProgram, /\| Binding \| Source \| Declared \| Found \| Drift \| Program \|/);
  assert.match(withProgram, /\| PowerShell \| .* \| agrees \(3\) \|/);
  assert.match(withProgram, /\| Go \| .* \| failed: not-found \|/);
  assert.match(withProgram, /\| X \|  \| 2 \| 2 \| 0 \|  \|/);
  assert.match(withProgram, /\| Y \| .* \| differs \|/);
});

test('missingImplementations: the bindings with no registration, and of those the ones a stub can be generated for', () => {
  const bindings = [{ name: 'powershell', label: 'PowerShell' }, { name: 'csharp', label: 'C#' }, { name: 'go', label: 'Go' }, { name: 'typescript', label: 'TypeScript' }];
  const r = missingImplementations(['powershell', 'go'], bindings, b => b !== 'typescript');
  assert.deepStrictEqual(r.missing.map(b => b.name), ['csharp', 'typescript']);
  assert.deepStrictEqual(r.generate.map(b => b.name), ['csharp']);
  assert.deepStrictEqual(missingImplementations(bindings.map(b => b.name), bindings, () => true), { missing: [], generate: [] });
});

test("workspaceBindings: the catalog's own bindings in its order, or every configured one when it lists none", () => {
  const configured = [{ name: 'powershell' }, { name: 'csharp' }, { name: 'go' }, { name: 'rust' }, { name: 'typescript' }];
  assert.deepStrictEqual(workspaceBindings(['csharp'], configured).map(b => b.name), ['csharp']);
  assert.deepStrictEqual(workspaceBindings(['go', 'powershell', 'kotlin'], configured).map(b => b.name), ['go', 'powershell']);
  assert.deepStrictEqual(workspaceBindings([], configured).map(b => b.name), configured.map(b => b.name));
  assert.deepStrictEqual(workspaceBindings(undefined, configured).map(b => b.name), configured.map(b => b.name));
});

test('actionStatus: a workspace action by its registrations; an imported (core) one by its catalog bindings, since its runtime registers it', () => {
  const own = { bindings: ['csharp'] };
  assert.strictEqual(actionStatus(own, ['csharp'], 'csharp'), 'implemented');
  assert.strictEqual(actionStatus(own, ['go'], 'csharp'), 'notInTarget');
  assert.strictEqual(actionStatus(own, [], 'csharp'), 'unimplemented', 'the catalog listing csharp does not count for a workspace action');
  const core = { bindings: ['csharp', 'powershell'], file: '/r/core.catalog.yaml' };
  assert.strictEqual(actionStatus(core, [], 'csharp'), 'implemented', 'no workspace registration is needed');
  assert.strictEqual(actionStatus(core, [], 'go'), 'notInTarget');
  assert.strictEqual(actionStatus({ bindings: [], file: '/r/core.catalog.yaml' }, ['csharp'], 'csharp'), 'unimplemented');
});
