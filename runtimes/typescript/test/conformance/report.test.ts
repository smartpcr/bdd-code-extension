// The report family (E-B12): each reports entry run through the program, its
// --results document canonicalised and compared with the stored canonical
// form; three runs canonicalise identical (B7.6-1).
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { corpus, corpusCli, corpusSchema, repo } from '../where.js';
import { canonicalise } from './canonicalise.js';

type Entry = { suite: string; format: string; expected: string; tags?: string };

const root = repo;
const manifest = parse(fs.readFileSync(path.join(corpus, 'run-manifest.yaml'), 'utf8')) as { reports: { entries: Entry[] } };
const cli = corpusCli;

function report(entry: Entry, file: string): string {
  const argv = [cli, 'run', '--schema-root', corpusSchema, '--path', path.join(corpus, entry.suite), '--results', file, '--format', entry.format.toLowerCase(),
    ...(entry.tags ? ['--tags', entry.tags] : [])];
  spawnSync(process.execPath, argv, { cwd: root, env: { ...process.env, BDD_SUITE_RECORD_PATH: '' } });
  return fs.readFileSync(file, 'utf8');
}

test('B7.6-1 every stored report matches after canonicalisation, and three runs canonicalise identical', () => {
  const entries = manifest.reports.entries;
  assert.equal(entries.length, 7);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suiterun-report-'));
  const wrong: string[] = [];
  for (const entry of entries) {
    const runs = [1, 2, 3].map(i => canonicalise(report(entry, path.join(dir, `${path.basename(entry.expected)}.${i}.xml`))));
    const stored = fs.readFileSync(path.join(corpus, entry.expected), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
    if (runs[0] !== stored) wrong.push(`${entry.expected}:\n--- produced\n${runs[0]}--- stored\n${stored}`);
    if (runs[1] !== runs[0] || runs[2] !== runs[0]) wrong.push(`${entry.expected}: three runs differ`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`  ${entries.length - wrong.length} of ${entries.length} stored reports match`);
  assert.deepEqual(wrong, []);
});
