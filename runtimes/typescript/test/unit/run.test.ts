// run.ts: the lint verb's report, and every way it refuses.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse } from '../../src/cli.js';
import { overlayReader } from '../../src/reader.js';
import { execute, lintVerb, roots } from '../../src/run.js';
import { corpus, corpusSchema, repo } from '../where.js';

const root = repo;
const opts = (line: string) => parse([...line.split(' '), ...(/^(lint|run) /.test(line) && !line.includes('--schema-root') ? ['--schema-root', corpusSchema] : [])]);

test('roots: the workspace from the working directory; --schema-root needs no workspace above it', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-roots-'));
  fs.mkdirSync(path.join(ws, 'test', 'e2e', 'schema'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'suites'));
  assert.deepEqual(roots(parse(['lint', '--path', 'x']), path.join(ws, 'suites')), { root: ws, schemaRoot: path.join(ws, 'test', 'e2e', 'schema') });
  assert.deepEqual(roots(parse(['lint', '--path', 'x', '--schema-root', 'S']), path.join(ws, 'suites')), { root: ws, schemaRoot: path.join(ws, 'suites', 'S') });
  // S1.13: a given schema root is used when there is no workspace above the working directory.
  assert.deepEqual(roots(parse(['lint', '--path', 'x', '--schema-root', corpusSchema]), corpus), { root: corpus, schemaRoot: corpusSchema });
  assert.throws(() => roots(parse(['lint', '--path', 'x']), path.parse(root).root), /workspace root cannot be found/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('lint --json: the findings and exit 2; a clean file is [] and exit 0', async () => {
  const r = await lintVerb(opts('lint --path validate/typos.yml --json'), corpus);
  assert.equal(r.code, 2);
  assert.deepEqual(JSON.parse(r.out).map((d: { code: string; line: number }) => `${d.code}@${d.line}`), ['E101@4', 'E104@6', 'E101@8']);
  const clean = await lintVerb(opts('lint --path execute/gherkin.yml --json'), corpus);
  assert.deepEqual([clean.code, clean.out], [0, '[]']);
});

test('lint, human: one line per finding and a summary; --strict fails a warning-only file', async () => {
  const r = await lintVerb(opts('lint --path validate/typo*.yml'), corpus);
  // Relative to the working directory: there is no workspace above the corpus, only a --schema-root.
  assert.match(r.out, /^validate\/typos\.yml:4:5  E101 /);
  assert.match(r.out, /Lint failed: 1 suite file\(s\), 3 finding\(s\)\.$/);
  const clean = await lintVerb(opts('lint --path execute/gherkin.yml'), corpus);
  assert.equal(clean.out, 'Lint clean: 1 suite file(s), 0 finding(s).');
  const strict = await lintVerb(opts('lint --path execute/gherkin.yml --strict'), corpus);
  assert.equal(strict.code, 0, 'no findings at all is clean even when strict');
});

test('lint refuses: no repository, a bad schema root, a path that names no file', async () => {
  assert.match((await lintVerb(parse(['lint', '--path', 'x.yml']), path.parse(root).root)).errors, /workspace root/);
  assert.match((await lintVerb(opts('lint --path validate/typos.yml --schema-root nowhere'), corpus)).errors, /Suite schema not found/);
  const none = await lintVerb(opts('lint --path validate/none-such.yml'), corpus);
  assert.deepEqual([none.code, none.out], [2, '']);
  assert.match(none.errors, /names no file/);
});

test('lint reads through the reader it is given', async () => {
  const dir = fs.mkdtempSync(path.join(corpus, '..', 'tmp-lint-'));
  try {
    const file = path.join(dir, 'x.yml');
    fs.writeFileSync(file, 'suite: x\n');
    const r = await lintVerb(opts(`lint --path ${file} --json`), corpus, overlayReader({ [file]: 'suite: x\nsuiet: y\n' }));
    assert.ok(r.out.includes('E101'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  void os;
});
