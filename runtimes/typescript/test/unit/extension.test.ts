// extension.ts: composing extensions refuses every name defined twice, starting
// them gives each its own options, and the parts reach the run (DEC-S03).
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { coreActions } from '../../src/actions/core.js';
import { action } from '../../src/actions/registry.js';
import { coreOnly, runFile } from '../../src/exec.js';
import { evaluate, ExprError } from '../../src/expr.js';
import { compose, CORE_ROOTS, DEFAULT_ENV_PREFIX, Extension, start } from '../../src/extension.js';
import { loadDocument } from '../../src/model.js';
import { overlayReader } from '../../src/reader.js';
import { loadSchema } from '../../src/schema.js';
import { resolveParams } from '../../src/suite.js';
import { Trace } from '../../src/trace.js';
import { ValueMap } from '../../src/value.js';
import { corpusSchema, repo } from '../where.js';

const noop = async () => null;

test('compose: the core alone has the core actions, the core roots and the default prefix', () => {
  const c = compose([], coreActions);
  assert.deepEqual([...c.actions.keys()].sort(), ['core.fail', 'core.noop', 'core.record', 'core.set', 'core.sleep', 'wait']);
  assert.deepEqual([c.roots, c.contextKeys, c.options, c.envPrefix], [CORE_ROOTS, [], [], DEFAULT_ENV_PREFIX]);
  assert.equal(c.caseLimitSec(new Map(), 30), 30);
  assert.deepEqual(c.lint({} as never), []);
  assert.equal(compose().actions.size, 0, 'nothing at all without the core actions');
});

test('compose refuses a name defined twice: an action, a context key (or a core root), an option (or a core flag), a prefix', () => {
  const a: Extension = { name: 'a', actions: [action('x.do', noop)], contextKeys: ['site'], options: [{ flag: '--site', description: '' }], envPrefix: 'A_' };
  assert.throws(() => compose([a, { name: 'b', actions: [action('x.do', noop)] }]), /Action x\.do is defined by both a and b/);
  assert.throws(() => compose([{ name: 'b', actions: [action('core.set', noop)] }], coreActions), /Action core\.set is defined by both the core and b/);
  assert.throws(() => compose([a, { name: 'b', contextKeys: ['site'] }]), /Context key site is defined by both a and b/);
  assert.throws(() => compose([{ name: 'b', contextKeys: ['capture'] }]), /Context key capture is defined by both the core and b/);
  assert.throws(() => compose([a, { name: 'b', options: [{ flag: '--site', description: '' }] }]), /Option --site is defined by both a and b/);
  assert.throws(() => compose([{ name: 'b', options: [{ flag: '--path', description: '' }] }]), /Option --path is defined by both the core and b/);
  assert.throws(() => compose([{ name: 'b', options: [{ flag: '-x', description: '' }] }]), /an option is --lower-case-words/);
  assert.throws(() => compose([a, { name: 'b', envPrefix: 'B_' }]), /a sets the environment prefix A_ and b sets B_/);
  assert.equal(compose([a, { name: 'b', envPrefix: 'A_' }]).envPrefix, 'A_', 'the same prefix twice is no conflict');
});

test('compose merges the parts: roots, options, every rule, and the smallest case limit', () => {
  const finding = { code: 'E900' } as never;
  const c = compose([
    { name: 'a', contextKeys: ['site'], rules: { lint: () => [finding], caseLimitSec: (_s, d) => Math.min(d, 20) } },
    { name: 'b', contextKeys: ['zone'], options: [{ flag: '--zone', description: 'z' }], rules: { caseLimitSec: () => 5 } },
    { name: 'c', rules: {} },
  ]);
  assert.deepEqual(c.roots, [...CORE_ROOTS, 'site', 'zone']);
  assert.deepEqual(c.options.map(o => o.flag), ['--zone']);
  assert.deepEqual(c.lint({} as never), [finding]);
  assert.equal(c.caseLimitSec(new Map(), 600), 5);
});

test('start: each extension sees only its own options; context only for its own keys; redactions chain', () => {
  const seen: string[][] = [];
  const c = compose([
    {
      name: 'a', contextKeys: ['site'], options: [{ flag: '--site', description: '' }],
      start: o => { seen.push([...o.keys()]); return { context: { site: o.get('--site') ?? '', other: 'ignored' }, redact: t => t.replace('secret', '***'), state: 1 }; },
    },
    { name: 'b', options: [{ flag: '--zone', description: '' }], start: o => { seen.push([...o.keys()]); return { redact: t => t.toUpperCase() }; } },
    { name: 'c' },
  ]);
  const s = start(c, new Map([['--site', 'eu'], ['--zone', 'z1']]));
  assert.deepEqual(seen, [['--site'], ['--zone']]);
  assert.deepEqual([...s.context], [['site', 'eu']]);
  assert.equal(s.redact('a secret'), 'A ***');
  assert.equal(s.states.get(c.extensions[0]!), 1);
  assert.equal(s.states.get(c.extensions[2]!), undefined);
});

test('a scope without roots allows the core roots only; the prefix reaches parameter resolution', () => {
  assert.throws(() => evaluate('cluster', { value: new Map(), allowNonDeterministic: true }), (e: unknown) => e instanceof ExprError && e.code === 'E301');
  assert.equal(evaluate('timeoutSec', { value: new Map([['timeoutSec', 5n]]), allowNonDeterministic: true }), 5n);
  const suite = loadDocument('suite: s\nparams: [{ name: p }]\ntests: []\n').value as ValueMap;
  const library = { params: [], vars: new Map(), metaSteps: new Map(), defaults: new Map() } as never;
  assert.deepEqual([...resolveParams(library, suite, undefined, [], { HCI_SUITE_PARAM_P: 'h', BDD_SUITE_PARAM_P: 'b' }, 'HCI_SUITE_')], [['p', 'h']]);
  assert.deepEqual([...resolveParams(library, suite, undefined, [], { BDD_SUITE_PARAM_P: 'b' })], [['p', 'b']]);
});

test('runFile with no extensions given runs the core alone', async () => {
  const file = path.join(repo, '_core-only.yml');
  const suite = loadDocument('suite: s\ntests:\n  - name: c\n    steps: [{ action: core.noop }]\n').value as ValueMap;
  const trace = new Trace();
  const r = await runFile(file, suite, loadSchema(corpusSchema), { tags: [], params: [], dryRun: false, recordPath: '', env: {}, reader: overlayReader({}) }, trace);
  assert.equal(r.cases[0]!.status, 'passed');
  assert.deepEqual([...coreOnly().composite.actions.keys()].length, 6);
});
