// @bdd-suite/runtime/testing: the adapter driven by a framework that records
// what it is given and runs it the way node:test, Vitest and Jest do (before,
// the tests in order, after), and the node:test JUnit reporter on events.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { contextFor, Framework, PlannedSuite, suite } from '../../src/testing/index.js';
import reporter from '../../src/testing/node-reporter.js';
import { corpusExtension, corpusSchema } from '../where.js';

/** A framework that records the tests a suite declares and runs them as the real ones do. */
function fakeFramework() {
  const declared: { kind: 'it' | 'skip'; name: string; reason?: string; body?: () => Promise<void> }[] = [];
  const hooks: { before?: () => Promise<void>; after?: () => Promise<void> } = {};
  let described = '';
  const framework: Framework = {
    describe: (name, body) => {
      described = name;
      body();
    },
    it: (name, body) => declared.push({ kind: 'it', name, body }),
    before: body => (hooks.before = body),
    after: body => (hooks.after = body),
    skip: (name, reason) => declared.push({ kind: 'skip', name, reason }),
  };
  /** Runs the suite: before, each test (its error or 'passed'), after (its error or 'passed'). */
  const run = async (only?: string[]) => {
    const outcomes: Record<string, string> = {};
    const chosen = declared.filter(d => d.kind === 'it' && (!only || only.includes(d.name)));
    if (chosen.length && hooks.before) await hooks.before();
    for (const d of declared) {
      if (d.kind === 'skip') outcomes[d.name] = `skipped: ${d.reason}`;
      else if (chosen.includes(d)) outcomes[d.name] = await d.body!().then(() => 'passed', (e: Error) => `failed: ${e.message}`);
    }
    const after = chosen.length && hooks.after ? await hooks.after().then(() => 'passed', (e: Error) => `failed: ${e.message}`) : 'not run';
    return { outcomes, after };
  };
  return { framework, declared, hooks, run, described: () => described };
}

/** A suite file and a test file beside it, the way the generator writes their relation. */
function planned(yaml: string, guarded = false): { base: string; spec: PlannedSuite } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-testing-'));
  fs.writeFileSync(path.join(dir, 'suite.yml'), yaml);
  const cases = [...yaml.matchAll(/- name: (.+)/g)].map(m => m[1]!.trim());
  return {
    base: pathToFileURL(path.join(dir, 'gen', 'Suite.bdd.test.ts')).href,
    spec: { file: '../suite.yml', shown: 'suite.yml', schemaRoot: pathToFileURL(corpusSchema).href, name: 'the suite', guarded, cases },
  };
}

const TWO = `
suite: s
setup: [ { action: core.noop } ]
teardown: [ { action: core.noop } ]
tests:
  - name: one
    tags: [a]
    steps: [ { when: it works, action: core.noop } ]
  - name: two
    tags: [b]
    steps: [ { when: it fails, action: core.fail, message: broken } ]
`;

test('a suite is a describe of its cases; a case that fails fails its test; the trace is written when the suite ends', async () => {
  const traceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-trace-')), 'trace.json');
  const env = { BDD_SUITE_TRACE_FILE: traceFile, BDD_SUITE_TAGS: '' };
  const { base, spec } = planned(TWO);
  const fake = fakeFramework();
  suite(fake.framework, [{ name: 'adapter test 1' }], base, spec, env);
  assert.equal(fake.described(), 'the suite');
  const { outcomes, after } = await fake.run();
  assert.equal(outcomes.one, 'passed');
  assert.match(outcomes.two!, /^failed: .*broken/);
  assert.equal(after, 'passed');
  const written = JSON.parse(fs.readFileSync(traceFile, 'utf8')) as { phase: string }[];
  assert.deepEqual([written[0]!.phase, written.at(-1)!.phase], ['suite-setup', 'suite-teardown']);
});

test('a case the tag filter does not select is skipped when the file loads, and traced as skipped before the teardown', async () => {
  const { base, spec } = planned(TWO);
  const fake = fakeFramework();
  const env = { BDD_SUITE_TAGS: 'a' };
  suite(fake.framework, [{ name: 'adapter test 2' }], base, spec, env);
  assert.deepEqual(fake.declared.map(d => [d.kind, d.name, d.reason]), [['it', 'one', undefined], ['skip', 'two', 'tag filter']]);
  const { outcomes } = await fake.run();
  assert.equal(outcomes.one, 'passed');
  const trace = contextFor([{ name: 'adapter test 2' }], env).trace.entries;
  assert.deepEqual(trace.filter(e => e.phase === 'case').map(e => `${e.case} ${e.status} ${e.reason ?? ''}`), ['one passed ', 'two skipped tag']);
  assert.equal(trace.at(-1)!.phase, 'suite-teardown');
});

test('a guarded suite without the opt-in declares every case skipped and traces them at once; with it, they run', async () => {
  const { base, spec } = planned(TWO, true);
  const refusing = fakeFramework();
  suite(refusing.framework, [{ name: 'adapter test 3' }], base, spec, {});
  assert.deepEqual(refusing.declared.map(d => d.kind), ['skip', 'skip']);
  assert.match(refusing.declared[0]!.reason!, /BDD_SUITE_ALLOW_GUARDED=1/);
  assert.equal(refusing.hooks.before, undefined, 'no hook: nothing will run');
  assert.deepEqual(contextFor([{ name: 'adapter test 3' }], {}).trace.entries.map(e => `${e.case} ${e.reason}`), ['one guard', 'two guard']);
  const allowed = fakeFramework();
  suite(allowed.framework, [{ name: 'adapter test 4' }], base, spec, { BDD_SUITE_ALLOW_GUARDED: '1' });
  assert.equal((await allowed.run(['one'])).outcomes.one, 'passed');
});

test('the teardown\'s failure fails the after hook, and a suite that does not lint fails every case with its findings', async () => {
  const failing = planned('suite: s\nteardown: [ { action: core.fail, message: left a mess } ]\ntests:\n  - name: one\n    steps: [ { action: core.noop } ]\n');
  const fake = fakeFramework();
  suite(fake.framework, [{ name: 'adapter test 5' }], failing.base, failing.spec, {});
  const { outcomes, after } = await fake.run();
  assert.equal(outcomes.one, 'passed');
  assert.match(after, /^failed: The suite teardown of the suite failed: .*left a mess/);

  const broken = planned('suite: s\ntests:\n  - name: one\n    steps: [ { when: it works, action: core.nope } ]\n');
  const refused = fakeFramework();
  suite(refused.framework, [{ name: 'adapter test 6' }], broken.base, broken.spec, {});
  assert.match((await refused.run()).outcomes.one!, /^failed: suite\.yml does not lint clean[\s\S]*E104/);
});

test('the run context is one per set of extensions, built once', () => {
  const env = { BDD_SUITE_TAGS: 'x' };
  assert.equal(contextFor([corpusExtension], env), contextFor([corpusExtension], {}));
  assert.notEqual(contextFor([corpusExtension]), contextFor([{ name: 'another' }]));
});

async function* events(list: { type: string; data: Record<string, unknown> }[]): AsyncGenerator<never> {
  for (const event of list) yield event as never;
}

test('the node:test reporter writes JUnit with suite-level failures and without a suite that failed through its tests', async () => {
  const hookError = Object.assign(new Error('wrapper'), { failureType: 'hookFailed', cause: new Error('The suite teardown of s failed: x') });
  const out: string[] = [];
  for await (const text of reporter(events([
    { type: 'test:dequeue', data: { name: 's', nesting: 0, file: 'a' } },
    { type: 'test:start', data: { name: 'one & <two>', nesting: 1, file: 'a' } },
    { type: 'test:pass', data: { name: 'one & <two>', nesting: 1, file: 'a', details: { type: 'test', duration_ms: 12 } } },
    { type: 'test:start', data: { name: 'skipped', nesting: 1, file: 'a' } },
    { type: 'test:pass', data: { name: 'skipped', nesting: 1, file: 'a', skip: 'tag filter', details: { type: 'test' } } },
    { type: 'test:start', data: { name: 'bare skip', nesting: 1, file: 'a' } },
    { type: 'test:pass', data: { name: 'bare skip', nesting: 1, file: 'a', skip: true, details: { type: 'test' } } },
    { type: 'test:start', data: { name: 'broken', nesting: 1, file: 'a' } },
    { type: 'test:fail', data: { name: 'broken', nesting: 1, file: 'a', details: { type: 'test', error: Object.assign(new Error('w'), { cause: 'a "string" cause' }) } } },
    { type: 'test:fail', data: { name: 's', nesting: 0, file: 'a', details: { type: 'suite', error: hookError } } },
    { type: 'test:start', data: { name: 't', nesting: 0, file: 'b' } },
    { type: 'test:fail', data: { name: 't', nesting: 0, file: 'b', details: { type: 'suite', error: Object.assign(new Error('1 subtest failed'), { failureType: 'subtestsFailed' }) } } },
    { type: 'test:pass', data: { name: 't2', nesting: 0, details: { type: 'suite' } } },
    { type: 'test:fail', data: { name: 'plain', nesting: 0 } },
    { type: 'test:diagnostic', data: { name: '', nesting: 0 } },
  ]))) out.push(text);
  const xml = out.join('');
  assert.match(xml, /<testsuites tests="6" failures="3" skipped="2">/);
  assert.match(xml, /<testcase name="one &amp; &lt;two&gt;" classname="s" time="0.012"\/>/);
  assert.match(xml, /<testcase name="skipped" classname="s" time="0.000"><skipped message="tag filter"\/><\/testcase>/);
  assert.match(xml, /<testcase name="bare skip" classname="s" time="0.000"><skipped message=""\/><\/testcase>/);
  assert.match(xml, /name="broken" classname="s" time="0.000"><failure message="a &quot;string&quot; cause" type="testCodeFailure"\/>/);
  assert.match(xml, /<testcase name="s" classname="" time="0.000"><failure message="The suite teardown of s failed: x" type="hookFailed"\/><\/testcase>/);
  assert.match(xml, /<testcase name="plain" classname="" time="0.000"><failure message="failed" type="testCodeFailure"\/><\/testcase>/);
  assert.doesNotMatch(xml, /name="t"/, 'a describe that failed through its tests is not a case');
  let empty = '';
  for await (const text of reporter(events([]))) empty += text;
  assert.equal(empty, '<?xml version="1.0" encoding="utf-8"?>\n<testsuites tests="0" failures="0" skipped="0">\n</testsuites>\n');
});

test("the node:test reporter names each case after its own file's describe when files' events interleave", async () => {
  // Two test files running at once: node passes their events on as they come (seen on Linux CI).
  const out: string[] = [];
  for await (const text of reporter(events([
    { type: 'test:dequeue', data: { name: 'names', nesting: 0, file: 'Names.bdd.test.ts' } },
    { type: 'test:dequeue', data: { name: 'meta', nesting: 0, file: 'Meta.bdd.test.ts' } },
    { type: 'test:start', data: { name: 'first', nesting: 1, file: 'Names.bdd.test.ts' } },
    { type: 'test:start', data: { name: 'from-the-use-site', nesting: 1, file: 'Meta.bdd.test.ts' } },
    { type: 'test:pass', data: { name: 'from-the-use-site', nesting: 1, file: 'Meta.bdd.test.ts', details: { type: 'test' } } },
    { type: 'test:pass', data: { name: 'first', nesting: 1, file: 'Names.bdd.test.ts', details: { type: 'test' } } },
  ]))) out.push(text);
  const xml = out.join('');
  assert.match(xml, /<testcase name="from-the-use-site" classname="meta"/);
  assert.match(xml, /<testcase name="first" classname="names"/);
});
