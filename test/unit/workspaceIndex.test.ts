// B1.2-B1.5, B1.7-3: WorkspaceIndex joins, staleness, lookups, references.
import * as assert from 'assert';
import * as path from 'path';
import { test } from 'node:test';
import { parseCatalog } from '../../src/core/catalog';
import { fileKey } from '../../src/core/paths';
import { compileRecognizers, scanRegistrations } from '../../src/core/registrations';
import { parseSuite } from '../../src/core/suites';
import { contains, WorkspaceIndex } from '../../src/core/workspaceIndex';
import { DEFAULT_BINDINGS } from '../../src/config/defaults';

const dir = path.resolve('/r/test/e2e/suites');
const f = (name: string) => path.join(dir, name);
const CATALOG = 'bindings: [powershell, go]\nactions:\n  - name: core.noop\n    bindings: [powershell, go]\n  - name: lib.only\n';

const SUITE = `suite: s
imports: [_lib/lib.yml]
tests:
  - name: c
    steps:
      - action: core.noop
      - meta: m
`;
const LIB = `metaSteps:
  - name: m
    steps:
      - action: lib.only
      - action: core.noop
`;
const ORPHAN = 'metaSteps:\n  - name: o\n    steps:\n      - action: core.noop\n';

function build(): WorkspaceIndex {
  const ix = new WorkspaceIndex();
  ix.updateCatalog(parseCatalog(CATALOG, '/r/test/e2e/schema/actions.catalog.yaml'));
  ix.updateSuite(parseSuite(SUITE, f('s.yml')));
  ix.updateSuite(parseSuite(LIB, f('_lib/lib.yml')));
  ix.updateSuite(parseSuite(ORPHAN, f('orphan.yml')));
  const scan = (binding: string, file: string, text: string) =>
    ix.updateSources(file, scanRegistrations(text, file, binding, compileRecognizers(DEFAULT_BINDINGS[binding].recognizers).ok));
  scan('go', '/r/go/a.go', '\t"core.noop": noop,\n');
  scan('powershell', '/r/ps/a.ps1', "Register-LabAction -Name 'core.noop' -Handler {\nRegister-LabAction -Name 'lib.only' -Handler {\n");
  scan('rust', '/r/rs/a.rs', '    map.insert("core.noop", core_noop);\n');
  scan('go', '/r/go/b.go', '\t"core.noop": noopAgain,\n\t"core.noop": thrice,\n');
  return ix;
}

test('contains is inclusive at both ends', () => {
  const r = { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } };
  assert.ok(contains(r, { line: 1, character: 2 }));
  assert.ok(contains(r, { line: 3, character: 4 }));
  assert.ok(contains(r, { line: 2, character: 0 }));
  assert.ok(!contains(r, { line: 1, character: 1 }));
  assert.ok(!contains(r, { line: 3, character: 5 }));
  assert.ok(!contains(r, { line: 0, character: 9 }));
  assert.ok(!contains(r, { line: 4, character: 0 }));
});

test('suites and libraries are indexed; an unimported non-suite is not', () => {
  const ix = build();
  assert.deepStrictEqual(ix.suiteFiles().map(s => path.basename(s.file)).sort(), ['lib.yml', 's.yml']);
  assert.ok(ix.isSuiteOrLibrary(f('_lib/lib.yml')));
  assert.ok(!ix.isSuiteOrLibrary(f('orphan.yml')));
  assert.ok(!ix.isSuiteOrLibrary(f('missing.yml')));
  assert.strictEqual(ix.suite(f('S.yml'.toLowerCase()))!.suiteName, 's');
});

test('B1.5-3 stepsUsing includes library and meta steps, not orphans', () => {
  const ix = build();
  assert.deepStrictEqual(ix.stepsUsing('core.noop').map(s => path.basename(s.file)).sort(), ['lib.yml', 's.yml']);
  assert.strictEqual(ix.stepsUsing('lib.only').length, 1);
  assert.deepStrictEqual(ix.stepsUsing('nope'), []);
});

test('sitesFor orders by catalog binding order, unknown bindings last, then file, then line', () => {
  const ix = build();
  assert.deepStrictEqual(ix.sitesFor('core.noop').map(s => `${s.binding}:${path.basename(s.file)}`),
    ['powershell:a.ps1', 'go:a.go', 'go:b.go', 'go:b.go', 'rust:a.rs']);
  assert.deepStrictEqual(ix.sitesFor('nope'), []);
  assert.strictEqual(ix.allSites().length, 6);
  assert.strictEqual(ix.sitesIn('/r/ps/a.ps1').length, 2);
  assert.deepStrictEqual(ix.sitesIn('/r/none'), []);
});

test('sitesFor without a catalog still works', () => {
  const ix = new WorkspaceIndex();
  ix.updateSources('/a.go', [{ binding: 'go', action: 'x', file: '/a.go', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, recognizer: 0 }]);
  ix.updateSources('/b.go', [{ binding: 'go', action: 'x', file: '/b.go', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, recognizer: 0 }]);
  assert.strictEqual(ix.sitesFor('x').length, 2);
  assert.strictEqual(ix.catalogActionAt('/c', { line: 0, character: 0 }), undefined);
});

test('stepAt, actionNameAt from a step, a catalog name and a site', () => {
  const ix = build();
  const step = ix.stepsUsing('core.noop').find(s => s.file.endsWith('s.yml'))!;
  const at = step.actionRange!.start;
  assert.strictEqual(ix.stepAt(f('s.yml'), at)!.action, 'core.noop');
  assert.strictEqual(ix.actionNameAt(f('s.yml'), at), 'core.noop');
  assert.strictEqual(ix.actionNameAt(f('s.yml'), step.range.start), undefined);
  assert.strictEqual(ix.stepAt(f('orphan.yml'), { line: 3, character: 10 }), undefined);
  assert.strictEqual(ix.stepAt(f('s.yml'), { line: 0, character: 0 }), undefined);
  const entry = ix.catalog!.actions.get('core.noop')!;
  assert.strictEqual(ix.actionNameAt('/r/test/e2e/schema/actions.catalog.yaml', entry.nameRange.start), 'core.noop');
  assert.strictEqual(ix.catalogActionAt('/r/test/e2e/schema/actions.catalog.yaml', { line: 0, character: 0 }), undefined);
  assert.strictEqual(ix.actionNameAt('/r/go/a.go', { line: 0, character: 3 }), 'core.noop');
  assert.strictEqual(ix.actionNameAt('/r/go/a.go', { line: 5, character: 0 }), undefined);
});

test('the smallest step wins: a forStep inside its parent', () => {
  const ix = new WorkspaceIndex();
  ix.updateSuite(parseSuite('suite: x\ntests:\n  - name: c\n    steps:\n      - action: wait\n        forStep:\n          action: core.noop\n', '/w.yml'));
  assert.strictEqual(ix.stepAt('/w.yml', { line: 6, character: 20 })!.action, 'core.noop');
  assert.strictEqual(ix.stepAt('/w.yml', { line: 4, character: 16 })!.action, 'wait');
});

test('B1.3-4 a failed parse keeps the previous index, marked stale; a good parse clears it', () => {
  const ix = build();
  ix.updateSuite(parseSuite('suite: [broken\n', f('s.yml')));
  assert.ok(ix.isStale(f('s.yml')));
  assert.strictEqual(ix.suite(f('s.yml'))!.parseError!.code, 'BDD030');
  assert.strictEqual(ix.stepsUsing('core.noop').length, 2);
  ix.updateSuite(parseSuite(SUITE, f('s.yml')));
  assert.ok(!ix.isStale(f('s.yml')));
  const fresh = new WorkspaceIndex();
  fresh.updateSuite(parseSuite('suite: [broken\n', '/n.yml'));
  assert.ok(!fresh.isStale('/n.yml'));
});

test('a failed catalog parse keeps the previous catalog, marked stale', () => {
  const ix = build();
  ix.updateCatalog(parseCatalog('actions: [x\n', '/r/test/e2e/schema/actions.catalog.yaml'));
  assert.ok(ix.catalogStale);
  assert.ok(ix.catalog!.actions.has('core.noop'));
  assert.strictEqual(ix.catalog!.errors[0].code, 'BDD022');
  ix.updateCatalog(parseCatalog(CATALOG, '/r/test/e2e/schema/actions.catalog.yaml'));
  assert.ok(!ix.catalogStale);
  const fresh = new WorkspaceIndex();
  fresh.updateCatalog(parseCatalog('actions: [x\n', '/c.yaml'));
  assert.ok(!fresh.catalogStale);
});

test('remove suites and sources; listeners fire; dispose stops them', () => {
  const ix = build();
  let fired = 0;
  const sub = ix.onDidChange(() => fired++);
  ix.removeSuite(f('_lib/lib.yml'));
  ix.removeSources('/r/go/b.go');
  assert.strictEqual(fired, 2);
  assert.strictEqual(ix.sitesFor('core.noop').length, 3);
  assert.strictEqual(ix.sitesIn('/r/go/b.go').length, 0);
  assert.deepStrictEqual(ix.stepsUsing('lib.only'), []);
  sub.dispose();
  ix.removeSuite(f('s.yml'));
  assert.strictEqual(fired, 2);
});

test('B1.7-3 a burst of 50 updates produces one join rebuild', () => {
  const ix = build();
  ix.stepsUsing('core.noop');
  const before = ix.rebuildCount;
  for (let i = 0; i < 50; i++) ix.updateSuite(parseSuite(SUITE, f(`burst${i}.yml`)));
  ix.stepsUsing('core.noop');
  ix.sitesFor('core.noop');
  assert.strictEqual(ix.rebuildCount, before + 1);
});

test('fileKey makes differently-spelled paths one key', () => {
  const ix = build();
  assert.ok(ix.isSuiteOrLibrary(fileKey(f('s.yml'))));
});

test('isLintCandidate: suites, libraries, files that do not parse, and non-mapping roots; not other mappings', () => {
  const ix = build();
  assert.ok(ix.isLintCandidate(f('s.yml')));
  assert.ok(ix.isLintCandidate(f('_lib/lib.yml')));
  assert.ok(!ix.isLintCandidate(f('orphan.yml')));
  assert.ok(!ix.isLintCandidate(f('missing.yml')));
  ix.updateSuite(parseSuite('suite: [broken\n', f('broken.yml')));
  assert.ok(ix.isLintCandidate(f('broken.yml')));
  ix.updateSuite(parseSuite('- a\n- b\n', f('list.yml')));
  assert.ok(ix.isLintCandidate(f('list.yml')));
  assert.strictEqual(ix.suite(f('list.yml'))!.notAMapping, true);
});

test('B8.2 importersOf: direct and transitive importers, sorted; a cycle ends; an unimported file has none', () => {
  const ix = new WorkspaceIndex();
  ix.updateSuite(parseSuite('suite: a\nimports: [_lib/mid.yml]\ntests: []\n', f('a.yml')));
  ix.updateSuite(parseSuite('suite: b\nimports: [_lib/leaf.yml]\ntests: []\n', f('b.yml')));
  ix.updateSuite(parseSuite('imports: [leaf.yml]\nmetaSteps: []\n', f('_lib/mid.yml')));
  ix.updateSuite(parseSuite('imports: [mid.yml]\nmetaSteps: []\n', f('_lib/leaf.yml')));
  ix.updateSuite(parseSuite('suite: c\ntests: []\n', f('c.yml')));
  assert.deepStrictEqual(ix.importersOf(f('_lib/leaf.yml')), [f('_lib/mid.yml'), f('a.yml'), f('b.yml')].map(fileKey).sort());
  assert.deepStrictEqual(ix.importersOf(f('_lib/MID.yml'.toLowerCase())), [f('_lib/leaf.yml'), f('a.yml'), f('b.yml')].map(fileKey).sort());
  assert.deepStrictEqual(ix.importersOf(f('c.yml')), []);
});
