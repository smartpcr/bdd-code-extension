// B2.1-6, B2.2, B2.4: lint output parsing, mapping and the per-linted-file results.
import * as assert from 'assert';
import * as path from 'path';
import { test } from 'node:test';
import {
  isRawDiagnostic, LintDiagnostic, LintResults, parseActionsOutput, parseLintOutput, RawDiagnostic, tokenEnd, toZeroBased,
} from '../../src/core/diagnostics';
import { bindingTooltip, renderBindingBadge } from '../../src/core/coverage';
import { createTrustGate } from '../../src/config/trust';
import { fileKey } from '../../src/core/paths';

const good: RawDiagnostic = { code: 'E101', severity: 'error', file: 'test/a.yml', line: 4, column: 5, message: 'Unknown key.' };

test('B2.1-6 the schema shape is accepted, with or without a suggestion', () => {
  assert.ok(isRawDiagnostic(good));
  assert.ok(isRawDiagnostic({ ...good, severity: 'warning', code: 'W304', suggestion: 'x' }));
});

test('B2.1-6 every deviation from the shape is rejected', () => {
  const bad: unknown[] = [
    null, [], 'x', { ...good, code: 'E10' }, { ...good, code: 'X101' }, { ...good, code: 1 },
    { ...good, severity: 'info' }, { ...good, file: '' }, { ...good, file: 1 },
    { ...good, line: 0 }, { ...good, line: 1.5 }, { ...good, column: '1' }, { ...good, message: '' }, { ...good, message: 2 },
    { ...good, suggestion: 3 }, { ...good, extra: true },
  ];
  for (const b of bad) assert.strictEqual(isRawDiagnostic(b), false, JSON.stringify(b));
});

test('parseLintOutput: exit 0 or 2 with a diagnostic array is a result; a BOM is ignored', () => {
  assert.deepStrictEqual(parseLintOutput('[]', 0), { ok: true, value: [] });
  assert.deepStrictEqual(parseLintOutput('﻿' + JSON.stringify([good]), 2), { ok: true, value: [good] });
});

test('parseLintOutput: anything else is a failure with a reason', () => {
  assert.deepStrictEqual(parseLintOutput('[]', 1), { ok: false, detail: 'exit code 1' });
  assert.deepStrictEqual(parseLintOutput('[]', null), { ok: false, detail: 'exit code null' });
  assert.deepStrictEqual(parseLintOutput('not json', 2), { ok: false, detail: 'the output is not JSON' });
  assert.deepStrictEqual(parseLintOutput('{}', 2), { ok: false, detail: 'the output is not a JSON array' });
  assert.deepStrictEqual(parseLintOutput('[{}]', 2), { ok: false, detail: 'element 0 is not a diagnostic' });
});

test('parseActionsOutput', () => {
  assert.deepStrictEqual(parseActionsOutput('["a","b"]'), { ok: true, value: ['a', 'b'] });
  assert.deepStrictEqual(parseActionsOutput('[1]'), { ok: false, detail: 'the output is not a JSON array of names' });
  assert.deepStrictEqual(parseActionsOutput('nope'), { ok: false, detail: 'the output is not JSON' });
});

test('toZeroBased resolves the file under the root (INV-10) and keeps a suggestion', () => {
  const root = path.resolve('/r');
  assert.deepStrictEqual(toZeroBased({ ...good, suggestion: 's' }, root), {
    code: 'E101', severity: 'error', file: fileKey(path.join(root, 'test/a.yml')), line: 3, character: 4, message: 'Unknown key.', suggestion: 's',
  });
  assert.strictEqual('suggestion' in toZeroBased(good, root), false);
});

test('tokenEnd: the YAML token at a column, or the line end', () => {
  assert.strictEqual(tokenEnd('    timeout: 30', 4), 11);
  assert.strictEqual(tokenEnd('  action: cluster.suspned', 10), 25);
  assert.strictEqual(tokenEnd('  - [a, b]', 3), 10);
  assert.strictEqual(tokenEnd('  x', 3), 3);
});

const d = (file: string, code = 'E101'): LintDiagnostic =>
  ({ code, severity: 'error', file: fileKey(file), line: 0, character: 0, message: 'm' });

test('INV-3 two linted files reporting into a shared library: each replaces only its own result', () => {
  const r = new LintResults();
  const a = path.resolve('/r/a.yml'), b = path.resolve('/r/b.yml'), lib = path.resolve('/r/lib.yml');
  assert.deepStrictEqual(r.replace(a, [d(a), d(lib, 'E301')]).sort(), [fileKey(a), fileKey(lib)].sort());
  r.replace(b, [d(lib, 'E302')]);
  assert.deepStrictEqual(r.forFile(lib).map(p => p.diagnostic.code).sort(), ['E301', 'E302']);
  assert.deepStrictEqual(r.replace(a, []).sort(), [fileKey(a), fileKey(lib)].sort());
  assert.deepStrictEqual(r.forFile(lib).map(p => p.diagnostic.code), ['E302']);
  assert.deepStrictEqual(r.forFile(a), []);
});

test('B2.4-1 a failure marks the previous result stale and never empties it', () => {
  const r = new LintResults();
  const a = path.resolve('/r/a.yml');
  assert.deepStrictEqual(r.markStale(a), []);
  r.replace(a, [d(a)]);
  assert.strictEqual(r.isStale(a), false);
  assert.deepStrictEqual(r.markStale(a), [fileKey(a)]);
  assert.strictEqual(r.isStale(a), true);
  assert.deepStrictEqual(r.forFile(a).map(p => [p.diagnostic.code, p.stale]), [['E101', true]]);
  r.replace(a, [d(a)]);
  assert.strictEqual(r.isStale(a), false);
  assert.strictEqual(r.isStale(path.resolve('/r/none.yml')), false);
});

test('renderBindingBadge: catalog order, abbreviations, unknown names last', () => {
  const known = [{ name: 'powershell', abbreviation: 'PS' }, { name: 'csharp', abbreviation: 'C#' }, { name: 'go', abbreviation: 'Go' },
    { name: 'rust', abbreviation: 'Rs' }, { name: 'odd' }];
  const order = ['powershell', 'csharp', 'go', 'rust'];
  assert.strictEqual(renderBindingBadge(order, ['rust', 'go', 'powershell', 'csharp'], known), 'PS C# Go Rs');
  assert.strictEqual(renderBindingBadge(order, ['powershell'], known), 'PS');
  assert.strictEqual(renderBindingBadge(order, [], known), '');
  assert.strictEqual(renderBindingBadge(order, ['python', 'go', 'odd'], known), 'Go python odd');
});

test('bindingTooltip names the implementers and a missing target', () => {
  const known = [{ name: 'powershell', label: 'PowerShell' }, { name: 'go', label: 'Go' }];
  assert.strictEqual(bindingTooltip(['powershell'], known, 'go'), 'Implemented by: PowerShell\nNot implemented by Go');
  assert.strictEqual(bindingTooltip(['powershell', 'go'], known, 'go'), 'Implemented by: PowerShell, Go');
  assert.strictEqual(bindingTooltip([], known, 'x'), 'Implemented by: no binding\nNot implemented by x');
});

test('the trust gate asks its host each time', () => {
  let trusted = false;
  const gate = createTrustGate(() => trusted);
  assert.strictEqual(gate.canRunWorkspaceCode(), false);
  trusted = true;
  assert.strictEqual(gate.canRunWorkspaceCode(), true);
  assert.match(gate.untrustedText, /untrusted/);
});
