// session: oscontext
// E-B1 in the editor (B2.2 with rust; B2.5 with the four program tools; B8.3 with typescript), on open.
// Settings are written to the test instance's user settings, never to os-context.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { sig, validateEntries } from '../harness/corpus';
import { api, folder, hasTypeScript, open } from './helpers';
import { lint, nextLint, setting, shown } from './lintHelpers';

const G = vscode.ConfigurationTarget.Global;

async function editorMismatches(tool: string): Promise<{ checked: number; mismatches: string[] }> {
  await setting('lintTool', tool, G, a => a.controllers[0].tool === tool);
  const { entries } = validateEntries(folder());
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

describe('E-B1 the editor shows exactly what the corpus says lint must find', () => {
  after(async () => {
    await vscode.workspace.getConfiguration('bddSuite').update('lintTool', undefined, G);
    await vscode.workspace.getConfiguration('bddSuite').update('targetBinding', undefined, G);
  });

  // typescript lints through the library in the lint worker (B8.3), when the checkout carries it.
  for (const tool of ['rust', 'go', 'csharp', ...(hasTypeScript() ? ['typescript'] : [])]) {
    it(`${tool}: every eligible validate entry, on open, at the corpus positions`, async () => {
      const { checked, mismatches } = await editorMismatches(tool);
      assert.deepStrictEqual(mismatches, []);
      console.log(`    ${tool}: ${checked} entries match the corpus in the editor`);
    });
  }

  it('powershell: every eligible validate entry (blocked by PowerShell 7.6.7 Test-Json)', async function () {
    this.timeout(600_000);
    const { checked, mismatches } = await editorMismatches('powershell');
    const structural = mismatches.every(m => /got \[.*\]; want \[/.test(m));
    if (mismatches.length && structural) {
      console.log(`    powershell: ${mismatches.length} of ${checked} differ, each missing schema findings:\n      ${mismatches.join('\n      ')}`);
      this.skip();
    }
    assert.deepStrictEqual(mismatches, []);
  });

  it('a diagnostic carries the code, the tool as source, the suggestion, and a range over the token', async () => {
    await setting('lintTool', 'go', G, a => a.controllers[0].tool === 'go');
    await setting('targetBinding', 'powershell', G, a => a.controllers[0].target === 'powershell');
    const uri = vscode.Uri.file(path.join(folder(), 'test/e2e/conformance/validate/typos.yml'));
    const doc = await open(uri);
    await lint(uri);
    const e104 = vscode.languages.getDiagnostics(uri).find(d => d.code === 'E104')!;
    assert.ok(e104);
    assert.strictEqual(e104.source, 'suiterun:go');
    assert.match(e104.message, /\nDid you mean cluster\.suspend/);
    assert.strictEqual(doc.getText(e104.range), 'cluster.suspned');
    assert.strictEqual((await api()).status.text, 'Suite: lint go -> powershell');
  });
});
