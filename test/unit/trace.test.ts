// B6.1-B6.5: row names, the trace and report readers, item results.
import * as assert from 'assert';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import {
  aggregate, isLabSuite, mapDryRun, mapTrace, outlineRowName, parseNUnit, parseTrace, reportedNames, selectionTags, TraceEntry,
} from '../../src/core/trace';

test('B6.1-1 outlineRowName: columns in written order, strings, numbers, booleans, null and objects as the bindings print them', () => {
  assert.strictEqual(outlineRowName('c', { node: 'N1', expected: 'N1' }), 'c [node=N1, expected=N1]');
  assert.strictEqual(outlineRowName('c', { n: 2, x: 1.5, ok: true, none: null, list: [1, 'a'] }), 'c [n=2, x=1.5, ok=true, none=, list=[1,"a"]]');
  assert.deepStrictEqual(reportedNames({ name: 'c', examples: [{ a: 1 }, { a: 2 }] }), ['c [a=1]', 'c [a=2]']);
  assert.deepStrictEqual(reportedNames({ name: 'c', examples: [] }), ['c']);
});

test('parseTrace: an array of entries, or undefined for anything else (B6.2-2)', () => {
  assert.deepStrictEqual(parseTrace('[{"phase":"case","case":"a","status":"passed"}]'), [{ phase: 'case', case: 'a', status: 'passed' }]);
  assert.deepStrictEqual(parseTrace('[]'), []);
  for (const bad of ['', 'not json', '{"phase":"case"}', '[{"phase":"case"}]', '[null]', '[3]']) assert.strictEqual(parseTrace(bad), undefined, bad);
});

test('parseNUnit: each test-case\'s result and decoded message; self-closing and CDATA', () => {
  const xml = `<test-run><test-suite>
    <test-case id="1" name="a &amp; b [n=1]" result="Passed" />
    <test-case id="2" name="fails" result="Failed"><failure><message>then x (core.noop): expected &apos;P&apos;, got &#39;U&#39; &#x41;</message></failure></test-case>
    <test-case id="3" name="cdata" result="Failed"><failure><message><![CDATA[raw <text> & more]]></message></failure></test-case>
    <test-case id="4" result="Passed" />
  </test-suite></test-run>`;
  const r = parseNUnit(xml);
  assert.deepStrictEqual([...r.keys()], ['a & b [n=1]', 'fails', 'cdata']);
  assert.deepStrictEqual(r.get('a & b [n=1]'), { result: 'Passed' });
  assert.strictEqual(r.get('fails')!.message, "then x (core.noop): expected 'P', got 'U' A");
  assert.strictEqual(r.get('cdata')!.message, 'raw <text> & more');
  assert.strictEqual(parseNUnit('').size, 0);
});

const corpus = process.env.OS_CONTEXT_ROOT && path.join(process.env.OS_CONTEXT_ROOT, 'test/e2e/conformance/execute');

test('B6.2-1 mapTrace over every real expected trace: one result per case entry, with its state', t => {
  if (!corpus || !fs.existsSync(corpus)) {
    t.skip('OS_CONTEXT_ROOT is not set; the real traces were not read');
    return;
  }
  const states: Record<string, string> = { passed: 'passed', failed: 'failed', error: 'errored', skipped: 'skipped' };
  let n = 0;
  for (const f of fs.readdirSync(corpus).filter(x => x.endsWith('.expected.json'))) {
    const trace = JSON.parse(fs.readFileSync(path.join(corpus, f), 'utf8')).trace as TraceEntry[];
    const mapped = mapTrace(trace);
    const entries = trace.filter(e => e.phase === 'case');
    assert.deepStrictEqual([...mapped.cases.keys()], entries.map(e => e.case), f);
    for (const e of entries) {
      assert.strictEqual(mapped.cases.get(e.case!)!.state, states[e.status], `${f} ${e.case}`);
      n++;
    }
  }
  assert.ok(n >= 20, `${n} case entries`);
  const gherkin = mapTrace(JSON.parse(fs.readFileSync(path.join(corpus, 'gherkin.expected.json'), 'utf8')).trace);
  assert.deepStrictEqual(gherkin.cases.get('a-failure-says-the-sentence-and-the-keyword'),
    { state: 'failed', message: 'then it reads Paused, which it does not (core.noop) failed (assertion)' });
  assert.ok(gherkin.cases.has('an-outline-named-by-its-columns [node=N1, expected=N1]'));
  const setup = mapTrace(JSON.parse(fs.readFileSync(path.join(corpus, 'setup-fails.expected.json'), 'utf8')).trace);
  assert.deepStrictEqual(setup.file, ['suite setup: step 2 (core.fail) failed (action)']);
  assert.match(setup.cases.get('first')!.message!, /^error \(suite-setup\)|suite setup: step 2/);
});

test('mapTrace: hook failures name the hook; the report\'s message is added once; skips say why; an unknown status is an error', () => {
  const trace: TraceEntry[] = [
    { phase: 'case-setup', case: 'a', step: 'step 1 (core.fail)', action: 'core.fail', status: 'failed', reason: 'action' },
    { phase: 'case', case: 'a', status: 'failed', reason: 'hook' },
    { phase: 'step', case: 'b', step: 'then x (core.noop)', status: 'failed', reason: 'assertion' },
    { phase: 'case', case: 'b', status: 'failed', reason: 'assertion' },
    { phase: 'case', case: 'c', status: 'skipped', reason: 'tag' },
    { phase: 'case', case: 'd', status: 'skipped' },
    { phase: 'case', case: 'e', status: 'weird' },
    { phase: 'case', case: 'f', status: 'failed' },
    { phase: 'case', status: 'passed' },
    { phase: 'suite-teardown', step: 'step 1 (core.fail)', status: 'failed', reason: 'action' },
    { phase: 'suite-setup', step: 'step 1 (core.set)', status: 'failed' },
    { phase: 'case', case: 'g', status: 'error', reason: 'suite-setup' },
    { phase: 'case', case: 'h', status: 'failed', reason: 'timeout' },
    { phase: 'after-each', case: 'i', status: 'failed' },
    { phase: 'case', case: 'i', status: 'failed', reason: 'hook' },
  ];
  const report = new Map([['b', { result: 'Failed', message: "then x (core.noop): expected state equals 'P', got 'U'" }],
    ['a', { result: 'Failed', message: 'case setup: step 1 (core.fail) failed (action)' }]]);
  const m = mapTrace(trace, report);
  assert.deepStrictEqual(m.cases.get('a'), { state: 'failed', message: 'case setup: step 1 (core.fail) failed (action)' });
  assert.deepStrictEqual(m.cases.get('b'), { state: 'failed', message: "then x (core.noop) failed (assertion)\nthen x (core.noop): expected state equals 'P', got 'U'" });
  assert.deepStrictEqual(m.cases.get('c'), { state: 'skipped', message: 'skipped (tag)' });
  assert.deepStrictEqual(m.cases.get('d'), { state: 'skipped', message: 'skipped' });
  assert.deepStrictEqual(m.cases.get('e'), { state: 'errored', message: 'weird' });
  assert.deepStrictEqual(m.cases.get('f'), { state: 'failed', message: 'failed' });
  assert.deepStrictEqual(m.cases.get('g'), { state: 'errored', message: 'suite setup: step 1 (core.set) failed' });
  assert.deepStrictEqual(m.file, ['suite teardown: step 1 (core.fail) failed (action)', 'suite setup: step 1 (core.set) failed']);
  assert.deepStrictEqual(m.cases.get('h'), { state: 'failed', message: 'failed (timeout)' });
  assert.deepStrictEqual(m.cases.get('i'), { state: 'failed', message: 'afterEach: after-each failed' });
  assert.strictEqual(m.cases.size, 9);
});

test('B6.5 a partial trace maps what it reports, and nothing else', () => {
  const m = mapTrace([{ phase: 'step', case: 'a', step: 's', status: 'passed' }, { phase: 'case', case: 'a', status: 'passed' },
    { phase: 'step', case: 'b', step: 'given a sleep (core.sleep)', status: 'running' }]);
  assert.deepStrictEqual([...m.cases], [['a', { state: 'passed' }]]);
});

test('B6.3 mapDryRun: every case the report lists is skipped "would run"', () => {
  const m = mapDryRun(new Map([['a', { result: 'Skipped' }], ['b [n=1]', { result: 'Skipped' }]]));
  assert.deepStrictEqual([...m.cases], [['a', { state: 'skipped', message: 'would run (dry run)' }], ['b [n=1]', { state: 'skipped', message: 'would run (dry run)' }]]);
  assert.deepStrictEqual(m.file, []);
});

test('aggregate: failure first, then error, all skipped is skipped, else passed; nothing is no result', () => {
  assert.strictEqual(aggregate(['passed', 'failed', 'errored']), 'failed');
  assert.strictEqual(aggregate(['passed', 'errored']), 'errored');
  assert.strictEqual(aggregate(['skipped', 'skipped']), 'skipped');
  assert.strictEqual(aggregate(['skipped', 'passed']), 'passed');
  assert.strictEqual(aggregate([]), undefined);
});

test('selectionTags: all is no filter; a tag that selects exactly the chosen cases; otherwise none', () => {
  const cases = [{ name: 'a', tags: ['portable', 'x'] }, { name: 'b', tags: ['portable'] }, { name: 'c', tags: ['x'] }];
  assert.deepStrictEqual(selectionTags(cases, new Set(['a', 'b', 'c'])), []);
  assert.deepStrictEqual(selectionTags(cases, new Set(['a', 'b'])), ['portable']);
  assert.deepStrictEqual(selectionTags(cases, new Set(['a', 'c'])), ['x']);
  assert.strictEqual(selectionTags(cases, new Set(['a'])), undefined);
});

test('B6.4 item 1 isLabSuite: only core.* and wait are offline', () => {
  assert.strictEqual(isLabSuite(['core.set', 'core.noop', 'wait']), false);
  assert.strictEqual(isLabSuite([]), false);
  assert.strictEqual(isLabSuite(['core.set', 'lifecycle.get']), true);
  assert.strictEqual(isLabSuite(['cluster.state']), true);
});
