// session: oscontext
// E-B2 except its completion-order assertion (B2.3).
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseLintOutput } from '../../../src/core/diagnostics';
import { lintCommand } from '../../../src/tools/profiles';
import { runTool } from '../../../src/tools/runTool';
import { api, folder, hasTypeScript, open, within } from './helpers';
import { lint, setting, shown } from './lintHelpers';

const G = vscode.ConfigurationTarget.Global;

describe('E-B2 a step the target binding cannot run is marked, and says who can', () => {
  after(async () => {
    await vscode.workspace.getConfiguration('bddSuite').update('lintTool', undefined, G);
    await vscode.workspace.getConfiguration('bddSuite').update('targetBinding', undefined, G);
  });

  it('B2.3-1 the editor E201 set equals the terminal for the same file, tool and target', async () => {
    await setting('lintTool', 'go', G, a => a.controllers[0].tool === 'go');
    const a = await setting('targetBinding', 'rust', G, x => x.controllers[0].target === 'rust');
    const uri = vscode.Uri.file(path.join(folder(), 'test/e2e/suites/smoke.yml'));
    await open(uri);
    const event = await lint(uri);
    assert.strictEqual(event.outcome, 'published');
    const editor = shown(uri).filter(d => d.sig.startsWith('E201'));

    const layout = a.indexers[0].layout;
    const go = layout.bindings.find(b => b.name === 'go')!;
    const r = await runTool(lintCommand(go, layout.root, 'test/e2e/suites/smoke.yml', 'rust'));
    assert.strictEqual(r.kind, 'exited');
    const parsed = r.kind === 'exited' ? parseLintOutput(r.stdout, r.code) : undefined;
    assert.ok(parsed?.ok);
    const terminal = parsed.value.filter(d => d.code === 'E201').map(d => `${d.code} ${d.severity} ${d.line}:${d.column}`);
    assert.ok(terminal.length > 0, 'smoke.yml uses actions rust does not implement');
    assert.deepStrictEqual(editor.map(d => d.sig), terminal);
    console.log(`    smoke.yml under rust: ${terminal.length} E201`);
  });

  it('B2.3-2 inlay hints list exactly each action\'s catalog bindings', async () => {
    const a = await api();
    const uri = vscode.Uri.file(path.join(folder(), 'test/e2e/suites/smoke.yml'));
    const doc = await open(uri);
    const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', uri,
      new vscode.Range(0, 0, doc.lineCount, 0));
    const ours = hints.filter(h => typeof h.label === 'string' && /^(PS|C#|Go|Rs|TS)( |$)/.test(h.label));
    const suite = a.indexers[0].index.suite(uri.fsPath)!;
    const catalog = a.indexers[0].index.catalog!;
    const steps = suite.steps.filter(s => s.action && catalog.actions.has(s.action));
    assert.strictEqual(ours.length, steps.length);
    const abbr: Record<string, string> = { powershell: 'PS', csharp: 'C#', go: 'Go', rust: 'Rs', typescript: 'TS' };
    for (const s of steps) {
      const h = ours.find(x => x.position.line === s.actionRange!.end.line)!;
      const want = catalog.bindings.filter(b => catalog.actions.get(s.action!)!.bindings.includes(b)).map(b => abbr[b]).join(' ');
      assert.strictEqual(h.label, want, s.action);
    }
    const labels = new Map(steps.map(s => [s.action, ours.find(x => x.position.line === s.actionRange!.end.line)!.label]));
    assert.strictEqual(labels.get('cluster.state'), 'PS');
    assert.strictEqual(labels.get('core.noop'), hasTypeScript() ? 'PS C# Go Rs TS' : 'PS C# Go Rs');
    assert.match(String(ours.find(h => h.label === 'PS')!.tooltip), /Not implemented by Rust/);
  });

  it('B2.3-3 changing the target re-lints open suites without a save; under powershell no E201 remains', async () => {
    const uri = vscode.Uri.file(path.join(folder(), 'test/e2e/suites/smoke.yml'));
    await setting('targetBinding', 'powershell', G, x => x.controllers[0].target === 'powershell');
    await within(10_000, () => shown(uri).every(d => !d.sig.startsWith('E201')) && shown(uri).length >= 0);
    assert.strictEqual(shown(uri).filter(d => d.sig.startsWith('E201')).length, 0);
  });
});
