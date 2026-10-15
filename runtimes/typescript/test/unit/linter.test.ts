// index.ts: createLinter() gives the file's answer from an overlay, and
// never reads an overlaid path from disk (B7.4-2); the API version (B7.4-3).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { apiVersion, createLinter } from '../../src/index.js';
import { diskReader } from '../../src/reader.js';
import { corpus, corpusExtension, corpusSchema, repo } from '../where.js';

const root = repo;
const manifest = parse(fs.readFileSync(path.join(corpus, 'run-manifest.yaml'), 'utf8')) as {
  entries: { kind: string; suite: string; binding?: string; bindingCheck?: boolean; params?: Record<string, unknown>; catalogOverlay?: string }[];
};
const sig = (d: { code: string; line: number; column: number }) => `${d.code}@${d.line}:${d.column}`;

test('B7.4-3 the API version is 1.1.0: extensions were added, nothing an existing caller reads changed', () => {
  assert.equal(apiVersion, '1.1.0');
});

test('every validate entry linted from an overlay at another path in its directory gives the file\'s codes and positions', () => {
  const linter = createLinter({ root, schemaRoot: corpusSchema, extensions: [corpusExtension] });
  let compared = 0;
  for (const e of manifest.entries.filter(x => x.kind === 'validate' && !x.catalogOverlay)) {
    const file = path.join(corpus, e.suite);
    // A suite that imports itself is a cycle only under its own name; at another path it is not, by design.
    if (fs.readFileSync(file, 'utf8').includes(path.basename(file))) continue;
    const ghost = path.join(path.dirname(file), `_overlay-${path.basename(file)}`);
    const request = { binding: e.binding, bindingCheck: e.bindingCheck, params: Object.entries(e.params ?? {}).map(([k, v]) => [k, String(v)] as [string, string]) };
    const fromDisk = linter.lint({ ...request, paths: [file] }).map(sig);
    const fromOverlay = linter.lint({ ...request, paths: [ghost], overlays: { [ghost]: fs.readFileSync(file, 'utf8') } }).map(sig);
    assert.deepEqual(fromOverlay, fromDisk, e.suite);
    assert.ok(!fs.existsSync(ghost), 'the overlay path is never written');
    compared++;
  }
  console.log(`  ${compared} validate entries give the same answer from an overlay`);
});

test('B7.4-2 an overlaid path is never read from disk, imports included', () => {
  const file = path.join(corpus, 'validate', 'typos.yml');
  const lib = path.join(corpus, 'validate', '_overlay-lib.yml');
  const reads: string[] = [];
  const throwing = { read(p: string) {
    reads.push(path.resolve(p).toLowerCase());
    if ([file, lib].some(f => f.toLowerCase() === path.resolve(p).toLowerCase())) throw new Error('read an overlaid file from disk');
    return diskReader.read(p);
  } };
  const found = createLinter({ root, schemaRoot: corpusSchema, reader: throwing }).lint({ paths: [file], overlays: {
    [file]: 'suite: s\nimports: [_overlay-lib.yml]\nsuiet: x\ntests:\n  - name: c\n    steps: [{ action: core.noop }]\n',
    [lib]: 'description: an overlaid library\n',
  } });
  assert.deepEqual(found.map(sig), ['E101@3:1']);
  assert.deepEqual(Object.keys(found[0]!).sort(), ['code', 'column', 'file', 'line', 'message', 'severity', 'suggestion']);
  assert.equal(found[0]!.file, 'conformance/validate/typos.yml');
  assert.ok(reads.length > 0, 'the schema and catalog came through the reader');
});

test('an overlaid import is read from the overlay; invalidate() reads the schema again', () => {
  const dir = path.join(corpus, 'validate');
  const suite = path.join(dir, '_overlay-suite.yml');
  const lib = path.join(dir, '_overlay-lib.yml');
  const linter = createLinter({ root, schemaRoot: corpusSchema });
  const found = linter.lint({
    paths: [suite],
    overlays: { [suite]: 'suite: s\nimports: [_overlay-lib.yml]\ntests:\n  - name: c\n    steps: [{ action: core.noop }]\n', [lib]: 'tests: []\n' },
  });
  assert.deepEqual(found.map(sig), ['E211@2:11']);
  linter.invalidate();
  assert.deepEqual(linter.lint({ paths: [suite], overlays: { [suite]: 'suite: s\ntests:\n  - name: c\n    steps: [{ action: core.noop }]\n' } }), []);
});
