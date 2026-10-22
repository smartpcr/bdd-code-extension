// The execute corpus (E-B12): every entry through the program, its trace and
// exit code compared with the expectation, inside its maxSeconds.
import * as assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { corpus, corpusCli, corpusSchema, repo, splitPending } from '../where.js';

type Entry = { kind: string; suite: string; expectation: string; params?: Record<string, unknown>; tags?: string; names?: string; progress?: string;
  schemaRoot?: string; pendingIn?: string[] };
type Expected = { exitCode: number; maxSeconds?: number; trace: Record<string, string>[] };

const root = repo;
const manifest = parse(fs.readFileSync(path.join(corpus, 'run-manifest.yaml'), 'utf8')) as { entries: Entry[] };
const cli = corpusCli;

function run(argv: string[]): Promise<{ code: number | null; seconds: number; out: string }> {
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, BDD_SUITE_RECORD_PATH: '' } });
    let out = '';
    child.stdout.on('data', chunk => (out += String(chunk)));
    child.on('close', code => resolve({ code, seconds: (Date.now() - started) / 1000, out }));
  });
}

/** The progress lines of a run's output (up to and including the first Summary), with the failure text and durations masked (spec/progress.md). */
function progressLines(out: string): string[] {
  const lines = out.split(/\r?\n/);
  const end = lines.findIndex(line => line.startsWith('Summary: '));
  return lines.slice(0, end + 1).map(line => line.replace(/^( {4}failure: ).*$/, '$1*').replace(/\(\d+s\)/g, '(*s)'));
}

test('B7.5-1 every execute entry: the trace, the exit code, inside maxSeconds', async () => {
  // pendingIn: entries this runtime does not meet yet are reported as pending, never run nor counted as passed.
  const { run: entries, pending: held } = splitPending(manifest.entries.filter(e => e.kind === 'execute'));
  const pending = held.map(e => e.suite);
  assert.equal(entries.length, 21);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-execute-'));
  const wrong: string[] = [];
  await Promise.all(entries.map(async entry => {
    const expected = JSON.parse(fs.readFileSync(path.join(corpus, entry.expectation), 'utf8')) as Expected;
    const traceFile = path.join(dir, `${path.basename(entry.suite)}.trace.json`);
    const argv = ['run', '--schema-root', entry.schemaRoot ? path.join(corpus, entry.schemaRoot) : corpusSchema, '--path', path.join(corpus, entry.suite),
      '--trace-file', traceFile, ...(entry.tags ? ['--tags', entry.tags] : []), ...(entry.names ? ['--name', entry.names] : []),
      ...(entry.progress ? ['--progress'] : []), ...Object.entries(entry.params ?? {}).flatMap(([k, v]) => ['--param', `${k}=${String(v)}`])];
    const r = await run(argv);
    if (entry.progress) {
      const wanted = fs.readFileSync(path.join(corpus, entry.progress), 'utf8').split(/\r?\n/).filter(Boolean);
      const got = progressLines(r.out);
      if (got.join('\n') !== wanted.join('\n')) wrong.push(`${entry.suite}: progress differs\n${got.join('\n')}`);
    } else if (/^StartGroup: /m.test(r.out)) {
      wrong.push(`${entry.suite}: progress lines without --progress`);
    }
    const trace = fs.existsSync(traceFile) ? JSON.parse(fs.readFileSync(traceFile, 'utf8')) : '(no trace)';
    try {
      assert.deepEqual(trace, expected.trace);
    } catch (e) {
      wrong.push(`${entry.suite}: trace differs\n${(e as Error).message}`);
    }
    if (r.code !== expected.exitCode) wrong.push(`${entry.suite}: exit ${r.code}, expected ${expected.exitCode}`);
    if (expected.maxSeconds !== undefined && r.seconds > expected.maxSeconds) wrong.push(`${entry.suite}: ${r.seconds}s, over ${expected.maxSeconds}s`);
  }));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`  ${entries.length} execute entries run; ${wrong.length} differ; pending: ${pending.join(', ')}`);
  assert.deepEqual(wrong, []);
});

test('every lists entry: suiterun list with its names and tags prints exactly its case names, in order', () => {
  const lists = (parse(fs.readFileSync(path.join(corpus, 'run-manifest.yaml'), 'utf8')) as { lists?: { suite: string; names?: string; tags?: string; expected: string[]; pendingIn?: string[] }[] }).lists ?? [];
  const { run: entries } = splitPending(lists);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    const argv = [cli, 'list', '--schema-root', corpusSchema, '--path', path.join(corpus, entry.suite),
      ...(entry.names ? ['--name', entry.names] : []), ...(entry.tags ? ['--tags', entry.tags] : [])];
    const r = spawnSync(process.execPath, argv, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split(/\r?\n/).filter(Boolean).map(row => row.slice(row.indexOf('  ') + 2).trim()), entry.expected, entry.suite);
  }
});
