// The session's rules (spec/session.md), one test each, on small suites; the
// run context a test process builds from its environment; the trace file the
// JavaScript providers append to.
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { coreActions } from '../../src/actions/core.js';
import { coreOnly, RunOptions, runFile } from '../../src/exec.js';
import { compose, start } from '../../src/extension.js';
import { loadDocument } from '../../src/model.js';
import { loadSchema } from '../../src/schema.js';
import {
  createRunContext, flushTrace, GUARDED_MESSAGE, openLinted, openSession, optionVariable, RunContext, runContextFromEnv, Session, SuiteRefusedError,
} from '../../src/session.js';
import { Trace } from '../../src/trace.js';
import { deepClone, ValueMap } from '../../src/value.js';
import { corpusExtension, corpusSchema } from '../where.js';

const schema = loadSchema(corpusSchema);
const options = (over: Partial<RunOptions> = {}): RunOptions => ({ tags: [], params: [], dryRun: false, recordPath: '', env: {}, ...over });
const corpusRun = () => {
  const composite = compose([corpusExtension], coreActions);
  return { composite, started: start(composite, new Map()) };
};
const context = (over: Partial<RunOptions> = {}): RunContext => createRunContext(corpusRun(), options(over));
const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-session-'));

function open(yaml: string, ctx = context(), guarded = false): Session {
  const file = path.join(folder(), 'suite.yml');
  fs.writeFileSync(file, yaml);
  return openSession(file, loadDocument(yaml).value as ValueMap, schema, ctx, guarded);
}

/** The trace as `phase case status` lines, steps left out. */
const phases = (trace: Trace) => trace.entries.filter(e => e.phase !== 'step').map(e => `${e.phase} ${e.case ?? ''} ${e.status}`.replace(/  /, ' ').trim());

async function runOne(session: Session, index: number) {
  await session.beforeEach(index);
  const ran = await session.runCase(index);
  const settled = await session.afterEach(index);
  return { ran, settled };
}

const HOOKED = `
suite: hooked
setup: [ { action: core.noop } ]
beforeEach: [ { action: core.noop } ]
afterEach: [ { action: core.noop } ]
teardown: [ { action: core.noop } ]
tests:
  - name: one
    tags: [a]
    steps: [ { when: it works, action: core.noop } ]
  - name: two
    tags: [b]
    steps: [ { when: it works, action: core.noop } ]
`;

test('rule 1: operations out of order are refused, and a case never run still settles', async () => {
  const session = open(HOOKED);
  await assert.rejects(session.runCase(0), /runCase for "one" needs beforeEach first/);
  await assert.rejects(session.afterEach(0), /afterEach for "one" needs beforeEach first/);
  await assert.rejects(session.beforeEach(9), /no case number 9/);
  await session.beforeEach(0);
  assert.equal((await session.runCase(0)).status, 'passed');
  await assert.rejects(session.runCase(0), /called twice/);
  assert.equal((await session.afterEach(0)).status, 'passed');
  await session.beforeEach(1);
  const settled = await session.afterEach(1);
  assert.deepEqual([settled.status, settled.reason], ['failed', 'hook']);
  assert.match(settled.message, /beforeEach but not the case itself/);
  assert.equal(session.indexOf('two'), 1);
  assert.equal(session.indexOf('three'), -1);
  assert.equal(session.trace, session.context.trace);
});

test('rule 2: setup runs once however often it is called, and beforeEach runs it', async () => {
  const session = open(HOOKED);
  await runOne(session, 0);
  await Promise.all([session.setup(), session.setup()]);
  assert.equal(phases(session.trace).filter(l => l.startsWith('suite-setup')).length, 1);
});

test('rule 2: nothing selected runs neither setup nor teardown', async () => {
  const session = open(HOOKED, context({ tags: ['none'] }));
  await session.setup();
  for (const index of [0, 1]) {
    assert.equal(session.isSelected(index), false);
    const { settled } = await runOne(session, index);
    assert.deepEqual([settled.status, settled.reason, settled.message], ['skipped', 'tag', 'tag filter']);
  }
  assert.equal((await session.teardown()).ran, false);
  assert.deepEqual(phases(session.trace), ['case one skipped', 'case two skipped']);
});

test('rule 3: a failed setup is recorded and every case reports it; the teardown still runs', async () => {
  const session = open(`
suite: s
setup: [ { action: core.fail, message: no lab } ]
teardown: [ { action: core.noop } ]
tests:
  - name: one
    steps: [ { action: core.noop } ]
`);
  await session.setup();
  const { ran } = await runOne(session, 0);
  assert.deepEqual([ran.status, ran.reason], ['error', 'suite-setup']);
  assert.match(ran.message, /^Suite setup failed: suite setup/);
  assert.equal((await session.teardown()).ran, true);
});

test('rule 3: a failed beforeEach is recorded and the case still cleans up', async () => {
  const session = open(`
suite: s
beforeEach: [ { action: core.fail, message: not ready } ]
afterEach: [ { action: core.noop } ]
tests:
  - name: one
    steps: [ { when: never, action: core.noop } ]
    cleanup: [ { action: core.noop } ]
`);
  const { ran, settled } = await runOne(session, 0);
  assert.deepEqual([ran.status, ran.reason], ['failed', 'hook']);
  assert.equal(settled.afterEachFailed, false);
  assert.deepEqual(phases(session.trace), ['before-each one failed', 'case-cleanup one passed', 'after-each one passed', 'case one failed']);
});

test('rule 3: a case whose variables cannot be resolved is refused, and the next case still starts', async () => {
  const session = open(`
suite: s
tests:
  - name: one
    vars: { v: '\${nope.thing}' }
    steps: [ { action: core.noop } ]
  - name: two
    steps: [ { action: core.noop } ]
`);
  await assert.rejects(session.beforeEach(0));
  assert.equal((await runOne(session, 1)).settled.status, 'passed');
});

test('rule 4: a failed afterEach settles the case and says so', async () => {
  const session = open(`
suite: s
afterEach: [ { action: core.fail, message: could not reset } ]
tests:
  - name: one
    steps: [ { action: core.noop } ]
`);
  const { ran, settled } = await runOne(session, 0);
  assert.equal(ran.status, 'passed');
  assert.equal(settled.afterEachFailed, true);
  assert.deepEqual([settled.status, settled.reason], ['failed', 'hook']);
  assert.match(settled.message, /afterEach failed:/);
});

test('rule 5: a case that changes a captured list in place changes it for itself only', async () => {
  const session = open(`
suite: s
setup: [ { action: core.set, value: { items: [a] }, captureAs: bag } ]
tests:
  - name: one
    steps:
      - { action: fixture.append, list: '\${capture.bag.items}', item: b, captureAs: grown, asserts: [ { var: grown, count: 2 } ] }
  - name: two
    steps:
      - { action: core.noop, asserts: [ { var: bag.items, count: 1 } ] }
`);
  for (const index of [0, 1]) assert.equal((await runOne(session, index)).settled.status, 'passed', session.cases[index]);
  const nested = new Map([['list', ['a', new Map([['k', 1n]])]]]) as ValueMap;
  const copy = deepClone(nested) as ValueMap;
  ((copy.get('list') as unknown[])[1] as ValueMap).set('k', 2n);
  assert.equal(((nested.get('list') as unknown[])[1] as ValueMap).get('k'), 1n);
});

test('rule 6: teardown runs once and only after a setup; a failure is returned', async () => {
  const session = open(HOOKED);
  assert.equal((await session.teardown()).ran, false, 'no setup yet');
  await session.setup();
  assert.deepEqual(await session.teardown().then(t => [t.ran, t.failed]), [true, false]);
  assert.equal((await session.teardown()).ran, false, 'a second call does nothing');
  const failing = open(`
suite: s
teardown: [ { action: core.fail, message: left a mess } ]
tests:
  - name: one
    steps: [ { action: core.noop } ]
`);
  assert.equal((await runOne(failing, 0)).settled.status, 'passed');
  const teardown = await failing.teardown();
  assert.deepEqual([teardown.ran, teardown.failed], [true, true]);
  assert.match(teardown.message, /left a mess/);
});

test('rule 7: cases a framework starts at once take turns, and the teardown waits for the last', async () => {
  const dir = folder();
  const record = path.join(dir, 'record.txt');
  const session = open(`
suite: s
tests:
${['one', 'two', 'three'].map(n => `  - name: ${n}
    steps: [ { action: core.record, marker: ${n}-start }, { action: core.sleep, seconds: 0.1 }, { action: core.record, marker: ${n}-end } ]`).join('\n')}
`, context({ recordPath: record }));
  const [, , , teardown] = await Promise.all([0, 1, 2].map(i => runOne(session, i)).concat([session.teardown().then(() => undefined) as never]));
  void teardown;
  const markers = fs.readFileSync(record, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(markers, ['one-start', 'one-end', 'two-start', 'two-end', 'three-start', 'three-end']);
  const cases = session.trace.entries.map(e => e.case);
  assert.deepEqual(cases.filter((c, i) => c !== cases[i - 1]), ['one', 'two', 'three']);
});

test('rule 9: a guarded suite skips unless the run allows it, at run time and at load time', async () => {
  const refusing = context();
  refusing.allowGuarded = false;
  const session = open(HOOKED, refusing, true);
  await session.setup();
  const { settled } = await runOne(session, 0);
  assert.deepEqual([settled.status, settled.reason, settled.message], ['skipped', 'guard', GUARDED_MESSAGE]);
  assert.deepEqual(session.recordSkipped(1), { name: 'two', status: 'skipped', reason: 'guard', message: GUARDED_MESSAGE, output: '', durationSec: 0, afterEachFailed: false });
  assert.equal((await session.teardown()).ran, false);
  assert.deepEqual(phases(session.trace), ['case one skipped', 'case two skipped']);
  const allowed = open(HOOKED, context(), true);
  assert.equal((await runOne(allowed, 0)).settled.status, 'passed');
  assert.throws(() => allowed.recordSkipped(0), /is not skipped/);
  assert.deepEqual(open(HOOKED, context({ tags: ['b'] })).recordSkipped(0).reason, 'tag');
});

test('rule 10: a dry run validates and traces nothing', async () => {
  const session = open(HOOKED, context({ dryRun: true }));
  await session.setup();
  assert.equal((await runOne(session, 0)).settled.status, 'skipped');
  assert.equal((await session.teardown()).ran, false);
  assert.deepEqual(session.trace.entries, []);
});

test('a test process takes its options, tags and switches from the environment under the prefix', () => {
  const lab = { name: 'lab', options: [{ flag: '--api-url', description: 'The lab.' }], contextKeys: ['apiUrl'], start: (o: Map<string, string>) => ({ context: { apiUrl: o.get('--api-url') ?? '' } }) };
  const env = {
    BDD_SUITE_OPTION_API_URL: 'http://lab', BDD_SUITE_TAGS: ' smoke, ,lab ', BDD_SUITE_DRY_RUN: '1', BDD_SUITE_ALLOW_GUARDED: '1',
    BDD_SUITE_TRACE_FILE: 'out/trace.json', BDD_SUITE_RECORD_PATH: 'out/record.txt',
  };
  const ctx = runContextFromEnv([lab], env);
  assert.equal(optionVariable('--api-url'), 'API_URL');
  assert.deepEqual(ctx.options.tags, ['smoke', 'lab']);
  assert.equal(ctx.run.started.context.get('apiUrl'), 'http://lab');
  assert.deepEqual([ctx.options.dryRun, ctx.allowGuarded, ctx.traceFile, ctx.options.recordPath], [true, true, 'out/trace.json', 'out/record.txt']);
  const quiet = runContextFromEnv([], {});
  assert.deepEqual([quiet.options.tags, quiet.options.dryRun, quiet.allowGuarded, quiet.traceFile], [[], false, false, '']);
  assert.ok(runContextFromEnv().run.composite.actions.has('core.noop'), 'the process environment and the core by default');
});

test('flushTrace appends what was traced since the last flush, under a lock', async () => {
  const dir = folder();
  const file = path.join(dir, 'nested', 'trace.json');
  const ctx = context();
  flushTrace(ctx);
  ctx.traceFile = file;
  flushTrace(ctx);
  assert.equal(fs.existsSync(file), false, 'nothing traced: nothing written');
  const session = open(HOOKED, ctx);
  await runOne(session, 0);
  flushTrace(ctx);
  const first = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[];
  assert.equal(first.length, ctx.trace.entries.length);
  const other = context();
  other.traceFile = file;
  await runOne(open(HOOKED, other), 1);
  flushTrace(other);
  await session.teardown();
  flushTrace(ctx);
  const all = JSON.parse(fs.readFileSync(file, 'utf8')) as { case?: string; phase: string }[];
  assert.equal(all.length, ctx.trace.entries.length + other.trace.entries.length);
  assert.equal(all.at(-1)!.phase, 'suite-teardown');
  fs.mkdirSync(`${file}.lock`);
  ctx.trace.add('case', 'x', '', '', 'passed', '');
  // The wait blocks this thread, so another process lets the lock go.
  spawn(process.execPath, ['-e', `setTimeout(() => require('fs').rmdirSync(${JSON.stringify(`${file}.lock`)}), 200)`], { stdio: 'ignore' });
  flushTrace(ctx);
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[]).length, all.length + 1);
  fs.writeFileSync(path.join(dir, 'blocker'), '');
  ctx.traceFile = path.join(dir, 'blocker', 'trace.json');
  ctx.trace.add('case', 'y', '', '', 'passed', '');
  assert.throws(() => flushTrace(ctx), 'a trace file under a file cannot be written');
});

test('a test process refuses a suite that does not lint clean, with its findings', () => {
  const dir = folder();
  const bad = path.join(dir, 'bad.yml');
  fs.writeFileSync(bad, 'suite: s\ntests:\n  - name: one\n    steps: [ { when: it works, action: core.nope } ]\n');
  assert.throws(() => openLinted(bad, 'bad.yml', schema, context()), (e: unknown) => {
    assert.ok(e instanceof SuiteRefusedError);
    assert.equal(e.findings[0]!.code, 'E104');
    assert.match(e.message, /bad\.yml:4:\d+ +E104/);
    return true;
  });
  const good = path.join(dir, 'good.yml');
  fs.writeFileSync(good, HOOKED);
  assert.deepEqual(openLinted(good, 'good.yml', schema, context(), true).cases, ['one', 'two']);
});

test('runFile reports a failed teardown as its own entry, after the cases', async () => {
  const yaml = 'suite: s\nteardown: [ { action: core.fail } ]\ntests:\n  - name: one\n    steps: [ { action: core.noop } ]\n';
  const result = await runFile(path.join(folder(), 'unnamed.yml'), loadDocument(yaml).value as ValueMap, schema, options(), new Trace(), coreOnly());
  assert.deepEqual(result.cases.map(c => [c.name, c.status, c.reason]), [['one', 'passed', ''], ['teardown', 'failed', 'hook']]);
  const named = openSession(path.join('x', 'no-name.yml'), loadDocument('tests: []\n').value as ValueMap, schema, context());
  assert.equal(named.name, 'no-name');
});
