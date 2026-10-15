// B1.1: findRepositoryRoot, readSettings, WorkspaceLayout, package.json defaults.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { DEFAULT_BINDINGS, DEFAULT_SETTINGS } from '../../src/config/defaults';
import { fileKey, findRepositoryRoot, readSettings, WorkspaceLayout } from '../../src/config/layout';
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
    'lab.apiUrl': 'u', 'lab.labId': 'l', 'lab.connectionFile': 'c',
  };
  const { settings, messages } = readSettings(k => values[k]);
  assert.deepStrictEqual(messages, []);
  for (const [k, v] of Object.entries(values)) assert.deepStrictEqual((settings as unknown as Record<string, unknown>)[k], v);
});

test('B1.1-4 every wrong type is ignored with a BDD010 message', () => {
  const values: Record<string, unknown> = {
    catalogPath: 1, suiteGlobs: 'x', exclude: [], lintTool: null, targetBinding: true, templatesDir: {},
    'lab.apiUrl': 2, 'lab.labId': 3, 'lab.connectionFile': 4, schemaGenerator: [1], 'inlayHints.bindings': 'yes', 'codeLens.implement': 1,
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
      build: { command: 'make', cwd: '.', shell: true }, kind: 'suiterun', library: 'lib.js' },
  } : undefined));
  assert.deepStrictEqual(messages, []);
  assert.deepStrictEqual(settings.bindings.go.tool, ['/bin/suiterun']);
  assert.strictEqual(settings.bindings.go.label, 'Golang');
  assert.strictEqual(settings.bindings.go.library, 'lib.js');
  assert.deepStrictEqual(settings.bindings.go.sources, DEFAULT_BINDINGS.go.sources);
  assert.deepStrictEqual(settings.bindings.go.build, { command: 'make', cwd: '.', shell: true });
  assert.deepStrictEqual(settings.bindings.rust, DEFAULT_BINDINGS.rust);
});

test('readSettings: a new binding starts empty', () => {
  const { settings } = readSettings(k => (k === 'bindings' ? { python: { sources: ['py/**/*.py'] } } : undefined));
  assert.deepStrictEqual(settings.bindings.python, {
    label: 'python', abbreviation: 'python', kind: 'suiterun', sources: ['py/**/*.py'], exclude: [], recognizers: [], tool: [],
  });
});

test('B1.1-4 wrong binding fields are reported each', () => {
  const { settings, messages } = readSettings(k => (k === 'bindings' ? {
    go: { label: 1, kind: 'other', sources: 'x', recognizers: [{ flags: 'i' }], build: { command: 1 } },
    rust: 'nope',
    python: 5,
  } : undefined));
  assert.deepStrictEqual(settings.bindings.go, DEFAULT_BINDINGS.go);
  assert.deepStrictEqual(settings.bindings.rust, DEFAULT_BINDINGS.rust);
  assert.strictEqual(settings.bindings.python, undefined);
  assert.deepStrictEqual(messages.map(m => m.split(':')[0]), [
    'BDD010 bddSuite.bindings.go.label', 'BDD010 bddSuite.bindings.go.kind', 'BDD010 bddSuite.bindings.go.sources',
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

test('WorkspaceLayout is undefined without a catalog, or without a root above it', () => {
  assert.strictEqual(WorkspaceLayout.create(ROOT, DEFAULT_SETTINGS, '/s', () => false), undefined);
  const catalog = path.join(ROOT, 'test', 'e2e', 'schema', 'actions.catalog.yaml');
  assert.strictEqual(WorkspaceLayout.create(ROOT, DEFAULT_SETTINGS, '/s', has(catalog)), undefined);
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
