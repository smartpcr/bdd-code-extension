// The name filter, run progress and its observer, the action worker and the
// embedded core (docs/packages, D5; spec/progress.md): the parts the corpus
// does not reach.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse, USAGE } from '../../src/cli.js';
import { CORE_CATALOG } from '../../src/coreCatalog.js';
import { CaseResult, RunObserver, runFile, RunOptions, thrownMessage } from '../../src/exec.js';
import { start } from '../../src/extension.js';
import { loadDocument } from '../../src/model.js';
import { ProgressPrinter, setProgressWriter } from '../../src/progress.js';
import { runVerb } from '../../src/run.js';
import { loadSchema } from '../../src/schema.js';
import { nameMatches } from '../../src/suite.js';
import { Entry, Trace } from '../../src/trace.js';
import { ValueMap } from '../../src/value.js';
import { corpus, corpusComposite, corpusSchema, repo } from '../where.js';

/** Every line the progress writer is given while `body` runs. */
async function printed(body: () => unknown): Promise<string[]> {
  const lines: string[] = [];
  const before = setProgressWriter(line => lines.push(line));
  try {
    await body();
  } finally {
    setProgressWriter(before);
  }
  return lines;
}

test('--name and --progress are read, and the usage names both', () => {
  const options = parse(['run', '--path', 'x.yml', '--name', ' place-* , order-? ,', '--name', 'third', '--progress']);
  assert.deepEqual(options.names, ['place-*', 'order-?', 'third']);
  assert.equal(options.progress, true);
  assert.equal(parse(['run', '--path', 'x.yml']).progress, false);
  assert.match(USAGE, /\[--name a\*,b\?\]/);
  assert.match(USAGE, /\[--progress\]/);
});

test('a name matches a glob over the whole name; no glob matches every case', () => {
  for (const [name, glob, matches] of [
    ['place-an-order', '*-an-order', true], ['order-1', 'order-?', true], ['order-22', 'order-?', false],
    ['read-the-stock', '*-an-order', false], ['Place-an-order', 'place-*', false],
  ] as const) assert.equal(nameMatches(name, [glob]), matches, `${name} against ${glob}`);
  assert.equal(nameMatches('anything', []), true);
});

test('a trace tells its hook every entry in the order it records them', () => {
  const trace = new Trace();
  const seen: string[] = [];
  trace.added = entry => seen.push(entry.step ?? '');
  trace.add('step', 'a', 'first', 'core.noop', 'passed', '');
  trace.add('step', 'a', 'second', 'core.noop', 'passed', '');
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal(trace.entries.length, 2);
});

class Recorder implements RunObserver {
  readonly heard: string[] = [];
  caseStarted(suite: string, caseName: string): void { this.heard.push(`start ${suite}::${caseName}`); }
  caseFinished(suite: string, result: CaseResult): void { this.heard.push(`end ${suite}::${result.name} ${result.status}`); }
  entry(entry: Entry): void { this.heard.push(`entry ${entry.phase} ${entry.case ?? ''}`); }
}

/** One corpus suite, the whole-file way. */
function runCorpusFile(relative: string, options: RunOptions, trace: Trace) {
  const file = path.join(corpus, relative);
  const suite = loadDocument(fs.readFileSync(file, 'utf8')).value as ValueMap;
  return runFile(file, suite, loadSchema(corpusSchema), options, trace, { composite: corpusComposite, started: start(corpusComposite, new Map()) });
}

const plain = (extra: Partial<RunOptions> = {}): RunOptions => ({ tags: [], params: [], dryRun: false, recordPath: '', env: {}, ...extra });

test('an observer hears selected cases only, never changes the trace, and is detached after the file', async () => {
  const filters = { tags: ['wanted'], names: ['*-order'] };
  const quiet = new Trace();
  await runCorpusFile('execute/names-and-tags.yml', plain(filters), quiet);
  const recorder = new Recorder();
  const observed = new Trace();
  await runCorpusFile('execute/names-and-tags.yml', plain({ ...filters, observer: recorder }), observed);
  assert.equal(observed.toJson(), quiet.toJson());
  assert.deepEqual(recorder.heard, [
    'start names-and-tags::a-wanted-order', 'entry step a-wanted-order', 'entry case a-wanted-order',
    'end names-and-tags::a-wanted-order passed', 'entry case an-unwanted-order', 'entry case a-wanted-refund',
  ]);
  assert.equal(observed.added, undefined);
});

test('a dry run tells the observer nothing', async () => {
  const recorder = new Recorder();
  await runCorpusFile('execute/hooks.yml', plain({ dryRun: true, observer: recorder }), new Trace());
  assert.deepEqual(recorder.heard, []);
});

test('the progress printer writes the shape spec/progress.md gives', async () => {
  const lines = await printed(() => {
    const printer = new ProgressPrinter();
    const result = (name: string, status: CaseResult['status'], message = '', durationSec = 0): CaseResult =>
      ({ name, status, reason: '', message, output: '', durationSec, afterEachFailed: false });
    printer.entry({ phase: 'suite-setup', step: 'step 1 (core.record)', action: 'core.record', status: 'passed' });
    printer.caseStarted('orders', 'place');
    printer.entry({ phase: 'step', case: 'place', step: 'the order', action: 'shop.order', status: 'failed', reason: 'action' });
    printer.entry({ phase: 'case', case: 'place', status: 'failed', reason: 'action' });
    printer.entry({ phase: 'step', case: 'place', status: 'passed' });
    printer.caseFinished('orders', result('place', 'failed', 'two\r\nlines', 2.6));
    printer.caseFinished('orders', result('later', 'skipped'));
    printer.caseFinished('orders', result('ok', 'passed', '', 0.5));
    printer.caseFinished('orders', result('silent', 'error'));
    printer.summary();
  });
  assert.deepEqual(lines, [
    '    suite-setup   step 1 (core.record) passed',
    'StartGroup: orders::place',
    '    step          the order (shop.order) failed [action]',
    '    step           passed',
    '    failure: two lines',
    'EndGroup: orders::place [Failed] (3s)',
    'EndGroup: orders::later [Skipped] (0s)',
    'EndGroup: orders::ok [Passed] (1s)',
    'EndGroup: orders::silent [Failed] (0s)',
    'Summary: Total=4, Passed=1, Failed=2, Blocked=0, Not Run=0, Skipped=1',
  ]);
});

test('progress goes to standard output unless a writer is set, and setting none puts it back', () => {
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { written.push(chunk); return true; }) as typeof process.stdout.write;
  try {
    const before = setProgressWriter(undefined);
    before('first');
    new ProgressPrinter().summary();
  } finally {
    process.stdout.write = realWrite;
  }
  assert.deepEqual(written, ['first\n', 'Summary: Total=0, Passed=0, Failed=0, Blocked=0, Not Run=0, Skipped=0\n']);
});

test('a run without --progress prints nothing, and one with it summarises every file', async () => {
  const run = (line: string[]) => runVerb(parse(['run', '--schema-root', corpusSchema, ...line], corpusComposite), { composite: corpusComposite, cwd: repo, env: {} });
  const quiet = await printed(() => run(['--path', path.join(corpus, 'execute', 'hooks.yml')]));
  assert.deepEqual(quiet, []);
  // Three files in sorted order; the filter selects nothing in the first.
  let code = -1;
  const lines = await printed(async () => { code = (await run(['--path', path.join(corpus, 'execute', 'names*.yml'), '--name', 'first,*-an-order', '--progress'])).code; });
  assert.equal(code, 0);
  assert.deepEqual(lines.filter(l => l.startsWith('StartGroup: ')).map(l => l.slice('StartGroup: '.length)),
    ['names-none::first', 'names::place-an-order', 'names::cancel-an-order']);
  assert.equal(lines.at(-1), 'Summary: Total=3, Passed=3, Failed=0, Blocked=0, Not Run=0, Skipped=0');
});

test('an action that throws a bare value fails its step, and the run goes on', async () => {
  const trace = new Trace();
  const result = await runCorpusFile('execute/worker-throws.yml', plain(), trace);
  assert.deepEqual(result.cases.map(c => `${c.name}|${c.status}|${c.reason}`), ['the-case-whose-action-throws|failed|action', 'the-case-after-it|passed|']);
  assert.match(result.cases[0]!.message, /thrown on purpose/);
  assert.deepEqual([trace.entries.at(-1)!.phase, trace.entries.at(-1)!.status], ['suite-teardown', 'passed']);
});

test('a thrown value says what it is: an Error its message, a string itself, anything else as JSON or text', () => {
  assert.equal(thrownMessage(new Error('boom')), 'boom');
  assert.equal(thrownMessage('plain'), 'plain');
  assert.equal(thrownMessage({ code: 7 }), '{"code":7}');
  assert.equal(thrownMessage(undefined), 'undefined');
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.equal(thrownMessage(loop), '[object Object]');
});

test('the core this runtime carries is the spec\'s, and bdd-suite:core cuts its bindings to the importer\'s', () => {
  assert.equal(CORE_CATALOG, fs.readFileSync(path.join(repo, 'spec', 'core.catalog.yaml'), 'utf8').replace(/\r\n/g, '\n'),
    'src/coreCatalog.ts differs from spec/core.catalog.yaml: run npm run sync-core');
  const cut = loadSchema(path.join(corpus, 'schema-core-import'));
  const whole = loadSchema(corpusSchema);
  for (const name of ['core.noop', 'core.set', 'core.fail', 'core.sleep', 'core.record', 'wait']) {
    assert.deepEqual(cut.actions.get(name)!.bindings, ['csharp'], name);
    assert.deepEqual(whole.actions.get(name)!.bindings, ['powershell', 'csharp', 'go', 'rust', 'typescript'], name);
  }
  assert.equal(cut.actions.size, 6);
});

test('the package carries the repository\'s license', () => {
  // npm packs only this folder (docs/packages, DEC-P11).
  const read = (...parts: string[]) => fs.readFileSync(path.join(repo, ...parts), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(read('runtimes', 'typescript', 'LICENSE'), read('LICENSE'), 'runtimes/typescript/LICENSE differs from the repository\'s: copy it again');
});

test('bdd-suite:core is read whole when the importer lists no bindings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-core-'));
  try {
    fs.writeFileSync(path.join(root, 'actions.catalog.yaml'), "catalogVersion: 1\nimports: [ 'bdd-suite:core' ]\n");
    fs.copyFileSync(path.join(corpus, 'schema-core-import', 'suite.schema.json'), path.join(root, 'suite.schema.json'));
    assert.equal(loadSchema(root).actions.get('wait')!.bindings.length, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
