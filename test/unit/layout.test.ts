// B1.1: findRepositoryRoot, readSettings, WorkspaceLayout, package.json defaults.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { DEFAULT_BINDINGS, DEFAULT_SETTINGS } from '../../src/config/defaults';
import { catalogSourceGlobs, fileKey, findRepositoryRoot, readSettings, servingLayout, WorkspaceLayout } from '../../src/config/layout';
import { configurationContribution } from '../../src/config/packageConfig';

const ROOT = path.resolve('/repo');
const has = (...dirs: string[]) => (p: string) => dirs.map(d => fileKey(d)).includes(fileKey(p));

test('B1.1-3 root found at depth 0', () => {
  assert.strictEqual(findRepositoryRoot(ROOT, has('/repo/test/e2e/schema')), ROOT);
});

test('B1.1-3 root found at depth 3', () => {
  assert.strictEqual(findRepositoryRoot('/repo/a/b/c', has('/repo/test/e2e/schema')), ROOT);
});

test('B1.1-3 nearest ancestor wins', () => {
  assert.strictEqual(findRepositoryRoot('/repo/a/b', has('/repo/test/e2e/schema', '/repo/a/test/e2e/schema')),
    path.resolve('/repo/a'));
});

test('B1.1-3 no root', () => {
  assert.strictEqual(findRepositoryRoot('/repo/a', () => false), undefined);
});

// A folder whose settings name a catalog in one suite tree, holding a second tree.
const fixtureRoot = fileKey('/repo/fixture');
const sampleRoot = fileKey('/repo/samples/workspace');
const repoLayout = { folder: fileKey('/repo'), root: fixtureRoot };
const twoTrees = has('/repo/fixture/test/e2e/schema', '/repo/samples/workspace/test/e2e/schema');

test('servingLayout: a suite under the catalog\'s own root is served', () => {
  assert.strictEqual(servingLayout('/repo/fixture/test/e2e/suites/a.yml', [repoLayout], twoTrees), repoLayout);
});

test('servingLayout: a suite under another root in the same folder is not served by this catalog', () => {
  assert.strictEqual(servingLayout('/repo/samples/workspace/test/e2e/suites/checkout.yml', [repoLayout], twoTrees), undefined);
});

test('servingLayout: a folder opened on the other tree serves it, though an outer folder holds it too', () => {
  const sample = { folder: sampleRoot, root: sampleRoot };
  assert.strictEqual(servingLayout('/repo/samples/workspace/test/e2e/suites/checkout.yml', [repoLayout, sample], twoTrees), sample);
  assert.strictEqual(servingLayout('/repo/fixture/test/e2e/suites/a.yml', [repoLayout, sample], twoTrees), repoLayout);
});

test('servingLayout: a file with no root above it falls to the innermost folder; outside every folder, none', () => {
  assert.strictEqual(servingLayout('/repo/src/x.ts', [repoLayout], twoTrees), repoLayout);
  assert.strictEqual(servingLayout('/elsewhere/x.yml', [repoLayout], twoTrees), undefined);
});

test('servingLayout: a layout whose own root holds the file serves it, unless a test/e2e/schema tree nearer the file does', () => {
  // update2: the root is src/BVT (no test/e2e/schema), and the repository also has an outer test/e2e/schema.
  const bvt = { folder: fileKey('/repo'), root: fileKey('/repo/src/BVT') };
  const outer = has('/repo/test/e2e/schema', '/repo/src/BVT/x/test/e2e/schema');
  assert.strictEqual(servingLayout('/repo/src/BVT/suites/a.yml', [bvt], outer), bvt);
  assert.strictEqual(servingLayout('/repo/src/BVT/suites/a.yml', [bvt], () => false), bvt);
  assert.strictEqual(servingLayout('/repo/src/BVT/x/test/e2e/suites/b.yml', [bvt], outer), undefined, "a nearer tree is another catalog's");
  assert.strictEqual(servingLayout('/repo/other/c.yml', [bvt], outer), undefined, 'under the outer tree, not this root');
});

test('fileKey lowercases a drive letter only', () => {
  const k = fileKey('C:\\X\\Y');
  if (process.platform === 'win32') assert.strictEqual(k, 'c:\\X\\Y');
  assert.strictEqual(fileKey('/x/Y').endsWith('Y'), true);
});

test('readSettings: nothing set gives the defaults and no messages', () => {
  const { settings, messages } = readSettings(() => undefined);
  assert.deepStrictEqual(settings, DEFAULT_SETTINGS);
  assert.deepStrictEqual(messages, []);
});

test('readSettings: right types are taken', () => {
  const values: Record<string, unknown> = {
    catalogPath: 'x.yaml', suiteGlobs: ['a/*.yml'], exclude: 'e', lintTool: 'rust', targetBinding: 'go',
    schemaGenerator: ['gen'], 'inlayHints.bindings': false, 'codeLens.implement': false, templatesDir: 't',
    'lab.apiUrl': 'u', 'lab.labId': 'l', 'lab.connectionFile': 'c', 'lab.required': ['labId'],
  };
  const { settings, messages } = readSettings(k => values[k]);
  assert.deepStrictEqual(messages, []);
  for (const [k, v] of Object.entries(values)) assert.deepStrictEqual((settings as unknown as Record<string, unknown>)[k], v);
});

test('lab.required: only the three lab keys are accepted; a binding may declare events', () => {
  const bad = readSettings(k => (k === 'lab.required' ? ['labId', 'password'] : undefined));
  assert.deepStrictEqual(bad.settings['lab.required'], DEFAULT_SETTINGS['lab.required']);
  assert.strictEqual(bad.messages.length, 1);
  assert.match(bad.messages[0], /^BDD010 bddSuite\.lab\.required: expected \(apiUrl \| labId \| connectionFile\)\[\]/);
  const empty = readSettings(k => (k === 'lab.required' ? [] : undefined));
  assert.deepStrictEqual(empty.settings['lab.required'], []);
  const withEvents = readSettings(k => (k === 'bindings' ? { csharp: { events: true }, go: { events: 'yes' } } : undefined));
  assert.strictEqual(withEvents.settings.bindings.csharp.events, true);
  assert.strictEqual(withEvents.settings.bindings.go.events, undefined);
  assert.strictEqual(withEvents.messages.length, 1);
  assert.match(withEvents.messages[0], /bddSuite\.bindings\.go\.events: expected boolean/);
});

test('B1.1-4 every wrong type is ignored with a BDD010 message', () => {
  const values: Record<string, unknown> = {
    catalogPath: 1, suiteGlobs: 'x', exclude: [], lintTool: null, targetBinding: true, templatesDir: {},
    'lab.apiUrl': 2, 'lab.labId': 3, 'lab.connectionFile': 4, 'lab.required': 'labId', schemaGenerator: [1], 'inlayHints.bindings': 'yes', 'codeLens.implement': 1,
    bindings: [],
  };
  const { settings, messages } = readSettings(k => values[k]);
  assert.deepStrictEqual(settings, DEFAULT_SETTINGS);
  assert.strictEqual(messages.length, Object.keys(values).length);
  for (const m of messages) assert.match(m, /^BDD010 bddSuite\.\S+: expected .+, got .+; using the default\.$/);
  assert.ok(messages.some(m => m.includes('got null')));
  assert.ok(messages.some(m => m.includes('bddSuite.bindings: expected object, got array')));
});

test('readSettings: a binding overrides its default field by field', () => {
  const { settings, messages } = readSettings(k => (k === 'bindings' ? {
    go: { tool: ['/bin/suiterun'], label: 'Golang', recognizers: [{ pattern: '(?<name>x)', flags: 'i' }],
      build: { command: 'make', cwd: '.', shell: true }, selectsOneCase: true, library: 'lib.js' },
  } : undefined));
  assert.deepStrictEqual(messages, []);
  assert.deepStrictEqual(settings.bindings.go.tool, ['/bin/suiterun']);
  assert.strictEqual(settings.bindings.go.label, 'Golang');
  assert.strictEqual(settings.bindings.go.library, 'lib.js');
  assert.strictEqual(settings.bindings.go.selectsOneCase, true);
  assert.strictEqual(DEFAULT_BINDINGS.powershell.selectsOneCase, true, 'only the PowerShell runtime runs one case by name by default');
  assert.deepStrictEqual(settings.bindings.go.sources, DEFAULT_BINDINGS.go.sources);
  assert.deepStrictEqual(settings.bindings.go.build, { command: 'make', cwd: '.', shell: true });
  assert.deepStrictEqual(settings.bindings.rust, DEFAULT_BINDINGS.rust);
});

test('readSettings: a new binding starts empty', () => {
  const { settings } = readSettings(k => (k === 'bindings' ? { python: { sources: ['py/**/*.py'] } } : undefined));
  assert.deepStrictEqual(settings.bindings.python, {
    label: 'python', abbreviation: 'python', sources: ['py/**/*.py'], exclude: [], recognizers: [], tool: [],
  });
});

test('B1.1-4 wrong binding fields are reported each', () => {
  const { settings, messages } = readSettings(k => (k === 'bindings' ? {
    go: { label: 1, selectsOneCase: 'yes', sources: 'x', recognizers: [{ flags: 'i' }], build: { command: 1 } },
    rust: 'nope',
    python: 5,
  } : undefined));
  assert.deepStrictEqual(settings.bindings.go, DEFAULT_BINDINGS.go);
  assert.deepStrictEqual(settings.bindings.rust, DEFAULT_BINDINGS.rust);
  assert.strictEqual(settings.bindings.python, undefined);
  assert.deepStrictEqual(messages.map(m => m.split(':')[0]), [
    'BDD010 bddSuite.bindings.go.label', 'BDD010 bddSuite.bindings.go.selectsOneCase', 'BDD010 bddSuite.bindings.go.sources',
    'BDD010 bddSuite.bindings.go.recognizers', 'BDD010 bddSuite.bindings.go.build',
    'BDD010 bddSuite.bindings.rust', 'BDD010 bddSuite.bindings.python',
  ]);
});

test('WorkspaceLayout resolves the catalog, root and ${storage}', () => {
  const catalog = path.join(ROOT, 'test', 'e2e', 'schema', 'actions.catalog.yaml');
  const exists = has(catalog, '/repo/test/e2e/schema');
  const layout = WorkspaceLayout.create(ROOT, DEFAULT_SETTINGS, '/store', exists)!;
  assert.strictEqual(layout.catalogPath, fileKey(catalog));
  assert.strictEqual(layout.root, fileKey(ROOT));
  assert.strictEqual(layout.folder, fileKey(ROOT));
  const go = layout.bindings.find(b => b.name === 'go')!;
  assert.deepStrictEqual(go.tool, ['/store/go/suiterun.exe']);
  assert.strictEqual(go.build!.command, 'go build -o /store/go/suiterun.exe ./cmd/suiterun');
  assert.strictEqual(layout.bindings.find(b => b.name === 'powershell')!.build, undefined);
  assert.deepStrictEqual(layout.suiteGlobs, DEFAULT_SETTINGS.suiteGlobs);
  assert.strictEqual(layout.exclude, DEFAULT_SETTINGS.exclude);
});

test('WorkspaceLayout: the catalog\'s bindingSources replace a binding\'s sources and add a binding the settings lack', () => {
  const catalog = path.join(ROOT, 'test', 'e2e', 'schema', 'actions.catalog.yaml');
  const sources = { csharp: ['../bindings/dotnet/Shop.Suite/**/*.cs'], cobol: ['../bindings/cobol/*.cbl', '../../../../outside/*.cbl'] };
  const layout = WorkspaceLayout.create(ROOT, DEFAULT_SETTINGS, '/store', has(catalog, '/repo/test/e2e/schema'), sources)!;
  assert.deepStrictEqual(layout.bindings.find(b => b.name === 'csharp')!.sources, ['test/e2e/bindings/dotnet/Shop.Suite/**/*.cs']);
  assert.deepStrictEqual(layout.bindings.find(b => b.name === 'csharp')!.recognizers, DEFAULT_BINDINGS.csharp.recognizers, 'only sources change');
  assert.deepStrictEqual(layout.bindings.find(b => b.name === 'go')!.sources, DEFAULT_BINDINGS.go.sources, 'a binding it does not name keeps its setting');
  const cobol = layout.bindings.find(b => b.name === 'cobol')!;
  assert.deepStrictEqual([cobol.label, cobol.sources, cobol.recognizers], ['cobol', ['test/e2e/bindings/cobol/*.cbl'], []]);
  assert.strictEqual(layout.catalogSources, sources);
});

test('catalogSourceGlobs: relative to the catalog, forward slashes; absolute or outside the folder is skipped', () => {
  const catalog = path.join(ROOT, 'test', 'e2e', 'schema', 'actions.catalog.yaml');
  const r = catalogSourceGlobs(ROOT, catalog, { csharp: ['../bindings/**/*.cs', path.resolve('/elsewhere/*.cs'), '../../../../up/*.cs'], go: ['../../../../up/*.go'] });
  assert.deepStrictEqual(r.globs, { csharp: ['test/e2e/bindings/**/*.cs'] }, 'a binding left with no glob is dropped');
  assert.deepStrictEqual(r.skipped, [`csharp: ${path.resolve('/elsewhere/*.cs')}`, 'csharp: ../../../../up/*.cs', 'go: ../../../../up/*.go']);
});

test('WorkspaceLayout is undefined without a catalog', () => {
  assert.strictEqual(WorkspaceLayout.create(ROOT, DEFAULT_SETTINGS, '/s', () => false), undefined);
});

test('a catalog outside test/e2e/schema: the root is the folder above its folder, and every binding gets schemaRoot', () => {
  // update2's layout: src/.../EnvironmentTest/BVT/{schema,suites,bindings}, named by bddSuite.catalogPath.
  const settings = { ...DEFAULT_SETTINGS, catalogPath: 'src/EnvironmentTest/BVT/schema/actions.catalog.yaml' };
  const catalog = path.join(ROOT, 'src', 'EnvironmentTest', 'BVT', 'schema', 'actions.catalog.yaml');
  const layout = WorkspaceLayout.create(ROOT, settings, '/s', has(catalog))!;
  assert.strictEqual(layout.catalogPath, fileKey(catalog));
  assert.strictEqual(layout.root, fileKey(path.join(ROOT, 'src', 'EnvironmentTest', 'BVT')));
  assert.strictEqual(layout.folder, fileKey(ROOT));
  for (const b of layout.bindings) {
    assert.strictEqual(b.schemaRoot, path.dirname(fileKey(catalog)), b.name);
  }
});

test('a catalog under test/e2e/schema keeps the usual root, and no binding gets schemaRoot', () => {
  const catalog = path.join(ROOT, 'test', 'e2e', 'schema', 'actions.catalog.yaml');
  const layout = WorkspaceLayout.create(ROOT, DEFAULT_SETTINGS, '/s', has(catalog, '/repo/test/e2e/schema'))!;
  assert.strictEqual(layout.root, fileKey(ROOT));
  assert.ok(layout.bindings.every(b => !('schemaRoot' in b)), 'the usual layout runs the command lines it always did');
});

test("bddSuite.root names the root: tool paths and cwd are relative to it, and schemaRoot is the catalog's folder", () => {
  const settings = { ...DEFAULT_SETTINGS, catalogPath: 'svc/BVT/catalog/actions.catalog.yaml', root: 'svc' };
  const catalog = path.join(ROOT, 'svc', 'BVT', 'catalog', 'actions.catalog.yaml');
  const layout = WorkspaceLayout.create(ROOT, settings, '/s', has(catalog))!;
  assert.strictEqual(layout.root, fileKey(path.join(ROOT, 'svc')));
  assert.strictEqual(layout.schemaRoot, path.dirname(fileKey(catalog)));
  assert.ok(layout.bindings.every(b => b.schemaRoot === layout.schemaRoot));
});

test('bddSuite.root wins over a test/e2e/schema above the catalog; a catalog in <root>/test/e2e/schema needs no schemaRoot', () => {
  const catalog = path.join(ROOT, 'a', 'test', 'e2e', 'schema', 'actions.catalog.yaml');
  const exists = has(catalog, '/repo/test/e2e/schema', '/repo/a/test/e2e/schema');
  const settings = { ...DEFAULT_SETTINGS, catalogPath: 'a/test/e2e/schema/actions.catalog.yaml' };
  const found = WorkspaceLayout.create(ROOT, settings, '/s', exists)!;
  assert.deepStrictEqual([found.root, found.schemaRoot], [fileKey(path.join(ROOT, 'a')), undefined]);
  const named = WorkspaceLayout.create(ROOT, { ...settings, root: '.' }, '/s', exists)!;
  assert.deepStrictEqual([named.root, named.schemaRoot], [fileKey(ROOT), path.dirname(fileKey(catalog))]);
});

test("readSettings: root and a binding's stubFile are read, and refused when not strings", () => {
  const ok = readSettings(k => ({ root: 'svc', bindings: { csharp: { stubFile: 'b/Actions.cs' } } } as Record<string, unknown>)[k]);
  assert.deepStrictEqual([ok.settings.root, ok.settings.bindings.csharp.stubFile, ok.messages], ['svc', 'b/Actions.cs', []]);
  const bad = readSettings(k => ({ root: 1, bindings: { csharp: { stubFile: [] } } } as Record<string, unknown>)[k]);
  assert.strictEqual(bad.settings.root, '');
  assert.strictEqual(bad.settings.bindings.csharp.stubFile, undefined);
  assert.strictEqual(bad.messages.length, 2, bad.messages.join('\n'));
});

test('package.json carries exactly the generated configuration (sync-defaults --check)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
  assert.deepStrictEqual(pkg.contributes.configuration, configurationContribution());
});

test('recognizer prefix: a string is kept, anything else is reported', () => {
  const ok = readSettings(k => (k === 'bindings' ? { go: { recognizers: [{ pattern: '(?<name>x)', prefix: 'p.' }] } } : undefined));
  assert.deepStrictEqual(ok.messages, []);
  assert.strictEqual(ok.settings.bindings.go.recognizers[0].prefix, 'p.');
  const bad = readSettings(k => (k === 'bindings' ? { go: { recognizers: [{ pattern: '(?<name>x)', prefix: 1 }] } } : undefined));
  assert.match(bad.messages[0], /bindings\.go\.recognizers: expected \{ pattern, flags\?, prefix\? \}\[\]/);
});

test('lowerDrive lowercases a drive letter and leaves other paths alone', async () => {
  const { lowerDrive } = await import('../../src/core/paths');
  assert.strictEqual(lowerDrive('C:\\x'), 'c:\\x');
  assert.strictEqual(lowerDrive('/usr/X'), '/usr/X');
});
