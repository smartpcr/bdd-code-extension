// suite.ts, exec.ts and the core actions on small suites: each phase, each
// way a step ends, the limits, wait, and the scope (B7.5-3).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { coreActions } from '../../src/actions/core.js';
import { action, ActionError, sleep } from '../../src/actions/registry.js';
import { allNames, anyFailed, RunOptions, runFile } from '../../src/exec.js';
import { compose, Extension, start } from '../../src/extension.js';
import { loadDocument } from '../../src/model.js';
import { corpusSchema, repo } from '../where.js';
import { overlayReader } from '../../src/reader.js';
import { loadSchema } from '../../src/schema.js';
import {
  caseTags, expandOutline, expandSteps, formatRow, metaDefinitions, readLibraries, resolveParams, resolveVars, stepLabel, stepLimit, tagsMatch,
} from '../../src/suite.js';
import { Trace } from '../../src/trace.js';
import { mapOf, Value, ValueMap } from '../../src/value.js';

const root = repo;
const schema = loadSchema(corpusSchema);
const dir = path.join(root, 'test', 'e2e', 'suites');
const at = (f: string) => path.join(dir, f);
const doc = (text: string) => loadDocument(text).value as ValueMap;

async function run(text: string, over: Partial<RunOptions> = {}, files: Record<string, string> = {}, extensions: Extension[] = [],
  options = new Map<string, string>()) {
  const trace = new Trace();
  const reader = overlayReader(Object.fromEntries(Object.entries(files).map(([k, v]) => [at(k), v])));
  const composite = compose(extensions, coreActions);
  const result = await runFile(at('_unit.yml'), doc(text), schema, {
    tags: [], params: [], dryRun: false, recordPath: '', env: {}, reader, ...over,
  }, trace, { composite, started: start(composite, options) });
  const sig = trace.entries.map(e => `${e.phase}:${e.case ?? ''}:${e.status}${e.reason ? `/${e.reason}` : ''}`);
  return { result, trace, sig };
}

/** An extension like a lab's: two context keys from its own options, one more (target) from the suite's defaults. */
const lab: Extension = {
  name: 'lab',
  contextKeys: ['labId', 'apiUrl', 'target'],
  options: [{ flag: '--lab-id', description: 'the lab' }, { flag: '--api-url', description: 'its API' }],
  start: o => ({ context: { labId: o.get('--lab-id') ?? '', apiUrl: o.get('--api-url') ?? '' } }),
};

test('B7.5-3 an extension\'s context keys are readable in a case, from its options or the suite defaults', async () => {
  const { result } = await run(`suite: s
defaults:
  target: T1
tests:
  - name: c
    timeoutSec: 30
    steps:
      - action: core.set
        value: \${labId}|\${apiUrl}|\${target}|\${defaults.target}|\${timeoutSec}
        captureAs: v
    asserts:
      - { var: v, equals: 'lab9|https://api|T1|T1|30' }
`, {}, {}, [lab], new Map([['--lab-id', 'lab9'], ['--api-url', 'https://api']]));
  assert.equal(result.cases[0]!.status, 'passed', result.cases[0]!.message);
});

test('phases in order; a failing case setup fails the case as a hook and cleanup still runs; afterEach and teardown failures', async () => {
  const { sig, result } = await run(`suite: s
setup: [{ action: core.noop }]
beforeEach: [{ action: core.noop }]
afterEach: [{ action: core.fail }]
teardown: [{ action: core.fail }]
tests:
  - name: a
    setup: [{ action: core.fail }]
    steps: [{ action: core.noop }]
    cleanup: [{ action: core.fail }]
`);
  assert.deepEqual(sig, ['suite-setup::passed', 'before-each:a:passed', 'case-setup:a:failed/action', 'case-cleanup:a:failed/action',
    'after-each:a:failed/action', 'case:a:failed/hook', 'suite-teardown::failed/action']);
  assert.match(result.cases[0]!.message, /Cleanup failed: .*afterEach failed:/);
  assert.equal(result.cases[1]!.name, 'teardown');
  assert.ok(anyFailed([result]));
});

test('a failing suite setup errors every case; a tag filter skips; a dry run records nothing', async () => {
  const text = 'suite: s\nsetup: [{ action: core.fail }]\ntests:\n  - name: a\n    tags: [x]\n    steps: [{ action: core.noop }]\n  - name: b\n    steps: [{ action: core.noop }]\n';
  assert.deepEqual((await run(text)).sig, ['suite-setup::failed/action', 'case:a:error/suite-setup', 'case:b:error/suite-setup']);
  assert.deepEqual((await run(text.replace('core.fail', 'core.noop'), { tags: ['x'] })).sig, ['suite-setup::passed', 'step:a:passed', 'case:a:passed', 'case:b:skipped/tag']);
  const dry = await run(text, { dryRun: true });
  assert.deepEqual(dry.sig, []);
  assert.deepEqual(dry.result.cases.map(c => c.status), ['skipped', 'skipped']);
  assert.deepEqual((await run(text, { tags: ['none'] })).sig, ['case:a:skipped/tag', 'case:b:skipped/tag'], 'no selected case: no suite setup');
});

test('each way a step ends: guard skip, no action, unknown action, a lab action without a lab, a bad expression, a failed or scripted assertion', async () => {
  const { sig, result } = await run(`suite: s
tests:
  - name: guard
    steps:
      - { action: core.noop, ifCapture: nothing }
      - { action: core.set, value: { a: 1 }, captureAs: m }
      - { action: core.noop, ifCapture: m.a }
      - { action: core.noop, ifCapture: m.b }
      - { action: core.noop, ifCapture: m. }
  - name: none
    steps: [{ given: no action here }]
  - name: unknown
    steps: [{ action: no.such }]
  - name: lab
    steps: [{ action: inventory.get }]
  - name: expression
    steps: [{ action: core.set, value: '\${nope.x}' }]
  - name: assert
    steps:
      - { action: core.set, value: 1, captureAs: x, asserts: [{ var: x, equals: 2 }] }
  - name: script
    steps: [{ action: core.noop, asserts: [{ script: '$true' }] }]
  - name: badop
    steps:
      - { action: core.set, value: 1, captureAs: x, asserts: [{ var: x, gt: abc }] }
  - name: caseassert
    steps: [{ action: core.set, value: [1, 2], captureAs: l }]
    asserts:
      - { var: l.1, equals: 2 }
      - { var: l.5, isNull: true }
      - { var: l.x, isNull: true }
      - { var: nothing.y, isNull: true }
      - { equals: '\${nope.z}' }
`);
  assert.deepEqual(sig, [
    'step:guard:skipped/guard', 'step:guard:passed', 'step:guard:passed', 'step:guard:skipped/guard', 'step:guard:skipped/guard', 'case:guard:passed',
    'step:none:failed/action', 'case:none:failed/action', 'step:unknown:failed/action', 'case:unknown:failed/action',
    'step:lab:failed/action', 'case:lab:failed/action', 'step:expression:failed/action', 'case:expression:failed/action',
    'step:assert:failed/assertion', 'case:assert:failed/assertion', 'step:script:failed/assertion', 'case:script:failed/assertion',
    'step:badop:failed/assertion', 'case:badop:failed/assertion', 'step:caseassert:passed', 'case:caseassert:failed/action',
  ]);
  assert.match(result.cases[3]!.message, /No extension of this runtime registers it/);
  assert.match(result.cases[2]!.message, /Unknown action: no\.such/);
});

test('limits: a step past its own limit is cancelled, or abandoned when it cannot be interrupted; no time left; an extension\'s case limit', async () => {
  const late3s = () => new Promise<Value>(resolve => setTimeout(() => resolve(null), 3000));
  const slow: Extension = {
    name: 'slow',
    actions: [action('inventory.get', late3s), action('fixture.state', late3s)],
    rules: { caseLimitSec: (suite, declared) => (caseTags(suite, new Map()).includes('slow') ? 1 : declared) },
  };
  const { sig, result } = await run(`suite: s
tags: [lifecycle]
tests:
  - name: c
    timeoutSec: 99999
    steps:
      - { action: core.sleep, seconds: 5, timeoutSec: 1 }
    cleanup:
      - { action: inventory.get, timeoutSec: 1 }
`, {}, {}, [slow]);
  assert.deepEqual(sig, ['step:c:failed/timeout', 'case-cleanup:c:failed/timeout', 'case:c:failed/cleanup']);
  assert.match(result.cases[0]!.message, /cancelled/);
  // fixture.state holds a remote session, so the catalog marks it interruptible: false.
  const abandoned = await run('suite: s\ntests:\n  - name: c\n    steps: [{ action: fixture.state, timeoutSec: 1 }]\n', {}, {}, [slow]);
  assert.match(abandoned.result.cases[0]!.message, /was abandoned/);
  const late = await run('suite: s\ntests:\n  - name: c\n    steps: [{ action: core.noop, timeoutSec: 0 }]\n', {});
  assert.deepEqual(late.sig, ['step:c:passed', 'case:c:passed']);
  const cancelled = new AbortController();
  cancelled.abort();
  const stopped = await run('suite: s\ntests:\n  - name: c\n    steps: [{ action: core.sleep, seconds: 5 }]\n', { signal: cancelled.signal });
  assert.deepEqual(stopped.sig, ['step:c:failed/timeout', 'case:c:failed/timeout']);
  assert.ok(allNames(compose([slow], coreActions)).includes('inventory.get'));
  // The extension's rule caps a case tagged slow at 1 second, whatever the case declares.
  const capped = await run('suite: s\ntags: [slow]\ntests:\n  - name: c\n    timeoutSec: 600\n    steps: [{ action: core.sleep, seconds: 5 }]\n', {}, {}, [slow]);
  assert.deepEqual(capped.sig, ['step:c:failed/timeout', 'case:c:failed/timeout']);
});

test('tables collect a list; outlines run once per row; meta steps expand with defaults, with and a passed-down guard', async () => {
  const { sig, result } = await run(`suite: s
imports: [lib.yml]
metaSteps:
  - name: twice
    params: [{ name: who, default: x }]
    steps:
      - { action: core.set, value: ['\${param.who}', 1], captureAs: said }
tests:
  - name: o
    examples: [{ n: one }, { n: two }]
    steps:
      - when: the row is recorded
        action: core.record
        marker: '\${row.n}'
        captureAs: one
      - and: rows are recorded
        action: core.record
        marker: '\${row.m}'
        table: [{ m: a }, { m: b }]
        captureAs: seen
        asserts: [{ var: seen.marker, startsWith: '\${row.m}' }]
      - and: the list holds both
        action: core.noop
      - meta: twice
        with: { who: y }
        ifCapture: seen
      - meta: fromlib
    asserts:
      - { var: seen, count: 2 }
      - { var: said.0, equals: y }
`, {}, { 'lib.yml': 'metaSteps:\n  - name: fromlib\n    steps: [{ action: core.noop }]\n' });
  assert.equal(result.cases.length, 2);
  assert.deepEqual(result.cases.map(c => [c.name, c.status, c.message]), [['o [n=one]', 'passed', ''], ['o [n=two]', 'passed', '']]);
  assert.equal(sig.length, 14, "per row: four steps, two from the meta steps, the case");
  assert.match(result.cases[0]!.output, /"marker":"one"/);
});

test('wait: seconds, a forStep polled until it holds, giving up, and a wait with nothing to do', async () => {
  const { sig, result } = await run(`suite: s
tests:
  - name: sec
    steps: [{ action: wait, seconds: 0.05 }]
  - name: poll
    steps:
      - { action: core.set, value: 1, captureAs: x }
      - action: wait
        intervalSec: 1
        timeoutSec: 5
        forStep: { action: core.set, value: 2, captureAs: x }
        until: { var: x, equals: 2 }
  - name: plain
    steps: [{ action: wait, forStep: { action: core.noop } }]
  - name: never
    steps:
      - action: wait
        intervalSec: 1
        timeoutSec: 1
        forStep: { action: core.fail }
  - name: nothing
    steps: [{ action: wait }]
  - name: untilnever
    steps:
      # 2, not 1: the polled step has whole seconds left, so with 1 a slow
      # machine's poll had none and never reached until.
      - action: wait
        intervalSec: 1
        timeoutSec: 2
        forStep: { action: core.noop }
        until: { var: nope, equals: 1 }
`);
  assert.deepEqual(result.cases.map(c => c.status), ['passed', 'passed', 'passed', 'failed', 'failed', 'failed']);
  assert.ok(sig.includes('step:never:failed/timeout'));
  assert.ok(sig.includes('step:nothing:failed/action'));
});

test('core actions directly: set needs a value, record needs a marker and appends, sleep honours the signal', async () => {
  const handler = (name: string) => coreActions.find(r => r.name === name)!.handler;
  const req = (step: Record<string, Value>, recordPath = '') => ({ action: 'x', step: mapOf(step), signal: new AbortController().signal, recordPath });
  await assert.rejects(handler('core.set')(req({})), /value is required/);
  await assert.rejects(handler('core.record')(req({})), /marker is required/);
  await assert.rejects(handler('core.fail')(req({ message: 'why' })), /why/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-record-')), 'r.txt');
  await handler('core.record')(req({ marker: 'one' }, file));
  await handler('core.record')(req({ marker: 'two' }, file));
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\ntwo\n');
  await assert.rejects(handler('core.record')(req({ marker: 'x' }, path.join(file, 'not-a-dir', 'r.txt'))), /cannot be written/);
  assert.deepEqual([...(await handler('core.sleep')(req({ seconds: 0 })) as ValueMap)], [['sleptSec', 0]]);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(sleep(10, stop.signal, 'x'), (e: unknown) => e instanceof ActionError && e.reason === 'timeout');
});

test('suite.ts: libraries depth first and their refusals; parameters lowest first; vars; labels; tags; limits', () => {
  const files = { 'a.yml': 'imports: [b.yml]\nparams:\n  - { name: p, default: a }\nvars:\n  v: a\ndefaults:\n  target: A\n', 'b.yml': 'params:\n  - { name: p, default: b }\n  - { name: q }\nvars:\n  v: b\n' };
  const reader = overlayReader(Object.fromEntries(Object.entries(files).map(([k, v]) => [at(k), v])));
  const lib = readLibraries(doc('imports: [a.yml, 3]\n'), at('s.yml'), reader);
  assert.deepEqual(lib.params.map(p => p.get('default')), ['b', null, 'a'].map(v => v ?? undefined).map(v => v === undefined ? undefined : v).slice(0, 3).map((v, i) => (i === 1 ? undefined : v)));
  assert.equal(lib.vars.get('v'), 'a');
  assert.equal(lib.defaults.get('target'), 'A');
  assert.throws(() => readLibraries(doc('imports: [s.yml]\n'), at('s.yml'), reader), /forms a cycle/);
  assert.throws(() => readLibraries(doc('imports: [none.yml]\n'), at('s.yml'), reader), /does not exist/);
  assert.throws(() => readLibraries(doc('imports: [bad.yml]\n'), at('s.yml'), overlayReader({ [at('bad.yml')]: 'a: [1' })), /not valid YAML/);
  assert.throws(() => readLibraries(doc('imports: [list.yml]\n'), at('s.yml'), overlayReader({ [at('list.yml')]: '- 1\n' })), /does not hold a YAML mapping/);
  const suite = doc('params:\n  - { name: p, default: file }\n  - { name: r }\n');
  const c = doc('params:\n  - { name: p, value: case }\n  - { name: k }\n  - { other: 1 }\n');
  assert.deepEqual([...resolveParams(lib, suite, c, [])], [['p', 'case'], ['q', undefined]].filter(([, v]) => v !== undefined));
  assert.deepEqual([...resolveParams(lib, suite, c, [['p', 'cli']], { BDD_SUITE_PARAM_P: 'env', BDD_SUITE_PARAM_R: 'r' })], [['p', 'cli'], ['r', 'r']]);
  const scope = new Map<string, Value>([['param', mapOf({})]]);
  resolveVars(lib, doc('vars:\n  w: \'${var.v}2\'\n'), doc('vars:\n  x: 1\n'), scope);
  assert.deepEqual([...(scope.get('var') as ValueMap)], [['v', 'a'], ['w', 'a2'], ['x', 1n]]);
  assert.equal(stepLabel(mapOf({ action: 'a' })), 'step a');
  assert.equal(stepLabel(mapOf({ action: 'a', __provenance: 'step 2', __rowIndex: 1n, __row: mapOf({ n: 1n }) })), 'step 2 (a) row 1 (n=1)');
  assert.equal(formatRow('x'), '');
  assert.deepEqual(caseTags(doc('tags: [s]\n'), doc('tags: [c, 3]\n')), ['c', 's']);
  assert.ok(tagsMatch(['a'], []) && tagsMatch(['a'], ['a', 'b']) && !tagsMatch(['a'], ['b']));
  assert.deepEqual([stepLimit(5, 10), stepLimit(20, 10), stepLimit(0, 10)], [5, 10, 10]);
  assert.deepEqual(expandOutline(doc('name: c\nexamples: []\n')).length, 1);
  assert.equal(metaDefinitions(doc('metaSteps: [{ name: m, steps: [] }]\n'), lib).has('m'), true);
});

test('expandSteps: an unknown meta step, nesting past five, an and with nothing before it, a table that is not a list', () => {
  const defs = new Map<string, ValueMap>();
  for (let i = 0; i < 7; i++) defs.set(`m${i}`, doc(`steps:\n  - meta: m${i + 1}\n`));
  assert.throws(() => expandSteps([doc('meta: zz\n')], defs, 'case c'), /uses meta step zz, which is not declared/);
  assert.throws(() => expandSteps([doc('meta: m0\n')], defs, 'case c'), /deeper than 5/);
  const steps = expandSteps([doc('and: first\naction: core.noop\n'), doc('action: core.noop\ntable: 3\n'), 'text'], defs, 'case c');
  assert.deepEqual(steps.map(s => [s.get('__keyword'), s.get('__sentence')]), [['and', 'first']]);
});
