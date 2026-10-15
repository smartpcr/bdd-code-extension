// B7.1-1 and B7.1-2: the command line every binding shares (DEC-Y14).
import * as assert from 'node:assert/strict';
import { compose } from '../../src/extension.js';
import { coreActions } from '../../src/actions/core.js';
import { test } from 'node:test';
import { corpusSchema } from '../where.js';
import { usage, EXIT_FAILED, EXIT_PASSED, EXIT_REFUSED, main, parse, USAGE, UsageError } from '../../src/cli.js';

const args = (line: string) => line.split(' ').filter(Boolean);

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { streams: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) }, out, err };
}

test('every verb parses with --path; actions needs none', () => {
  for (const verb of ['lint', 'run', 'list'] as const) assert.equal(parse(args(`${verb} --path a.yml`)).verb, verb);
  assert.equal(parse(args('actions')).verb, 'actions');
  assert.equal(parse(args('actions --json')).json, true);
});

test('every run flag is read', () => {
  const o = parse(args('run --path s/*.yml --tags a,,b, --results r.xml --format junit --dry-run --param one=1 --param two=x=y '
    + '--trace-file t.json --schema-root sch'));
  assert.deepEqual(
    [o.path, o.tags, o.results, o.format, o.dryRun, o.params, o.traceFile, o.schemaRoot, o.extensionOptions.size],
    ['s/*.yml', ['a', 'b'], 'r.xml', 'junit', true, [['one', '1'], ['two', 'x=y']], 't.json', 'sch', 0]);
});

test('an extension\'s option is a valued flag; without the extension it is refused like any unknown flag', () => {
  const site = compose([{ name: 'site', options: [{ flag: '--site', description: 'where it runs' }] }], coreActions);
  assert.equal(parse(args('run --path a.yml --site eu'), site).extensionOptions.get('--site'), 'eu');
  assert.throws(() => parse(args('run --path a.yml --site eu')), /run does not take --site/);
  assert.throws(() => parse(args('run --path a.yml --site'), site), /--site needs a value/);
  assert.match(usage(site), /--site <value> {2}where it runs/);
  assert.equal(usage(), USAGE);
});

test('every lint flag is read, and the binding defaults to this one', () => {
  const o = parse(args('lint --path a.yml --json --strict --binding-check --binding rust'));
  assert.deepEqual([o.json, o.strict, o.bindingCheck, o.binding], [true, true, true, 'rust']);
  const d = parse(args('lint --path a.yml'));
  assert.deepEqual([d.binding, d.format, d.json, d.tags, d.params], ['typescript', 'nunit3', false, [], []]);
});

test('B7.1-1 refusals: each is a UsageError with the usage text', () => {
  const rows: [string, RegExp][] = [
    ['', /a verb is needed/],
    ['frobnicate --path a.yml', /no verb called frobnicate/],
    ['run --path a.yml --nonsense', /run does not take --nonsense/],
    ['run --path', /--path needs a value/],
    ['run --path a.yml --tags', /--tags needs a value/],
    ['run --path --json', /--path needs a value/],
    ['run --path a.yml --format xml', /--format is nunit3 or junit, not xml/],
    ['run --path a.yml --param lonely', /--param takes name=value/],
    ['run --path a.yml --param =x', /--param takes name=value/],
    ['lint', /lint needs --path/],
    ['run', /run needs --path/],
    ['list', /list needs --path/],
  ];
  for (const [line, message] of rows) {
    assert.throws(() => parse(args(line)), (e: unknown) => e instanceof UsageError && message.test(e.message) && e.message.endsWith(USAGE), line);
  }
});

test('the usage names every verb, and the exit codes are 0, 1 and 2', () => {
  for (const verb of ['lint', 'run', 'list', 'actions']) assert.match(USAGE, new RegExp(`suiterun ${verb} `));
  assert.deepEqual([EXIT_PASSED, EXIT_FAILED, EXIT_REFUSED], [0, 1, 2]);
});

test('main: actions --json prints the registered names and exits 0 (B7.1-2 printed [] before B7.5 registered any)', async () => {
  const c = capture();
  assert.equal(await main(['actions', '--json'], c.streams), 0);
  const names = JSON.parse(c.out.join('')) as string[];
  assert.deepEqual([names, c.err], [['core.fail', 'core.noop', 'core.record', 'core.set', 'core.sleep', 'wait'], []]);
  const plain = capture();
  assert.equal(await main(['actions'], plain.streams), 0);
  assert.equal(plain.out.join('').split('\n').filter(Boolean).length, 6);
});

test('main: a refusal is exit 2 with the message and usage on stderr, nothing on stdout', async () => {
  const c = capture();
  assert.equal(await main(['run', '--path', 'a.yml', '--format', 'xml'], c.streams), 2);
  assert.deepEqual(c.out, []);
  assert.match(c.err.join(''), /^suiterun: --format is nunit3 or junit, not xml\.\nsuiterun lint/);
});

test('main: a run or list that cannot start is exit 2 with the reason on stderr', async () => {
  for (const verb of ['run', 'list']) {
    const c = capture();
    assert.equal(await main([verb, '--path', 'no-such-suite.yml', ...(verb === 'run' ? ['--schema-root', corpusSchema] : [])], c.streams), 2);
    assert.match(c.err.join(''), /^suiterun: no-such-suite\.yml names no file/);
  }
});

test('main rethrows what is not a usage error', async () => {
  const broken = { out: () => { throw new Error('stdout is gone'); }, err: () => undefined };
  await assert.rejects(main(['actions', '--json'], broken), /stdout is gone/);
});

test('main writes to the process streams by default', async () => {
  assert.equal(await main(['actions', '--json']), 0);
  assert.equal(await main([]), 2);
});
