// semantics.ts and dataflow.ts on small fixtures read through overlays: each
// rule and its position, beside what the 48 corpus entries already pin.
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { corpusComposite, corpusSchema, repo } from '../where.js';
import { compose } from '../../src/extension.js';
import { coreActions } from '../../src/actions/core.js';
import { error } from '../../src/diag.js';
import { START } from '../../src/model.js';
import { overlayReader } from '../../src/reader.js';
import { loadSchema } from '../../src/schema.js';
import { validateFile } from '../../src/validate/index.js';
import { walkShape } from '../../src/validate/dataflow.js';
import { mapOf } from '../../src/value.js';

const root = repo;
const schema = loadSchema(corpusSchema);
const dir = path.join(root, 'test', 'e2e', 'suites');
const at = (f: string) => path.join(dir, f);

function lint(text: string, files: Record<string, string> = {}, options: { params?: [string, string][]; bindingCheck?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const file = at('_unit.yml');
  const overlays = Object.fromEntries([[file, text], ...Object.entries(files).map(([k, v]) => [at(k), v])]);
  return validateFile(file, 'u.yml', schema, { binding: 'go', bindingCheck: !!options.bindingCheck, params: options.params ?? [], env: options.env ?? {}, extensions: corpusComposite },
    overlayReader(overlays)).filter(d => !/^E10[1-5]$/.test(d.code)).map(d => `${d.code} ${d.position.line}:${d.position.column}`);
}
const CASE = 'tests:\n  - name: c\n    steps:\n      - action: core.noop\n';

test('imports: missing, a cycle, not YAML, not a mapping, a library that runs', () => {
  assert.deepEqual(lint(`suite: s\nimports:\n  - nope.yml\n${CASE}`), ['E301 3:5']);
  assert.deepEqual(lint(`suite: s\nimports:\n  - _unit.yml\n${CASE}`), ['E207 3:5']);
  assert.deepEqual(lint(`suite: s\nimports:\n  - bad.yml\n${CASE}`, { 'bad.yml': 'a: [1' }), ['E100 3:5']);
  assert.deepEqual(lint(`suite: s\nimports:\n  - list.yml\n${CASE}`, { 'list.yml': '- 1\n' }), ['E100 3:5']);
  assert.deepEqual(lint(`suite: s\nimports:\n  - runs.yml\n${CASE}`, { 'runs.yml': 'setup: []\n' }), ['E211 3:5']);
  assert.deepEqual(lint(`suite: s\nimports:\n  - 7\n  - ''\n${CASE}`), []);
});

test('E209 a local name that an import declares, unless it says override', () => {
  const lib = 'params:\n  - { name: p, default: x }\n  - nope\nvars:\n  v: 1\nmetaSteps:\n  - name: m\n    steps: [{ action: core.noop }]\n  - nope\ndefaults:\n  target: t\n';
  assert.deepEqual(lint(`suite: s\nimports: [lib.yml]\nparams:\n  - { name: p, default: y }\n  - nope\nvars:\n  v: 2\nmetaSteps:\n  - name: m\n    steps: [{ action: core.noop }]\n  - nope\n${CASE}`, { 'lib.yml': lib }),
    ['E209 4:7', 'W303 4:13', 'E209 7:3', 'E209 9:5']);
  assert.deepEqual(lint(`suite: s\nimports: [lib.yml]\nparams:\n  - { name: p, default: y, override: true }\nmetaSteps:\n  - name: m\n    override: true\n    steps: [{ action: core.noop }]\n${CASE}`, { 'lib.yml': lib }),
    ['W303 4:13']);
});

test('E210 a parameter with no value at any level, a --param that names nothing; an environment value counts', () => {
  const s = `suite: s\nparams:\n  - { name: p }\n${CASE}      - action: core.set\n        value: \${param.p}\n`;
  assert.deepEqual(lint(s), ['E210 3:5']);
  assert.deepEqual(lint(s, {}, { params: [['p', '1']] }), []);
  assert.deepEqual(lint(s, {}, { env: { BDD_SUITE_PARAM_P: '1' } }), []);
  assert.deepEqual(lint(s, {}, { params: [['p', '1'], ['q', '2']] }), ['E210 1:1']);
  assert.deepEqual(lint(`suite: s\n${CASE.replace('steps:', 'params:\n      - { name: k, value: 1 }\n      - nope\n    steps:')}`), []);
  assert.deepEqual(lint(`suite: s\n${CASE.replace('steps:', 'params:\n      - { name: k }\n    steps:')}`), ['E210 5:9']);
});

test('E206 E207 E208: unknown meta steps, cycles and depth, parameters at the use site', () => {
  const metas = (n: number) => Array.from({ length: n }, (_, i) => `  - name: m${i}\n    steps:\n      - ${i + 1 < n ? `meta: m${i + 1}` : 'action: core.noop'}\n`).join('');
  assert.deepEqual(lint(`suite: s\nmetaSteps:\n${metas(7)}${CASE}`), ['E207 3:5', 'E207 6:5'], 'm0 nests 7 deep and m1 6');
  assert.deepEqual(lint(`suite: s\nmetaSteps:\n  - name: a\n    steps: [{ meta: b }]\n  - name: b\n    steps: [{ meta: a }]\n  - nope\n${CASE}`), ['E207 3:5', 'E207 5:5']);
  const m = 'metaSteps:\n  - name: m\n    params:\n      - { name: need, required: true }\n      - { name: opt, required: true, default: 1 }\n      - nope\n    steps: [{ action: core.noop }]\n';
  assert.deepEqual(lint(`suite: s\n${m}tests:\n  - name: c\n    steps:\n      - meta: m\n        with: { extra: 1 }\n      - meta: mm\n`), ['E208 12:15', 'E208 13:17', 'E206 14:15']);
});

test('E205 limits: every limit between 1 and 14400', () => {
  assert.deepEqual(lint(`suite: s\nsetupTimeoutSec: 0\ndefaults:\n  timeoutSec: 99999\n  cleanupTimeoutSec: soon\n${CASE.replace('- name: c', '- name: c\n    timeoutSec: 30')}`), ['E205 2:18', 'E205 4:15']);
  assert.deepEqual(lint(`suite: s\ndefaults: 3\n${CASE}`), []);
});

test('E202 E203 E204 E212 E213 W304, and E201 W302 from the catalog', () => {
  assert.deepEqual(lint(`suite: s\ntests:\n  - name: c\n    steps:\n      - when: x\n        then: y\n        action: core.noop\n      - and: z\n        action: core.noop\n      - given: back\n        action: core.noop\n  - name: c\n    steps:\n      - and: first\n        action: core.noop\n      - action: core.noop\n  - 3\n`),
    ['E212 6:9', 'E212 10:9', 'E202 12:11', 'W304 13:5', 'E212 14:9']);
  assert.deepEqual(lint(`suite: s\ntests:\n  - name: c\n    examples:\n      - { a: 1 }\n      - { a: 1 }\n      - { b: 1 }\n    steps:\n      - action: core.set\n        value: \${row.a}\n        table: []\n`),
    ['E213 6:9', 'E213 7:9', 'E213 11:9', 'E213 11:9']);
  assert.deepEqual(lint(`suite: s\ntests:\n  - name: c\n    steps:\n      - action: core.set\n        value: 1\n        captureAs: x\n        asserts:\n          - { var: x }\n          - { equals: 1 }\n          - 3\n    asserts:\n      - { var: x, equals: 1 }\n    cleanup:\n      - action: core.set\n        value: 2\n        captureAs: x\n`),
    ['E204 9:13', 'E204 10:13', 'E203 17:20']);
  assert.deepEqual(lint(`suite: s\n${CASE.replace('core.noop', 'fixture.state')}`, {}, { bindingCheck: true }), ['E201 5:17']);
});


test('dataflow: captures, paths, rows, defaults, vars, params, scripts, guards, exports, stable vars', () => {
  const s = `suite: s
params:
  - { name: used, default: 1 }
  - { name: unused, default: 1 }
  - nope
defaults:
  target: t
vars:
  v: \${uuid()}
tests:
  - name: c
    vars:
      w: 1
    steps:
      - action: fixture.state
        captureAs: cs
      - action: core.set
        value: \${capture.cs.Nodes.0.Name} \${capture.cs.Nope} \${capture} \${capture.zz} \${defaults.target} \${defaults.no}
        captureAs: later
        ifCapture: cs.State
      - action: core.set
        value: \${var.v} \${var.w} \${var.x} \${param.used} \${param.no} \${row} \${cs} \${clusterr} \${target} \${len(}
        ifCapture: nothere
      - action: core.set
        value: \${capture.later}
        asserts:
          - { script: '$capture.later -eq 1' }
          - { var: cs.Nodes.x, equals: 1 }
          - { var: nothing, equals: 1 }
          - { var: later, matches: '(?<=a)b' }
          - 3
`;
  // ifCapture cs.State resolves through cs; line 22 has five E301s (var.x, param.no, row, cs, clusterr) and one E305.
  assert.deepEqual(lint(s), [
    'W303 4:13', 'E309 9:6', 'E301 18:16', 'E301 18:16', 'E301 18:16', 'E302 18:16',
    'E301 22:16', 'E301 22:16', 'E301 22:16', 'E301 22:16', 'E301 22:16', 'E305 22:16',
    'E301 23:20', 'E302 28:20', 'E301 29:20', 'E308 30:36',
  ]);
});

test('dataflow: E303 read before produced, E304 an export nothing captures, row columns, a table step\'s own asserts', () => {
  const s = `suite: s
metaSteps:
  - name: m
    exports: [made, never, 3]
    steps:
      - action: core.set
        value: 1
        captureAs: made
  - nope
tests:
  - name: c
    examples:
      - { node: N1 }
    steps:
      - action: core.set
        value: \${capture.late} \${row.node} \${row.nope} \${row}
      - action: core.set
        value: 1
        captureAs: late
      - action: core.record
        marker: \${row.col}
        table:
          - { col: a }
        captureAs: rows
        asserts:
          - { var: rows.marker, equals: a }
      - meta: m
      - action: core.set
        value: \${capture.made} \${capture.rows.0.marker} \${capture.rows.x}
`;
  // W301 at 1:1: the export `never` is produced at the meta use site, which has no captureAs to point at (as in every binding).
  assert.deepEqual(lint(s), ['W301 1:1', 'E304 4:21', 'E301 16:16', 'E301 16:16', 'E303 16:16', 'E213 22:9', 'E302 29:16']);
});

test('walkShape: open shapes accept anything; arrays take an index; scalars have nothing inside', () => {
  const shape = mapOf({ type: 'object', additionalProperties: false, properties: mapOf({ list: mapOf({ type: 'array', items: mapOf({ type: 'string' }) }), any: mapOf({ type: 'any' }) }) });
  assert.deepEqual(walkShape(shape, ['list', '0']), { ok: true });
  assert.deepEqual(walkShape(shape, ['list', 'x']), { ok: false, expected: 'an index into an array' });
  assert.deepEqual(walkShape(shape, ['list', '0', 'y']), { ok: false, expected: 'a string, which has no y inside it' });
  assert.deepEqual(walkShape(shape, ['any', 'deep']), { ok: true });
  assert.deepEqual(walkShape(shape, ['nope']), { ok: false, expected: 'not declared', candidates: ['list', 'any'] });
  assert.deepEqual(walkShape(mapOf({ type: 'object', additionalProperties: true }), ['x']), { ok: true });
  assert.deepEqual(walkShape(null, ['x']), { ok: true });
  assert.deepEqual(walkShape(mapOf({ type: 'object' }), ['x']), { ok: false, expected: 'not declared', candidates: [] });
});

test('an extension\'s lint rule adds its findings, and sees the imports the suite names', () => {
  const seen: string[] = [];
  const extensions = compose([{
    name: 'checks',
    rules: { lint: input => { seen.push(...input.library.imports.map(i => i.import)); return [error('E901', input.file, START, 'an extension finding')]; } },
  }], coreActions);
  const file = at('_ext.yml');
  const found = validateFile(file, 'u.yml', schema, { binding: 'go', bindingCheck: false, params: [], env: {}, extensions },
    overlayReader({ [file]: `suite: s\nimports: [lib.yml]\n${CASE}`, [at('lib.yml')]: 'description: a library\n' }));
  assert.deepEqual(found.map(d => d.code), ['E901']);
  assert.deepEqual(seen, ['lib.yml']);
});
