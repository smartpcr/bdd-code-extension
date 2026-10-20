// docs/packages, D14: lockstep versions. Each kind of file gives up its version
// and takes a new one without any other change, and the check and the stamp
// report what they find. The last test reads this repository's own files.
import * as assert from 'assert';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import {
  isReleaseVersion, stampVersions, VERSION_FILES, versionProblems, versionsIn, withVersion, type VersionFile, type VersionKind,
} from '../../src/tools/versions';

const repo = path.resolve(__dirname, '..', '..', '..');

const SAMPLES: Record<VersionKind, string> = {
  'csharp-props': '<Project>\n  <PropertyGroup>\n    <Version>0.1.0</Version>\n  </PropertyGroup>\n</Project>\n',
  'cargo-toml': '[package]\nname = "suiterun"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nregex = { version = "1" }\n',
  'cargo-lock': '[[package]]\nname = "regex"\nversion = "1.11.1"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "suiterun"\nversion = "0.1.0"\ndependencies = [\n "regex",\n]\n',
  'npm-package': '{\n  "name": "@bdd-suite/runtime",\n  "version": "0.1.0",\n  "dependencies": {\n    "yaml": "^2.8.1"\n  },\n  "devDependencies": { "x": { "version": "9.9.9" } }\n}\n',
  'npm-lock': `${JSON.stringify({
    name: 'consumer', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'consumer', version: '1.0.0' }, '../runtimes/typescript': { name: '@bdd-suite/runtime', version: '0.1.0' }, 'node_modules/yaml': { version: '2.8.1' } },
  }, null, 2)}\n`,
  'psd1': "@{\n    RootModule        = 'BddSuite.psm1'\n    ModuleVersion     = '0.1.0'\n    PowerShellVersion = '7.2'\n}\n",
};

test('D14 a release version is x.y.z, with an optional pre-release', () => {
  for (const yes of ['0.7.0', '1.0.0-rc.1', '10.20.30']) assert.ok(isReleaseVersion(yes), yes);
  for (const no of ['0.7', 'v0.7.0', '0.7.0+build', '']) assert.ok(!isReleaseVersion(no), no);
});

test('D14 each kind of file gives up its own version and takes a new one, changing nothing else', () => {
  for (const [kind, text] of Object.entries(SAMPLES) as [VersionKind, string][]) {
    assert.deepStrictEqual(versionsIn(kind, text), ['0.1.0'], kind);
    const stamped = withVersion(kind, text, '0.7.0');
    assert.deepStrictEqual(versionsIn(kind, stamped), ['0.7.0'], kind);
    assert.strictEqual(stamped, text.split('0.1.0').join('0.7.0'), `${kind}: only the version changed`);
  }
});

test('D14 an npm lock: the root when it is the runtime, every entry named after it, its line ends kept, and no rewrite when nothing changes', () => {
  const runtime = `${JSON.stringify({ name: '@bdd-suite/runtime', version: '0.1.0', packages: { '': { name: '@bdd-suite/runtime', version: '0.1.0' } } }, null, 2)}\n`;
  assert.deepStrictEqual(versionsIn('npm-lock', runtime), ['0.1.0', '0.1.0']);
  const crlf = runtime.replace(/\n/g, '\r\n');
  assert.strictEqual(withVersion('npm-lock', crlf, '0.7.0'), crlf.split('0.1.0').join('0.7.0'));
  const odd = '{"name":"@bdd-suite/runtime","version":"0.7.0"}';
  assert.strictEqual(withVersion('npm-lock', odd, '0.7.0'), odd, 'already at the version: left as it is');
  assert.deepStrictEqual(versionsIn('npm-lock', '{"name":"other"}'), [], 'no packages and not the runtime');
  assert.deepStrictEqual(versionsIn('npm-lock', withVersion('npm-lock', '{"name":"@bdd-suite/runtime","version":"0.1.0"}', '0.7.0')), ['0.7.0'], 'a root with no packages');
});

test('D14 the check names every file that is missing, holds no version or holds another', () => {
  const files: VersionFile[] = [
    { file: 'a.props', kind: 'csharp-props' }, { file: 'gone.toml', kind: 'cargo-toml' },
    { file: 'empty.psd1', kind: 'psd1' }, { file: 'Cargo.lock', kind: 'cargo-lock' },
  ];
  const disk: Record<string, string> = {
    'a.props': SAMPLES['csharp-props'], 'empty.psd1': '@{ }', 'Cargo.lock': SAMPLES['cargo-lock'].replace('0.1.0', '0.7.0'),
  };
  assert.deepStrictEqual(versionProblems(f => disk[f], '0.7.0', files), [
    'a.props: 0.1.0, not 0.7.0', 'gone.toml: missing', 'empty.psd1: holds no version',
  ]);
  assert.deepStrictEqual(versionProblems(f => disk[f], 'seven', files.slice(3)), [
    'package.json: "seven" is not a version x.y.z', 'Cargo.lock: 0.7.0, not seven',
  ]);
  assert.strictEqual(versionProblems(() => undefined, '0.7.0').length, VERSION_FILES.length, 'every listed file, by default');
});

test('D14 the stamp writes only the files that change, and refuses a bad version or a file it cannot stamp', () => {
  const files: VersionFile[] = [{ file: 'a.props', kind: 'csharp-props' }, { file: 'b.psd1', kind: 'psd1' }];
  const disk: Record<string, string> = { 'a.props': SAMPLES['csharp-props'], 'b.psd1': SAMPLES.psd1.replace('0.1.0', '0.7.0') };
  const written: string[] = [];
  assert.deepStrictEqual(stampVersions(f => disk[f], (f, t) => { written.push(f); disk[f] = t; }, '0.7.0', files), ['a.props']);
  assert.deepStrictEqual(written, ['a.props']);
  assert.deepStrictEqual(versionsIn('csharp-props', disk['a.props']!), ['0.7.0']);
  assert.throws(() => stampVersions(f => disk[f], () => {}, '7'), /not a version/);
  assert.throws(() => stampVersions(() => undefined, () => {}, '0.7.0'), /is missing/);
  assert.throws(() => stampVersions(() => '@{ }', () => {}, '0.7.0', [{ file: 'x.psd1', kind: 'psd1' }]), /holds no version/);
});

test('D14 every listed file exists in this repository and holds exactly one version of its runtime', () => {
  for (const { file, kind } of VERSION_FILES) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8');
    const found = versionsIn(kind, text);
    assert.ok(found.length >= 1 && new Set(found).size === 1, `${file}: ${JSON.stringify(found)}`);
  }
});
