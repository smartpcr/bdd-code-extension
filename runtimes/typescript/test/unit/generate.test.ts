// suiterun generate for TypeScript (spec/test-plan.md): the config's checks,
// globs, identifiers, the guard, the three templates against their golden
// files, the writer, provider detection and the verb's exits.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse } from '../../src/cli.js';
import { ConfigError, loadConfig } from '../../src/generate/config.js';
import { select } from '../../src/generate/globs.js';
import { buildPlan, covers, Identifiers, identifierOf, RESERVED_IN_SUITE } from '../../src/generate/plan.js';
import { detectProvider, extensionImport, GENERATED_PREFIX, render, TYPESCRIPT_PROVIDERS, write } from '../../src/generate/template.js';
import { generateVerb } from '../../src/run.js';
import { corpus, pkg } from '../where.js';

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-generate-'));
const corpusConfig = path.join(corpus, 'generate', 'bddsuite.tests.yaml');
const corpusPlan = () => buildPlan(loadConfig(corpusConfig)).plan!;
const options = (line: string) => parse(line.split(' '));

test('an identifier is the name\'s words capitalised, and a collision takes the first free number ignoring case', () => {
  for (const [name, want] of [['places an order', 'PlacesAnOrder'], ['rejects a bad quantity [qty=-1]', 'RejectsABadQuantityQty1'], ['3 retries', 'N3Retries'],
    ['!!!', 'Case'], ['café au lait', 'CafAuLait'], ['MSTest_v4', 'MSTestV4']]) assert.equal(identifierOf(name!, 'Case'), want, name);
  const ids = new Identifiers(RESERVED_IN_SUITE);
  for (const [name, want] of [['setup', 'Setup_2'], ['places an order', 'PlacesAnOrder'], ['places an order!', 'PlacesAnOrder_2'], ['PLACES AN ORDER', 'PLACESANORDER_3'],
    ['???', 'Case'], ['...', 'Case_2']]) assert.equal(ids.take(name!, 'Case'), want, name);
  assert.equal(new Identifiers().take('x', 'Suite'), 'X');
});

test('an offline pattern covers a name or a prefix, and the guard sees library meta steps and polled steps', () => {
  for (const [pattern, action, covered] of [['core.*', 'core.set', true], ['core.*', 'corelike.set', false], ['wait', 'wait', true], ['wait', 'waiting', false]] as const) {
    assert.equal(covers(pattern, action), covered, `${pattern} over ${action}`);
  }
  for (const s of corpusPlan().suites) {
    assert.equal(s.guarded, s.name === 'lab-work', s.name);
    if (s.guarded) assert.deepEqual(s.guardedBy, ['fixture.state', 'inventory.get']);
  }
});

test('a config the schema refuses is refused', () => {
  const dir = folder();
  const cases: [string, string][] = [
    ['schemaRoot: s', 'suites is required'], ['suites: [a.yml]', 'schemaRoot is required'], ['suites: []\nschemaRoot: s', 'suites names no glob'],
    ['suites: [a.yml]\nschemaRoot: s\nprovidr: go', 'providr is not a config key'], ['suites: [a.yml]\nschemaRoot: s\nprovider: junit', 'provider is one of'],
    ["suites: ['a\\b.yml']\nschemaRoot: s", 'backslash'], ['suites: [a.yml]\nschemaRoot: s\nofflineActions: [\'core.*.x\']', 'prefix.*'],
    ['suites: [a.yml]\nschemaRoot: s\nofflineActions: [\'co*re\']', 'prefix.*'], ['suites: [a.yml]\nschemaRoot: s\noutput: { dir: x }', 'output.dir is not an output key'],
    ['suites: [a.yml]\nschemaRoot: s\noutput: x', 'output is a mapping'], ['suites: [1]\nschemaRoot: s', 'list of non-empty strings'], ['- a', 'YAML mapping'],
    ['suites: [a.yml\n', 'not valid YAML'],
  ];
  for (const [yaml, says] of cases) {
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, yaml);
    assert.throws(() => loadConfig(file), (e: unknown) => e instanceof ConfigError && e.message.includes(says), yaml);
  }
  assert.throws(() => loadConfig(path.join(dir, 'missing.yaml')), /cannot be read/);
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'suites: [a.yml]\nschemaRoot: s\nprovider: vitest\noutput: { folder: gen, package: p, namespace: "" }\nofflineActions: [wait]\n');
  const config = loadConfig(path.join(dir, 'config.yaml'));
  assert.deepEqual([config.provider, config.output, config.offlineActions], ['vitest', { folder: 'gen', package: 'p' }, ['wait']]);
});

test('globs select by ** * and ?, and an exclude wins', () => {
  const dir = folder();
  for (const f of ['a/x.yml', 'a/b/y.yml', 'a/b/c/z.yml', 'a/q1.yml', 'a/skip/s.yml']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), '');
  }
  assert.deepEqual(select(dir, ['a/**/*.yml'], ['a/skip/**']), ['a/b/c/z.yml', 'a/b/y.yml', 'a/q1.yml', 'a/x.yml']);
  assert.deepEqual(select(dir, ['a/q?.yml', 'a/b**']), ['a/b/c/z.yml', 'a/b/y.yml', 'a/q1.yml']);
  assert.deepEqual(select(dir, ['nowhere/*.yml']), []);
});

test('each provider\'s code for the generate corpus equals its golden files', () => {
  const plan = corpusPlan();
  const out = path.join(corpus, 'generate', 'generated');
  for (const provider of TYPESCRIPT_PROVIDERS) {
    const golden = path.join(pkg, 'test', 'golden', provider);
    const files = render([plan], out, provider);
    if (process.env.BDD_UPDATE_GOLDEN === '1') {
      fs.rmSync(golden, { recursive: true, force: true });
      fs.mkdirSync(golden, { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(golden, `${f.name}.golden`), f.text);
    }
    assert.deepEqual(fs.readdirSync(golden).sort(), files.map(f => `${f.name}.golden`).sort(), provider);
    for (const f of files) assert.equal(f.text, fs.readFileSync(path.join(golden, `${f.name}.golden`), 'utf8').replace(/\r\n/g, '\n'), `${provider} ${f.name}`);
  }
});

test('an extension reference is module#name, a relative module resolved from the config to the output', () => {
  assert.deepEqual(extensionImport('@scope/pkg#shop', '/c', '/o'), { module: '@scope/pkg', name: 'shop' });
  assert.deepEqual(extensionImport('./ext.mjs#corpus', path.resolve('/r/config'), path.resolve('/r/out/gen')), { module: '../../config/ext.mjs', name: 'corpus' });
  assert.deepEqual(extensionImport('./ext.mjs#corpus', path.resolve('/r'), path.resolve('/r')), { module: './ext.mjs', name: 'corpus' });
  for (const bad of ['shop', '#shop', 'pkg#', 'pkg#not-a-name']) assert.throws(() => extensionImport(bad, '/c', '/o'), /is not an extension reference/, bad);
});

test('the writer rewrites only what changed, removes only its own files, and --check names what is stale', () => {
  const dir = path.join(folder(), 'out');
  const files = render([corpusPlan()], dir, 'node');
  assert.deepEqual(write(dir, files, true).stale.length, files.length, 'nothing there: all stale');
  assert.equal(write(dir, files, false).written.length, files.length);
  assert.deepEqual(write(dir, files, false), { written: [], removed: [], stale: [] });
  fs.writeFileSync(path.join(dir, 'Gone.bdd.test.ts'), `${GENERATED_PREFIX} (node) from gone.yml. DO NOT EDIT.\n`);
  fs.writeFileSync(path.join(dir, 'Mine.bdd.test.ts'), 'mine\n');
  fs.appendFileSync(path.join(dir, files[0]!.name), '// edited\n');
  assert.deepEqual(write(dir, files, true).stale, [files[0]!.name, 'Gone.bdd.test.ts'].sort());
  assert.deepEqual(write(dir, files, false), { written: [files[0]!.name], removed: ['Gone.bdd.test.ts'], stale: [] });
  assert.ok(fs.existsSync(path.join(dir, 'Mine.bdd.test.ts')), 'someone else\'s file stays');
});

test('the provider comes from the nearest package.json, else node:test', () => {
  const dir = folder();
  const project = (deps: Record<string, string>, dev = true) => {
    const at = fs.mkdtempSync(path.join(dir, 'p-'));
    fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify(dev ? { devDependencies: deps } : { dependencies: deps }));
    fs.mkdirSync(path.join(at, 'gen'));
    return path.join(at, 'gen');
  };
  assert.equal(detectProvider(project({ vitest: '5' })), 'vitest');
  assert.equal(detectProvider(project({ jest: '30' }, false)), 'jest');
  assert.equal(detectProvider(project({ mocha: '11' })), 'mocha');
  assert.equal(detectProvider(project({})), 'node');
  assert.equal(detectProvider(path.parse(os.tmpdir()).root), 'node', 'no package.json up to the root');
});

test('generate refuses what it cannot do and says what it wrote', async () => {
  const dir = folder();
  const out = path.join(dir, 'gen');
  const plan = await generateVerb(options(`generate --config ${corpusConfig} --plan`));
  assert.equal(plan.code, 0);
  assert.equal(JSON.parse(plan.out).planVersion, 1);
  const two = await generateVerb(options(`generate --config ${corpusConfig} --config ${corpusConfig} --plan`));
  assert.match(two.errors, /one config's plan/);
  const broken = await generateVerb(options(`generate --config ${path.join(corpus, 'generate', 'invalid', 'bddsuite.tests.yaml')}`));
  assert.deepEqual([broken.code, /E104/.test(broken.errors), /Nothing was generated/.test(broken.errors)], [2, true, true]);
  assert.match((await generateVerb(options(`generate --config ${path.join(dir, 'none.yaml')}`))).errors, /cannot be read/);
  assert.match((await generateVerb(options(`generate --config ${corpusConfig} --out ${out}`))).errors, /mstest is not a TypeScript provider/);
  const wrote = await generateVerb(options(`generate --config ${corpusConfig} --provider vitest --out ${out}`));
  assert.equal(wrote.code, 0);
  assert.match(wrote.out, /wrote Orders\.bdd\.test\.ts[\s\S]*vitest: 5 suite\(s\), 14 test\(s\)/);
  assert.match((await generateVerb(options(`generate --config ${corpusConfig} --provider vitest --out ${out} --check`))).out, /5 generated file\(s\) are up to date/);
  fs.rmSync(path.join(out, 'Orders.bdd.test.ts'));
  const stale = await generateVerb(options(`generate --config ${corpusConfig} --provider vitest --out ${out} --check`));
  assert.deepEqual([stale.code, stale.out.split('\n')[0]], [1, 'stale: Orders.bdd.test.ts']);
  // Configs name suites relative to themselves, so these sit on the corpus's drive, in the ignored build folder.
  const near = fs.mkdtempSync(path.join(pkg, 'dist-test', 'generate-'));
  const rel = (to: string) => path.relative(near, to).replace(/\\/g, '/');
  const head = `suites: [ "${rel(path.join(corpus, 'generate', 'suites'))}/a-orders.yml" ]\nschemaRoot: ${rel(path.join(corpus, 'schema'))}\n`;
  const dirty = path.join(near, 'ext.yaml');
  fs.writeFileSync(dirty, `${head}provider: node\nextensions: [ nohash ]\n`);
  assert.match((await generateVerb(options(`generate --config ${dirty} --out ${out}`))).errors, /not an extension reference/);
  const fromOutput = path.join(near, 'with-output.yaml');
  fs.writeFileSync(fromOutput, `${head}output: { folder: here }\n`);
  assert.match((await generateVerb(options(`generate --config ${fromOutput}`))).out, /: 1 suite\(s\)/);
  assert.ok(fs.existsSync(path.join(near, 'here', 'Orders.bdd.test.ts')), 'output.folder');
  fs.rmSync(near, { recursive: true, force: true });
});

test('generate takes its own flags and no other verb does', () => {
  const o = options('generate --config a.yaml --config b.yaml --plan --check --provider jest --out gen');
  assert.deepEqual([o.configs, o.plan, o.check, o.provider, o.out], [['a.yaml', 'b.yaml'], true, true, 'jest', 'gen']);
  assert.throws(() => options('generate --plan'), /generate needs --config/);
  assert.throws(() => options('generate --config a.yaml --path x'), /generate does not take --path/);
  assert.throws(() => options('run --path a.yml --config c.yaml'), /run does not take --config/);
  assert.throws(() => options('lint --path a.yml --plan'), /lint does not take --plan/);
});
