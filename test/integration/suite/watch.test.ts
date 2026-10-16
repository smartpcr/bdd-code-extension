// session: worktree
// B1.7 and the hover half of E-B8, in the worktree's sample: a parameter added
// to shipping.quote, a Go registration added for an undeclared action. The
// sample is put back as this file found it.
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { api, asLocations, at, find, folder, hoverText, open, restoreSample, revert, sampleSnapshot, within } from './helpers';

async function definitions(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.Location[]> {
  return asLocations(await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider', uri, pos));
}

describe('B1.7 the index stays current', () => {
  let snapshot: Map<string, Buffer>;
  before(() => {
    snapshot = sampleSnapshot();
  });

  it('B1.7-1 / E-B8 hover half: a catalog save is visible in hover within 1 s, without a reload', async () => {
    const a = await api();
    const suite = await open(at('test', 'e2e', 'suites', 'shipping.yml'));
    const pos = find(suite, 'action: shipping.quote', 10);
    assert.match(await hoverText(suite.uri, pos), /`policy`/);
    assert.doesNotMatch(await hoverText(suite.uri, pos), /`reason`/);

    const catalog = await open(at('test', 'e2e', 'schema', 'actions.catalog.yaml'));
    const anchor = find(catalog, '      - { name: policy, type: string, default: Standard');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(catalog.uri, new vscode.Position(anchor.line, 0), '      - { name: reason, type: string, description: Why. }\n');
    await vscode.workspace.applyEdit(edit);
    await catalog.save();
    const ms = await within(1000, async () => /`reason`/.test(await hoverText(suite.uri, pos)));
    console.log(`    hover showed the new parameter ${ms} ms after save; extension instance unchanged: ${a === await api()}`);
  });

  it('E-B8 completion half (B3.4): after Build-Schema.ps1, key completion in the step offers reason, once', async () => {
    const built = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', 'test/e2e/schema/Build-Schema.ps1'],
      { cwd: folder(), encoding: 'utf8' });
    assert.strictEqual(built.status, 0, `${built.stdout}\n${built.stderr}`);
    const suite = await open(at('test', 'e2e', 'suites', 'shipping.yml'));
    const anchor = find(suite, 'policy: Express');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(suite.uri, new vscode.Position(anchor.line + 1, 0), '        rea\n');
    await vscode.workspace.applyEdit(edit);
    const pos = new vscode.Position(anchor.line + 1, 11);
    let reason: vscode.CompletionItem[] = [];
    const ms = await within(15_000, async () => {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', suite.uri, pos);
      reason = list.items.filter(i => (typeof i.label === 'string' ? i.label : i.label.label) === 'reason');
      return reason.length > 0;
    });
    assert.strictEqual(reason.length, 1, 'offered once');
    console.log(`    reason offered ${ms} ms after the request began (detail: ${reason[0].detail ?? 'none'})`);
    await revert(suite.uri);
  });

  it('B1.7-2 a new registration line is a definition target within 1 s of save; a new suite file is indexed', async () => {
    await api();
    const scratch = at('test', 'e2e', 'suites', '_scratch-b17.yml');
    fs.writeFileSync(scratch.fsPath, 'suite: scratch\ntests:\n  - name: c\n    steps:\n      - action: demo.echo\n');
    const suite = await open(scratch);
    const pos = find(suite, 'demo.echo', 2);
    await within(2000, async () => (await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', scratch, pos))
      .some(h => h.contents.some(c => (typeof c === 'string' ? c : c.value).includes('not in the action catalog'))));
    assert.strictEqual((await definitions(scratch, pos)).length, 0);

    const go = await open(at('test', 'e2e', 'bindings', 'go', 'actions', 'actions.go'));
    const anchor = find(go, '{Name: "inventory.get", Handler: inventoryGet},');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(go.uri, new vscode.Position(anchor.line, 0), '\t{Name: "demo.echo", Handler: inventoryGet},\n');
    await vscode.workspace.applyEdit(edit);
    await go.save();
    const ms = await within(1000, async () => (await definitions(scratch, pos)).some(l => l.uri.fsPath === go.uri.fsPath));
    console.log(`    the new Go registration was a definition target ${ms} ms after save`);
  });

  it('an unsaved edit to a suite is indexed after the debounce', async () => {
    const a = await api();
    const scratch = at('test', 'e2e', 'suites', '_scratch-b17.yml');
    const doc = await open(scratch);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(scratch, new vscode.Position(doc.lineCount, 0), '      - action: core.noop\n');
    await vscode.workspace.applyEdit(edit);
    await within(1000, () => a.indexers[0].index.suite(scratch.fsPath)!.steps.some(s => s.action === 'core.noop'));
    assert.ok(doc.isDirty);
  });

  it('a deleted suite leaves the index', async () => {
    const a = await api();
    const scratch = at('test', 'e2e', 'suites', '_scratch-b17.yml');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(scratch);
    await within(2000, () => a.indexers[0].index.suite(scratch.fsPath) === undefined);
  });

  it('a settings change rebuilds the layout and the index, reporting a wrong type', async () => {
    const before = await api();
    const first = before.indexers[0];
    await vscode.workspace.getConfiguration('bddSuite').update('lintTool', 42, vscode.ConfigurationTarget.Workspace);
    await within(5000, () => before.indexers[0] !== first && before.log.some(l => l.startsWith('BDD010 bddSuite.lintTool')));
    await before.ready;
    assert.ok(before.indexers[0].index.catalog!.actions.size > 0);
    await vscode.workspace.getConfiguration('bddSuite').update('lintTool', undefined, vscode.ConfigurationTarget.Workspace);
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const touched = restoreSample(snapshot);
    console.log(`    restored the sample: ${touched.length} file(s)`);
  });
});
