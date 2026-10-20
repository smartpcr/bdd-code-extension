// The corpus manifest, both ways: every file it names exists, and every file
// under validate/ and execute/ is an entry or named as support. A directory
// walk that found nothing would look like one that found everything and
// skipped it; this is what stops a binding running less of the corpus.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { corpus } from '../where.js';

type Raw = Record<string, unknown>;

const manifest = (corpus ? parse(fs.readFileSync(path.join(corpus, 'run-manifest.yaml'), 'utf8')) : {}) as Raw;
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((x): x is Raw => !!x && typeof x === 'object') : []);
const text = (o: Raw, k: string): string[] => (typeof o[k] === 'string' && o[k] ? [o[k] as string] : []);

function named(): string[] {
  const out: string[] = [];
  for (const e of list(manifest.entries)) for (const k of ['suite', 'expectation', 'catalogOverlay', 'progress']) out.push(...text(e, k));
  for (const s of Array.isArray(manifest.support) ? manifest.support : []) if (typeof s === 'string') out.push(s);
  for (const t of list(manifest.tables)) for (const k of ['context', 'cases']) out.push(...text(t, k));
  const reports = (manifest.reports ?? {}) as Raw;
  out.push(...text(reports, 'definition'));
  for (const e of list(reports.entries)) for (const k of ['suite', 'expected']) out.push(...text(e, k));
  return out;
}

test('the corpus is found from this package', () => {
  assert.ok(corpus && fs.existsSync(path.join(corpus, 'run-manifest.yaml')), 'run from inside this repository');
  assert.equal(manifest.version, 1);
});

test('every file the manifest names is there', () => {
  const names = named();
  assert.ok(names.length > 100, `${names.length} names`);
  const missing = names.filter(n => !fs.existsSync(path.join(corpus!, n)) || !fs.statSync(path.join(corpus!, n)).isFile());
  assert.deepEqual(missing, []);
});

test('every file under validate/ and execute/ is an entry or support', () => {
  const known = new Set(named());
  const stray: string[] = [];
  for (const dir of ['validate', 'execute']) {
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(path.join(corpus!, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(child);
        else if (!known.has(child)) stray.push(child);
      }
    };
    walk(dir);
  }
  assert.deepEqual(stray, []);
  const kinds = list(manifest.entries).map(e => e.kind);
  console.log(`  ${kinds.filter(k => k === 'validate').length} validate and ${kinds.filter(k => k === 'execute').length} execute entries`);
});
