// session: worktree
// B1.7 and the hover half of E-B8, in a disposable worktree of os-context.
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { api, asLocations, at, find, hoverText, open, within } from './helpers';

async function definitions(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.Location[]> {
  return asLocations(await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider', uri, pos));
}

describe('B1.7 the index stays current', () => {
  it('B1.7-1 / E-B8 hover half: a catalog save is visible in hover within 1 s, without a reload', async () => {
    const a = await api();
    const suite = await open(at('test', 'e2e', 'suites', 'drain.yml'));
    const pos = find(suite, 'action: cluster.resume', 10);
    assert.doesNotMatch(await hoverText(suite.uri, pos), /`reason`/);

    const catalog = await open(at('test', 'e2e', 'schema', 'actions.catalog.yaml'));
    const anchor = find(catalog, "      - { name: failback, type: string, default: NoFailback");
    const edit = new vscode.WorkspaceEdit();
    edit.insert(catalog.uri, new vscode.Position(anchor.line, 0), '      - { name: reason, type: string, description: Why. }\n');
    await vscode.workspace.applyEdit(edit);
    await catalog.save();
    const ms = await within(1000, async () => /`reason`/.test(await hoverText(suite.uri, pos)));
    console.log(`    hover showed the new parameter ${ms} ms after save; extension instance unchanged: ${a === await api()}`);
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

    const go = await open(at('test', 'e2e', 'bindings', 'go', 'internal', 'actions', 'actions.go'));
    const anchor = find(go, '"core.noop":');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(go.uri, new vscode.Position(anchor.line, 0), '\t\t"demo.echo":   noop,\n');
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
});
