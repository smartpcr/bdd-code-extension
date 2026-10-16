// session: sample
// E-B1 in the editor (B2.2 with rust; B2.5 with the four program tools; B8.3 with typescript), on open.
// The expectation is the lint oracle: what the five `suiterun` programs report
// for every sample suite and target (harness/corpus.ts, DEC-S11).
// Settings are written to the test instance's user settings, never to the sample.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { sig, validateEntries } from '../harness/corpus';
import { api, folder, open } from './helpers';
import { lint, nextLint, setting, shown } from './lintHelpers';

const G = vscode.ConfigurationTarget.Global;

async function editorMismatches(tool: string): Promise<{ checked: number; mismatches: string[] }> {
  await setting('lintTool', tool, G, a => a.controllers[0].tool === tool);
  // Grouped by target, so the target setting changes five times, not once per entry.
  const entries = [...validateEntries().entries].sort((x, y) => x.target.localeCompare(y.target) || x.rel.localeCompare(y.rel));
  const mismatches: string[] = [];
  let checked = 0;
  for (const e of entries) {
    let a = await api();
    if (a.controllers[0].target !== e.target) a = await setting('targetBinding', e.target, G, x => x.controllers[0].target === e.target);
    const uri = vscode.Uri.file(path.join(folder(), e.rel));
    const wasOpen = vscode.workspace.textDocuments.some(d => d.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase());
    const event = wasOpen ? await lint(uri) : await (async () => {
      const next = nextLint(uri.fsPath);
      await open(uri);
      return next;
    })();
    checked++;
    if (event.outcome !== 'published') {
      mismatches.push(`${e.suite}: ${event.outcome} ${event.status ?? ''}`);
      continue;
    }
    const got = shown(uri);
    const want = e.diagnostics.map(sig);
    if (JSON.stringify(got.map(g => g.sig)) !== JSON.stringify(want)) {
      mismatches.push(`${e.suite}: got [${got.map(g => g.sig).join(', ')}]; want [${want.join(', ')}]`);
    }
    if (got.some(g => g.source !== `suiterun:${tool}`)) mismatches.push(`${e.suite}: wrong source ${got.map(g => g.source)}`);
  }
  return { checked, mismatches };
}

describe('E-B1 the editor shows exactly what the runtimes say lint must find', () => {
  after(async () => {
    await vscode.workspace.getConfiguration('bddSuite').update('lintTool', undefined, G);
    await vscode.workspace.getConfiguration('bddSuite').update('targetBinding', undefined, G);
  });

  it('the oracle covers every sample suite against every target, flawed files included', () => {
    const { entries } = validateEntries();
    const files = new Set(entries.map(e => e.rel));
    for (const f of ['smoke.yml', 'checkout.yml', 'waiting.yml', 'shipping.yml', 'large.yml', 'flawed/typos.yml', 'flawed/dataflow.yml', 'flawed/tables.yml']) {
      assert.ok(files.has(`test/e2e/suites/${f}`), f);
    }
    assert.strictEqual(entries.length, files.size * 5);
    assert.ok(entries.some(e => e.diagnostics.length > 0) && entries.some(e => e.diagnostics.length === 0));
  });

  // typescript lints through the library in the lint worker (B8.3).
  for (const tool of ['rust', 'go', 'csharp', 'typescript', 'powershell']) {
    it(`${tool}: every suite and target, on open, at the oracle's positions`, async function () {
      if (tool === 'powershell') this.timeout(600_000);
      const { checked, mismatches } = await editorMismatches(tool);
      assert.deepStrictEqual(mismatches, []);
      console.log(`    ${tool}: ${checked} entries match the oracle in the editor`);
    });
  }

  it('a diagnostic carries the code, the tool as source, the suggestion, and a range over the token', async () => {
    await setting('lintTool', 'go', G, a => a.controllers[0].tool === 'go');
    await setting('targetBinding', 'powershell', G, a => a.controllers[0].target === 'powershell');
    const rel = 'test/e2e/suites/flawed/typos.yml';
    const want = validateEntries().entries.find(e => e.rel === rel && e.target === 'powershell')!.diagnostics.find(d => d.code === 'E104')!;
    assert.ok(want?.suggestion, 'the oracle has an E104 with a suggestion');
    const uri = vscode.Uri.file(path.join(folder(), rel));
    const doc = await open(uri);
    await lint(uri);
    const e104 = vscode.languages.getDiagnostics(uri).find(d => d.code === 'E104')!;
    assert.ok(e104);
    assert.strictEqual(e104.source, 'suiterun:go');
    assert.ok(e104.message.startsWith(want.message!), e104.message);
    assert.ok(e104.message.includes(`\n${want.suggestion}`), e104.message);
    assert.match(e104.message, /\nDid you mean inventory\.get/);
    assert.strictEqual(doc.getText(e104.range), 'inventory.gte');
    assert.deepStrictEqual([e104.range.start.line + 1, e104.range.start.character + 1], [want.line, want.column]);
    assert.strictEqual((await api()).status.text, 'Suite: lint go -> powershell');
  });
});
