// docs/packages, D12 and D13: what the extension carries (the core, the schema
// generator, the runtime), the layout that names them, and the warning for a
// workspace pinning another release's packages.
import * as assert from 'assert';
import * as path from 'path';
import { test } from 'node:test';
import { bundledFiles, expandArgv, lintLibrary } from '../../src/config/bundled';
import { DEFAULT_SETTINGS } from '../../src/config/defaults';
import { WorkspaceLayout } from '../../src/config/layout';
import { pinnedVersions, versionWarning } from '../../src/config/packageVersions';
import { fileKey } from '../../src/core/paths';

const EXT = path.resolve('/ext');
const WS = path.resolve('/ws');

test('D12 the bundled core, generator and runtime are under the extension folder', () => {
  assert.deepStrictEqual(bundledFiles(EXT), {
    core: path.join(EXT, 'spec', 'core.catalog.yaml'),
    generator: path.join(EXT, 'spec', 'Build-Schema.ps1'),
    runtime: path.join(EXT, 'dist', 'runtime', 'index.mjs'),
  });
});

test('D12 ${extension} and ${catalogPath} in an argv; ${extension} kept without an install folder', () => {
  assert.deepStrictEqual(expandArgv(['pwsh', '-File', '${extension}/spec/Build-Schema.ps1', '-Catalog', '${catalogPath}', 'x'], '/c.yaml', '/e'),
    ['pwsh', '-File', '/e/spec/Build-Schema.ps1', '-Catalog', '/c.yaml', 'x']);
  assert.deepStrictEqual(expandArgv(['${extension}/g', '${catalogPath}'], '/c.yaml'), ['${extension}/g', '/c.yaml']);
});

test('D12 the default generator is the bundled Build-Schema.ps1 on the catalog; the layout fills it in and names the bundled files', () => {
  const exists = (p: string) => [path.join(WS, 'test/e2e/schema'), path.join(WS, 'test/e2e/schema/actions.catalog.yaml')].map(fileKey).includes(fileKey(p));
  const layout = WorkspaceLayout.create(WS, DEFAULT_SETTINGS, '/s', exists, undefined, EXT)!;
  assert.deepStrictEqual(layout.schemaGenerator, ['pwsh', '-NoProfile', '-NonInteractive', '-File', `${EXT}/spec/Build-Schema.ps1`, '-Catalog', layout.catalogPath]);
  assert.deepStrictEqual(layout.bundled, bundledFiles(EXT));
  const bare = WorkspaceLayout.create(WS, { ...DEFAULT_SETTINGS, schemaGenerator: ['gen', '${catalogPath}'] }, '/s', exists)!;
  assert.strictEqual(bare.bundled, undefined);
  assert.deepStrictEqual(bare.schemaGenerator, ['gen', bare.catalogPath]);
});

test('D13 the lint library: the workspace\'s when it exists, else the bundled runtime for the TypeScript tool only', () => {
  const has = (...files: string[]) => (p: string) => files.includes(p);
  assert.deepStrictEqual(lintLibrary('/ws/lib.js', 'typescript', '/ext/rt.mjs', has('/ws/lib.js', '/ext/rt.mjs')), { path: '/ws/lib.js', bundled: false });
  assert.deepStrictEqual(lintLibrary('/ws/lib.js', 'typescript', '/ext/rt.mjs', has('/ext/rt.mjs')), { path: '/ext/rt.mjs', bundled: true });
  assert.deepStrictEqual(lintLibrary('/ws/lib.js', 'other', '/ext/rt.mjs', has('/ext/rt.mjs')), { path: '/ws/lib.js', bundled: false }, 'another tool');
  assert.deepStrictEqual(lintLibrary('/ws/lib.js', 'typescript', undefined, has()), { path: '/ws/lib.js', bundled: false }, 'no install folder');
  assert.deepStrictEqual(lintLibrary('/ws/lib.js', 'typescript', '/ext/rt.mjs', has()), { path: '/ws/lib.js', bundled: false }, 'no bundle built');
});

const MANIFESTS: Record<string, string> = {
  'Directory.Packages.props': '<Project>\n  <PropertyGroup>\n    <BddSuiteVersion Condition="\'$(BddSuiteVersion)\' == \'\'">0.7.0</BddSuiteVersion>\n  </PropertyGroup>\n</Project>\n',
  'go.mod': 'module example.com/greeter\n\nrequire github.com/smartpcr/bdd-code-extension/runtimes/go v0.7.1\n',
  'Cargo.toml': '[dependencies]\nsuiterun = { version = "0.7.1", features = ["testing"] }\n',
  'package.json': '{ "devDependencies": { "@bdd-suite/runtime": "^0.7.1" } }',
  'suiterun.ps1': "#Requires -Modules @{ ModuleName = 'BddSuite'; RequiredVersion = '0.6.10' }\n",
  'Other.psd1': "@{ RequiredModules = @(@{ ModuleName = 'BddSuite'; ModuleVersion = '0.7.1' }) }",
  'README.md': 'suiterun = "0.1.0"',
  'unreadable.psd1': '',
};

test('D12 the pinned versions: every manifest kind at the top of each folder, read by text, each folder once', () => {
  const list = (dir: string) => (dir === WS ? Object.keys(MANIFESTS) : dir === '/gone' ? [] : ['Cargo.toml']);
  const read = (f: string) => (path.basename(f) === 'unreadable.psd1' ? undefined : path.dirname(f) === WS ? MANIFESTS[path.basename(f)] : 'suiterun = "0.7.1"\n');
  const pins = pinnedVersions([WS, WS, '/gone', '/other'], list, read).map(p => `${path.basename(p.file)} ${p.package} ${p.version}`);
  assert.deepStrictEqual(pins, [
    'Cargo.toml suiterun 0.7.1',
    'Directory.Packages.props Bdd.Suite 0.7.0',
    'Other.psd1 BddSuite 0.7.1',
    'go.mod github.com/smartpcr/bdd-code-extension/runtimes/go 0.7.1',
    'package.json @bdd-suite/runtime 0.7.1',
    'suiterun.ps1 BddSuite 0.6.10',
    'Cargo.toml suiterun 0.7.1',
  ]);
  const item = pinnedVersions([WS], () => ['Directory.Packages.props'], () => '<PackageVersion Include="Smartpcr.BddSuite.Testing" Version="0.7.5" />');
  assert.deepStrictEqual(item.map(p => `${p.package} ${p.version}`), ['Smartpcr.BddSuite 0.7.5'], 'a PackageVersion item');
  const old = pinnedVersions([WS], () => ['Directory.Packages.props'], () => '<PackageVersion Include="Bdd.Suite.Testing" Version="0.7.2" />');
  assert.deepStrictEqual(old.map(p => `${p.package} ${p.version}`), ['Bdd.Suite 0.7.2'], 'the name GitHub Packages had before 0.7.4');
});

test('D12 the warning names each pin of another release, and there is none when all agree', () => {
  const pins = [{ file: '/ws/go.mod', package: 'go', version: '0.7.1' }, { file: '/ws/Directory.Packages.props', package: 'Bdd.Suite', version: '0.7.0' }];
  assert.match(versionWarning('0.7.1', pins)!, /^This workspace pins bdd-suite packages at another release than Suite Authoring 0\.7\.1 \(Directory\.Packages\.props: Bdd\.Suite 0\.7\.0\)\. /);
  assert.strictEqual(versionWarning('0.7.1', pins.slice(0, 1)), undefined);
  assert.strictEqual(versionWarning('0.7.1', []), undefined);
});
