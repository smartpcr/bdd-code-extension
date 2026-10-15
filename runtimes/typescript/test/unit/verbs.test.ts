// run.ts: the run, list and actions verbs, their output and every refusal.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse } from '../../src/cli.js';
import { overlayReader } from '../../src/reader.js';
import { actionsVerb, execute, listVerb, runVerb } from '../../src/run.js';
import { corpus, corpusSchema } from '../where.js';

const opts = (line: string) => parse([...line.split(' '), ...(/^(lint|run) /.test(line) && !line.includes('--schema-root') ? ['--schema-root', corpusSchema] : [])]);

test('run: the summary lines, the trace file, the exit code; dry run; tags', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-verbs-'));
  const trace = path.join(dir, 'deep', 't.json');
  const r = await runVerb(opts(`run --path execute/gherkin.yml --trace-file ${trace}`), { cwd: corpus, env: {} });
  assert.equal(r.code, 1);
  assert.match(r.out, /^=== Suite: gherkin\.yml ===\n {2}\[passed\] a-scenario-that-reads-as-one\n/);
  assert.match(r.out, /\[failed\] a-failure-says-the-sentence-and-the-keyword\nTrace written to .*\nOne or more tests failed\.$/);
  assert.ok(JSON.parse(fs.readFileSync(trace, 'utf8')).length > 5);
  const dry = await runVerb(opts('run --path execute/gherkin.yml --dry-run'), { cwd: corpus, env: {} });
  assert.deepEqual([dry.code, dry.out.split('\n').pop()], [0, 'Suite validation passed; live tests were not run.']);
  const tagged = await runVerb(opts('run --path execute/tags.yml --tags wanted'), { cwd: corpus, env: {} });
  assert.equal(tagged.out.split('\n').pop(), 'All selected tests passed.');
  assert.equal(tagged.code, 0);
});

test('run writes NUnit 3 or JUnit with --results; it refuses a path that names nothing, a file that is not a suite, a trace it cannot write', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-results-'));
  const nunit = await runVerb(opts(`run --path execute/hooks.yml --results ${path.join(out, 'n.xml')}`), { cwd: corpus, env: {} });
  assert.match(nunit.out, /Results written to .*n\.xml/);
  assert.match(fs.readFileSync(path.join(out, 'n.xml'), 'utf8'), /<test-run /);
  await runVerb(opts(`run --path execute/hooks.yml --results ${path.join(out, 'j.xml')} --format junit`), { cwd: corpus, env: {} });
  assert.match(fs.readFileSync(path.join(out, 'j.xml'), 'utf8'), /<testsuites>/);
  assert.match((await runVerb(opts('run --path none.yml'), { cwd: corpus })).errors, /names no file/);
  const bad = path.join(corpus, 'execute', '_bad.yml');
  const reader = overlayReader({ [bad]: 'a: [1', [path.join(corpus, 'execute', '_list.yml')]: '- 1\n' });
  fs.writeFileSync(bad, '');
  fs.writeFileSync(path.join(corpus, 'execute', '_list.yml'), '');
  try {
    assert.match((await runVerb(opts('run --path execute/_bad.yml'), { cwd: corpus, reader })).errors, /is not valid YAML/);
    assert.match((await runVerb(opts('run --path execute/_list.yml'), { cwd: corpus, reader })).errors, /does not hold a YAML mapping/);
    const unreadable = overlayReader({}, { read: () => undefined });
    assert.match((await runVerb(opts('run --path execute/_bad.yml --schema-root ../schema'), { cwd: corpus, reader: overlayReader({ [path.join(corpus, 'schema', 'x')]: '' }, unreadable) })).errors, /Suite schema not found/);
    assert.match((await listVerb(opts('list --path execute/_bad.yml'), corpus, unreadable)).errors, /cannot be read/);
  } finally {
    fs.rmSync(bad, { force: true });
    fs.rmSync(path.join(corpus, 'execute', '_list.yml'), { force: true });
  }
  const file = path.join(os.tmpdir(), `suiterun-file-${process.pid}`);
  fs.writeFileSync(file, '');
  try {
    assert.match((await runVerb(opts(`run --path execute/gherkin.yml --trace-file ${path.join(file, 'below', 't.json')}`), { cwd: corpus, env: {} })).errors, /cannot be written/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('list: one line per selected case; actions: the core names, with no extension', async () => {
  const l = await listVerb(opts('list --path execute/tags.yml --tags wanted'), corpus);
  assert.equal(l.code, 0);
  assert.ok(l.out.split('\n').every(line => line.startsWith('tags.yml  ')));
  assert.match((await listVerb(opts('list --path none.yml'), corpus)).errors, /names no file/);
  assert.equal((await actionsVerb(opts('actions'))).out.split('\n').length, 6);
});

test('execute dispatches each verb', async () => {
  assert.equal(JSON.parse((await execute(opts('actions --json'))).out).length, 6);
  assert.equal((await execute(opts(`run --path ${path.join(corpus, 'execute', 'hooks.yml')}`))).code, 0);
  assert.equal((await execute(opts(`list --path ${path.join(corpus, 'execute', 'hooks.yml')}`))).code, 0);
  assert.equal((await execute(opts(`lint --path ${path.join(corpus, 'execute', 'gherkin.yml')}`))).code, 0);
});
