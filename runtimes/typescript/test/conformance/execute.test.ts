// The execute corpus (E-B12): every entry through the program, its trace and
// exit code compared with the expectation, inside its maxSeconds.
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { corpus, corpusCli, corpusSchema, repo, splitPending } from '../where.js';

type Entry = { kind: string; suite: string; expectation: string; params?: Record<string, unknown>; tags?: string; pendingIn?: string[] };
type Expected = { exitCode: number; maxSeconds?: number; trace: Record<string, string>[] };

const root = repo;
const manifest = parse(fs.readFileSync(path.join(corpus, 'run-manifest.yaml'), 'utf8')) as { entries: Entry[] };
const cli = corpusCli;

function run(argv: string[]): Promise<{ code: number | null; seconds: number }> {
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: root, stdio: 'ignore', env: { ...process.env, BDD_SUITE_RECORD_PATH: '' } });
    child.on('close', code => resolve({ code, seconds: (Date.now() - started) / 1000 }));
  });
}

test('B7.5-1 every execute entry: the trace, the exit code, inside maxSeconds', async () => {
  // pendingIn: entries this runtime does not meet yet are reported as pending, never run nor counted as passed.
  const { run: entries, pending: held } = splitPending(manifest.entries.filter(e => e.kind === 'execute'));
  const pending = held.map(e => e.suite);
  assert.equal(entries.length, 14);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-execute-'));
  const wrong: string[] = [];
  await Promise.all(entries.map(async entry => {
    const expected = JSON.parse(fs.readFileSync(path.join(corpus, entry.expectation), 'utf8')) as Expected;
    const traceFile = path.join(dir, `${path.basename(entry.suite)}.trace.json`);
    const argv = ['run', '--schema-root', corpusSchema, '--path', path.join(corpus, entry.suite), '--trace-file', traceFile, ...(entry.tags ? ['--tags', entry.tags] : []),
      ...Object.entries(entry.params ?? {}).flatMap(([k, v]) => ['--param', `${k}=${String(v)}`])];
    const r = await run(argv);
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
