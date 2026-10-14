// B1.3: parseSuite, findExpressions; B1.3-1 against the real tree with the oracle.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { findExpressions, parseSuite } from '../../src/core/suites';
import { StepInfo } from '../../src/core/types';
import { oracleSteps, oracleSuiteFiles } from '../integration/harness/oracle';

const SUITE = `suite: demo
imports:
  - _lib/lib.yml
  - 7
  - { not: scalar }
params:
  - { name: node, type: string }
  - { type: string }
vars:
  limit: \${int(param.n) * 2}
setup:
  - action: core.set
    captureAs: agent
    value: 1
teardown:
  - action: core.noop
beforeEach:
  - meta: select-lab
    with: { labId: '\${labId}', other: 1 }
afterEach:
  - action: core.noop
metaSteps:
  - name: select-lab
    params:
      - { name: labId, required: true }
    exports: [source]
    steps:
      - action: lifecycle.select
        captureAs: source
  - params: []
tests:
  - name: first
    tags: [a, b]
    params:
      - { name: node, value: x }
    vars:
      v1: 1
    setup:
      - action: core.noop
    steps:
      - given: a thing
        when: ignored second keyword
        action: cluster.state
        target: \${capture.agent.Name}
        captureAs: cs
      - and: more
        action: wait
        forStep:
          action: lifecycle.get
          route: /labs/\${capture.cs.Id}
      - { then: flow style, action: core.noop, note: 'a \${lower("}{")} b' }
      - ? [complex, key]
        : ignored
        action: core.noop
        empty:
        ? lonely
      - when: table
        action: cluster.state
        table:
          - { node: N1, drain: true }
          - { node: N2, drain: false }
      - "just a string"
      - action: [not, scalar]
        meta: [no]
        captureAs: [no]
        then: [no]
        script: |
          Get-Thing \${param.node}
    cleanup:
      - action: core.noop
  - tags: [x]
    examples:
      - { node: a, mode: b }
      - { node: c, mode: d }
    steps:
      - when: no sentence key value
        action: core.noop
        table: not-a-list
  - just-a-string
`;

const parsed = parseSuite(SUITE, path.resolve('/r/test/e2e/suites/demo.yml'));
const byAction = (a: string): StepInfo[] => parsed.steps.filter(s => s.action === a);

test('suite header: name, imports, params, vars', () => {
  assert.strictEqual(parsed.hasSuiteKey, true);
  assert.strictEqual(parsed.suiteName, 'demo');
  assert.deepStrictEqual(parsed.imports.map(i => i.path), ['_lib/lib.yml', '7']);
  assert.strictEqual(parsed.imports[0].resolved, path.resolve('/r/test/e2e/suites/_lib/lib.yml'));
  assert.deepStrictEqual(parsed.params.map(p => p.name), ['node']);
  assert.deepStrictEqual(parsed.vars.map(v => [v.name, v.caseName]), [['limit', undefined], ['v1', 'first']]);
  assert.strictEqual(parsed.parseError, undefined);
});

test('meta steps: name, params, exports', () => {
  assert.deepStrictEqual(parsed.metaSteps.map(m => [m.name, m.params, m.exports]), [['select-lab', ['labId'], ['source']]]);
});

test('cases: tags, params, examples', () => {
  assert.deepStrictEqual(parsed.cases.map(c => [c.name, c.tags, c.params, c.examplesRows, c.examplesColumns]), [
    ['first', ['a', 'b'], ['node'], 0, undefined],
    ['#2', ['x'], [], 2, ['node', 'mode']],
  ]);
});

test('B1.3-2 home of each hook position, a case and a meta step', () => {
  const homes = parsed.steps.map(s => JSON.stringify(s.home));
  assert.deepStrictEqual(homes, [
    '{"kind":"hook","hook":"setup"}',
    '{"kind":"hook","hook":"teardown"}',
    '{"kind":"hook","hook":"beforeEach"}',
    '{"kind":"hook","hook":"afterEach"}',
    '{"kind":"meta","metaName":"select-lab"}',
    '{"kind":"hook","hook":"setup","caseName":"first"}',
    '{"kind":"case","caseName":"first","caseIndex":0}',
    '{"kind":"case","caseName":"first","caseIndex":0}',
    '{"kind":"case","caseName":"first","caseIndex":0}',
    '{"kind":"case","caseName":"first","caseIndex":0}',
    '{"kind":"case","caseName":"first","caseIndex":0}',
    '{"kind":"case","caseName":"first","caseIndex":0}',
    '{"kind":"case","caseName":"first","caseIndex":0}',
    '{"kind":"hook","hook":"cleanup","caseName":"first"}',
    '{"kind":"case","caseName":"#2","caseIndex":1}',
  ]);
  assert.deepStrictEqual(parsed.steps.map(s => s.index), parsed.steps.map((_, i) => i));
});

test('keywords: first wins; sentence; and; flow style', () => {
  const [state] = byAction('cluster.state');
  assert.strictEqual(state.keyword, 'given');
  assert.strictEqual(state.sentence, 'a thing');
  assert.strictEqual(byAction('wait')[0].keyword, 'and');
  const flow = parsed.steps.find(s => s.sentence === 'flow style')!;
  assert.strictEqual(flow.keyword, 'then');
  assert.deepStrictEqual(flow.params.map(p => p.name), ['note']);
});

test('action, meta, with, captureAs, table, params', () => {
  const [state, table] = byAction('cluster.state');
  assert.strictEqual(state.captureAs, 'cs');
  assert.deepStrictEqual(state.params.map(p => [p.name, p.value]), [['target', '${capture.agent.Name}']]);
  assert.deepStrictEqual(table.tableColumns, ['node', 'drain']);
  const use = parsed.steps[2];
  assert.strictEqual(use.meta, 'select-lab');
  assert.deepStrictEqual(use.withKeys.map(k => k.name), ['labId', 'other']);
  const last = parsed.steps[parsed.steps.length - 1];
  assert.deepStrictEqual(last.tableColumns, []);
  const odd = parsed.steps[12];
  const complex = parsed.steps[10];
  assert.deepStrictEqual(complex.params.map(p => [p.name, p.value]), [['empty', null], ['lonely', null]]);
  assert.strictEqual(odd.action, undefined);
  assert.strictEqual(odd.meta, undefined);
  assert.strictEqual(odd.captureAs, undefined);
  assert.strictEqual(odd.keyword, 'then');
  assert.strictEqual(odd.sentence, undefined);
});

test('forStep is its own step with the parent home, after the parent', () => {
  const waitIdx = parsed.steps.findIndex(s => s.action === 'wait');
  assert.strictEqual(parsed.steps[waitIdx + 1].action, 'lifecycle.get');
  assert.deepStrictEqual(parsed.steps[waitIdx + 1].home, parsed.steps[waitIdx].home);
  assert.deepStrictEqual(parsed.steps[waitIdx].expressions, []);
});

test('B1.3-3 every ${...} recorded from $ through }', () => {
  const lines = SUITE.split('\n');
  const all = parsed.steps.flatMap(s => s.expressions);
  assert.deepStrictEqual(all.map(e => e.text), [
    '${labId}', '${capture.agent.Name}', '${capture.cs.Id}', '${lower("}{")}', '${param.node}',
  ]);
  for (const e of all) {
    assert.strictEqual(lines[e.range.start.line].slice(e.range.start.character, e.range.end.character), e.text);
  }
});

test('findExpressions: nesting, quotes, escapes, unterminated', () => {
  const src = `a \${f({x: 1})} \${"\\"}"} \${'}'} \${open`;
  assert.deepStrictEqual(findExpressions(src).map(([s, e]) => src.slice(s, e)),
    ['${f({x: 1})}', '${"\\"}"}', "${'}'}"]);
  assert.deepStrictEqual(findExpressions('none'), []);
});

test('a library (no suite key) and a non-mapping root', () => {
  const lib = parseSuite('metaSteps:\n  - name: m\n    steps:\n      - action: core.noop\n', '/l.yml');
  assert.strictEqual(lib.hasSuiteKey, false);
  assert.strictEqual(lib.steps.length, 1);
  const list = parseSuite('- a\n- b\n', '/x.yml');
  assert.strictEqual(list.steps.length, 0);
  assert.strictEqual(list.hasSuiteKey, false);
});

test('B1.3-4 a broken file is BDD030 at the parser position', () => {
  const broken = parseSuite('suite: x\ntests:\n  - name: [oops\n', '/b.yml');
  assert.strictEqual(broken.parseError!.code, 'BDD030');
  assert.strictEqual(broken.parseError!.range.start.line >= 2, true);
  assert.strictEqual(broken.steps.length, 0);
});

test('B1.3-1 indexed steps equal the oracle for every real suite', (t) => {
  const root = process.env.OS_CONTEXT_ROOT;
  if (!root) {
    t.skip('OS_CONTEXT_ROOT is not set; the real tree was not checked');
    return;
  }
  let files = 0, steps = 0;
  const times: number[] = [];
  for (const file of oracleSuiteFiles(root)) {
    const text = fs.readFileSync(file, 'utf8');
    const started = process.hrtime.bigint();
    const s = parseSuite(text, file);
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    const mine = s.steps.filter(x => x.action !== undefined).map(x => `${x.actionRange!.start.line}:${x.action}`).sort();
    const oracle = oracleSteps(file, text).map(x => `${x.line}:${x.action}`).sort();
    assert.deepStrictEqual(mine, oracle, file);
    files++;
    steps += mine.length;
  }
  t.diagnostic(`B1.3-1: ${files} files, ${steps} action steps agree with the oracle`);
});

test('B1.3 item 6: parse time of lifecycle-stage1.yml over 20 runs', (t) => {
  const root = process.env.OS_CONTEXT_ROOT;
  if (!root) {
    t.skip('OS_CONTEXT_ROOT is not set');
    return;
  }
  const file = path.join(root, 'test/e2e/suites/lifecycle-stage1.yml');
  const text = fs.readFileSync(file, 'utf8');
  parseSuite(text, file);
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const s = process.hrtime.bigint();
    parseSuite(text, file);
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  times.sort((a, b) => a - b);
  t.diagnostic(`lifecycle-stage1.yml (${text.length} chars): p50 ${times[9].toFixed(1)} ms, max ${times[19].toFixed(1)} ms`);
});
