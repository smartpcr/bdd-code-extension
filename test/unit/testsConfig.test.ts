// docs/test-providers, D16: bddsuite.tests.yaml in the editor. Its findings
// against the schema, completion of its keys and providers, the config's
// globs, and the offline actions a suite takes from the nearest config.
import * as assert from 'assert';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import {
  checkTestsConfig, configSelects, CONFIG_KEYS, globPattern, isTestsConfigFile, nearestKey, offlineActionsFor, OUTPUT_KEYS, PROVIDERS,
  testsConfigCompletion,
} from '../../src/core/testsConfig';
import { TESTS_CONFIG_SCHEMA } from '../../src/core/testsConfigSchema';

const repo = path.resolve(__dirname, '..', '..', '..');
const VALID = 'suites: [ "suites/*.yml" ]\nschemaRoot: schema\nprovider: mstest\noutput: { namespace: My.Tests }\n';

test('D16 the editor\'s copy of the config schema is spec/tests.config.schema.json', () => {
  assert.deepStrictEqual(TESTS_CONFIG_SCHEMA, JSON.parse(fs.readFileSync(path.join(repo, 'spec', 'tests.config.schema.json'), 'utf8')));
  assert.deepStrictEqual(PROVIDERS, ['mstest', 'nunit', 'xunit', 'go', 'rust', 'node', 'vitest', 'jest', 'mocha', 'pester']);
  assert.deepStrictEqual(OUTPUT_KEYS, ['folder', 'namespace', 'package']);
  assert.ok(CONFIG_KEYS.includes('offlineActions'));
});

test('D16 a config is bddsuite.tests.yaml or another <name>.tests.yaml', () => {
  for (const yes of ['/w/bddsuite.tests.yaml', 'C:\\w\\BDDSuite.Tests.yaml', '/w/shop.tests.yaml']) assert.ok(isTestsConfigFile(yes), yes);
  for (const no of ['/w/suite.yml', '/w/tests.yaml', '/w/bddsuite.tests.yml']) assert.ok(!isTestsConfigFile(no), no);
});

test('E14 a misspelled key is marked at the key with the nearest spelling, an unknown provider at the value', () => {
  assert.deepStrictEqual(checkTestsConfig(VALID), []);
  const found = checkTestsConfig('suites: [ a.yml ]\nschemaRoot: s\nprovidr: mstest\noutput: { foldr: gen }\n');
  assert.deepStrictEqual(found.map(f => [f.code, f.range.start.line, f.message]), [
    ['BDD070', 2, 'providr is not a config key (spec/tests.config.schema.json). Did you mean provider?'],
    ['BDD070', 3, 'foldr is not a config key (spec/tests.config.schema.json). Did you mean folder?'],
  ]);
  const provider = checkTestsConfig('suites: [ a.yml ]\nschemaRoot: s\nprovider: junit\n');
  assert.deepStrictEqual(provider.map(f => [f.code, f.range.start.line, f.range.start.character]), [['BDD071', 2, 10]]);
  assert.match(provider[0]!.message, /Valid values: mstest, nunit, xunit, go, rust, node, vitest, jest, mocha, pester/);
  assert.deepStrictEqual(checkTestsConfig('schemaRoot: s\nzzzzzzzzzzzz: 1\n').map(f => [f.code, f.message]), [
    ['BDD071', 'Missing required property "suites".'],
    ['BDD070', 'zzzzzzzzzzzz is not a config key (spec/tests.config.schema.json).'],
  ]);
  assert.match(checkTestsConfig('suites: [ "a\\\\b.yml" ]\nschemaRoot: s\n')[0]!.message, /must match pattern/);
  assert.match(checkTestsConfig('suites: [ a\n')[0]!.message, /^Not valid YAML/);
});

test('nearestKey offers a spelling only when it is near', () => {
  assert.strictEqual(nearestKey('schemaroot', CONFIG_KEYS), 'schemaRoot');
  assert.strictEqual(nearestKey('ofline', CONFIG_KEYS), undefined);
  assert.strictEqual(nearestKey('x', []), undefined);
});

test('E14 completion offers the providers, the keys a config lacks, and output\'s keys', () => {
  const at = (text: string) => testsConfigCompletion(text.replace('|', ''), text.indexOf('|'));
  assert.deepStrictEqual(at('suites: [a]\nprovider: |'), { kind: 'value', items: [...PROVIDERS] });
  assert.deepStrictEqual(at('suites: [a]\nprovider: ms|'), { kind: 'value', items: [...PROVIDERS] });
  assert.deepStrictEqual(at('suites: [a]\nschemaRoot: s\n|'), { kind: 'key', items: CONFIG_KEYS.filter(k => k !== 'suites' && k !== 'schemaRoot') });
  assert.deepStrictEqual(at('|'), { kind: 'key', items: [...CONFIG_KEYS] });
  assert.deepStrictEqual(at('- a\n|'), { kind: 'key', items: [...CONFIG_KEYS] }, 'not a mapping: nothing is present');
  assert.deepStrictEqual(at('output:\n  # where\n\n  fol|'), { kind: 'key', items: [...OUTPUT_KEYS] });
  assert.deepStrictEqual(at('output:\n  folder: gen\n  na|'), { kind: 'key', items: [...OUTPUT_KEYS] }, 'past a sibling key');
  assert.strictEqual(at('suites:\n  |'), undefined, 'under another key');
  assert.strictEqual(at('  |'), undefined, 'indented with nothing above');
  assert.strictEqual(at('output:\n  folder: |'), undefined, 'a value');
});

test('a config glob: ** any folders, * one name, ? one character, .. before the first wildcard, and the case', () => {
  const root = path.resolve('/w/project');
  const full = (rel: string) => path.join(root, rel).replace(/\\/g, '/');
  assert.ok(globPattern(root, 'suites/**/*.yml', false).test(full('suites/a/b/c.yml')));
  assert.ok(globPattern(root, 'suites/**/*.yml', false).test(full('suites/c.yml')));
  assert.ok(globPattern(root, 'suites/x**', false).test(full('suites/x/y/z.yml')));
  assert.ok(globPattern(root, 's?ites/a.yml', false).test(full('suites/a.yml')));
  assert.ok(!globPattern(root, 'suites/*.yml', false).test(full('suites/a/b.yml')));
  assert.ok(globPattern(root, '../shared/(a).yml', false).test(path.resolve(root, '../shared/(a).yml').replace(/\\/g, '/')));
  assert.ok(!globPattern(root, 'Suites/A.yml', false).test(full('suites/a.yml')));
  assert.ok(globPattern(root, 'Suites/A.yml', true).test(full('suites/a.yml')));
  assert.ok(configSelects(root, ['suites/*.yml'], [], path.join(root, 'suites', 'a.yml'), false));
  assert.ok(!configSelects(root, ['suites/*.yml'], ['suites/a.*'], path.join(root, 'suites', 'a.yml'), false));
  assert.ok(!configSelects(root, ['other/*.yml'], [], path.join(root, 'suites', 'a.yml'), false));
});

test('E14 a suite takes its offline actions from the nearest config that selects it, else from the setting', () => {
  const root = path.resolve('/w');
  const files = new Map<string, string>();
  const read = (file: string) => files.get(path.resolve(file));
  const put = (rel: string, text: string) => files.set(path.join(root, rel), text);
  const suite = path.join(root, 'tests', 'suites', 'a.yml');
  assert.strictEqual(offlineActionsFor(suite, root, read, false), undefined, 'no config up to the root');
  put('tests/bddsuite.tests.yaml', 'suites: [ "suites/*.yml" ]\nschemaRoot: s\nofflineActions: [ "core.*", "shop.*" ]\n');
  assert.deepStrictEqual(offlineActionsFor(suite, root, read, false), { config: path.join(root, 'tests', 'bddsuite.tests.yaml'), offlineActions: ['core.*', 'shop.*'] });
  put('tests/suites/bddsuite.tests.yaml', 'suites: [ "other/*.yml" ]\nschemaRoot: s\nofflineActions: [ wait ]\n');
  assert.strictEqual(offlineActionsFor(suite, root, read, false), undefined, 'the nearest config decides, and it does not select the suite');
  put('tests/suites/bddsuite.tests.yaml', 'suites: [ "*.yml" ]\nschemaRoot: s\n');
  assert.strictEqual(offlineActionsFor(suite, root, read, false), undefined, 'the nearest config lists no offlineActions');
  put('tests/suites/bddsuite.tests.yaml', 'suites: [ "*.yml" ]\nschemaRoot: s\nexclude: [ "b.yml" ]\nofflineActions: []\n');
  assert.deepStrictEqual(offlineActionsFor(suite, root, read, false)?.offlineActions, [], 'an empty list: nothing is offline');
  assert.strictEqual(offlineActionsFor(path.resolve('/elsewhere/x.yml'), root, read, false), undefined, 'outside the root');
  // On Windows a folder on another drive is not under the root, though path.relative gives no '..'.
  if (process.platform === 'win32') assert.strictEqual(offlineActionsFor('Q:/x/y.yml', 'C:/w', read, true), undefined, 'another drive');
});
