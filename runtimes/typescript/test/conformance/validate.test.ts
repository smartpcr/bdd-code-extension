// The validate corpus (E-B12): each entry's findings, compared by code,
// severity, order, line and column, and its exit code, honouring the entry's
// params, binding, bindingCheck, strict and catalogOverlay.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { fails } from '../../src/diag.js';
import { loadDocument } from '../../src/model.js';
import { corpus, corpusCli, corpusComposite, corpusSchema, repo, splitPending } from '../where.js';
import { loadSchema, withOverlay } from '../../src/schema.js';
import { validateFile } from '../../src/validate/index.js';

type Entry = { kind: string; suite: string; expectation: string; binding?: string; bindingCheck?: boolean; strict?: boolean;
  params?: Record<string, unknown>; catalogOverlay?: string; schemaRoot?: string; pendingIn?: string[] };
type Expected = { exitCode: number; diagnostics: { code: string; severity: string; line: number; column: number }[] };

const root = repo;
const manifest = parse(fs.readFileSync(path.join(corpus, 'run-manifest.yaml'), 'utf8')) as { entries: Entry[] };
const base = loadSchema(corpusSchema);


export function runEntry(entry: Entry): { got: string[]; want: string[]; exit: number; wantExit: number } {
  const expected = JSON.parse(fs.readFileSync(path.join(corpus, entry.expectation), 'utf8')) as Expected;
  const own = entry.schemaRoot ? loadSchema(path.join(corpus, entry.schemaRoot)) : base;
  const schema = entry.catalogOverlay
    ? withOverlay(own, loadDocument(fs.readFileSync(path.join(corpus, entry.catalogOverlay), 'utf8')).value)
    : own;
  const file = path.join(corpus, entry.suite);
  const found = validateFile(file, path.relative(root, file).replace(/\\/g, '/'), schema, {
    binding: entry.binding ?? 'typescript', bindingCheck: !!entry.bindingCheck,
    params: Object.entries(entry.params ?? {}).map(([k, v]) => [k, String(v)]), extensions: corpusComposite, env: {},
  });
  const sig = (d: { code: string; severity: string; line: number; column: number }) => `${d.code} ${d.severity} ${d.line}:${d.column}`;
  return {
    got: found.map(d => sig({ code: d.code, severity: d.severity, line: d.position.line, column: d.position.column })),
    want: expected.diagnostics.map(sig),
    exit: fails(found, !!entry.strict) ? 2 : 0,
    wantExit: expected.exitCode,
  };
}

// pendingIn: entries this runtime does not meet yet are reported as pending, never run nor counted as passed.
const { run: validate, pending } = splitPending(manifest.entries.filter(e => e.kind === 'validate'));
const pendingNote = `pending: ${pending.map(e => e.suite).join(', ')}`;

test('B7.4-1 every validate entry matches exactly (B7.2-1 is the E1xx part of it)', () => {
  const inSlice = validate;
  const wrong: string[] = [];
  for (const entry of inSlice) {
    const r = runEntry(entry);
    if (r.got.join('|') !== r.want.join('|') || r.exit !== r.wantExit) {
      wrong.push(`${entry.suite}\n    got  ${r.got.join(', ')} exit ${r.exit}\n    want ${r.want.join(', ')} exit ${r.wantExit}`);
    }
  }
  console.log(`  ${inSlice.length - wrong.length} of ${inSlice.length} validate entries match; ${pendingNote}`);
  assert.equal(wrong.length, 0, wrong.join('\n'));
});

test('E-B12 the same entries through the program: `lint --json` output and exit code', async () => {
  const { spawnSync } = await import('node:child_process');
  const cli = corpusCli;
  const wrong: string[] = [];
  let ran = 0;
  for (const entry of validate) {
    // A catalog overlay is a library input the shared command line does not take.
    if (entry.catalogOverlay) continue;
    const expected = JSON.parse(fs.readFileSync(path.join(corpus, entry.expectation), 'utf8')) as Expected;
    const argv = [cli, 'lint', '--schema-root', entry.schemaRoot ? path.join(corpus, entry.schemaRoot) : corpusSchema, '--path', path.join(corpus, entry.suite), '--json',
      ...(entry.binding ? ['--binding', entry.binding] : []), ...(entry.bindingCheck ? ['--binding-check'] : []),
      ...(entry.strict ? ['--strict'] : []), ...Object.entries(entry.params ?? {}).flatMap(([k, v]) => ['--param', `${k}=${String(v)}`])];
    const r = spawnSync(process.execPath, argv, { cwd: root, encoding: 'utf8' });
    const got = (JSON.parse(r.stdout) as { code: string; severity: string; line: number; column: number }[]).map(d => `${d.code} ${d.severity} ${d.line}:${d.column}`);
    const want = expected.diagnostics.map(d => `${d.code} ${d.severity} ${d.line}:${d.column}`);
    if (got.join('|') !== want.join('|') || r.status !== expected.exitCode) wrong.push(`${entry.suite}: exit ${r.status}, ${got.join(', ')}`);
    ran++;
  }
  console.log(`  ${ran - wrong.length} of ${ran} entries match through the program (catalog-overlay entries are library-only); ${pendingNote}`);
  assert.deepEqual(wrong, []);
});
