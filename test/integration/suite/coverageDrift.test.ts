// session: worktree
// E-B7 drift half (B4.2-2) and the timing half B1.7 deferred: removing a
// registration shows as drift within 2 s of save, and restoring it clears it.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { CoverageRow } from '../../../src/core/coverage';
import { api, at, find, open, within } from './helpers';

const rust = async (): Promise<CoverageRow> => (await api()).coverage.rows().find(r => r.binding === 'rust')!;

describe('E-B7 drift appears when introduced', () => {
  it('B4.2-2 deleting the Rust dispatch arm for lifecycle.get shows "declared, not registered" within 2 s', async () => {
    const a = await api();
    assert.deepStrictEqual((await rust()).declaredNotFound, []);
    const doc = await open(at('test', 'e2e', 'bindings', 'rust', 'src', 'lifecycle', 'actions.rs'));
    const arm = find(doc, '"lifecycle.get" =>');
    const removed = doc.lineAt(arm.line).rangeIncludingLineBreak;
    const text = doc.getText(removed);
    const edit = new vscode.WorkspaceEdit();
    edit.delete(doc.uri, removed);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    const ms = await within(2000, async () => (await rust()).declaredNotFound.join() === 'lifecycle.get');
    const row = await rust();
    assert.strictEqual(row.foundNotDeclared.length + row.duplicates.length, 0);
    const item = a.coverage.getTreeItem({ kind: 'row', row });
    assert.match(String(item.label), /1 drift$/);
    const child = a.coverage.getChildren({ kind: 'row', row })[0];
    assert.ok(child.kind === 'item' && child.label === 'lifecycle.get' && child.description === 'declared, not registered');
    assert.ok(child.kind === 'item' && child.file && child.file.toLowerCase().endsWith('actions.catalog.yaml'), 'the item opens the catalog entry');
    console.log(`    drift shown ${ms} ms after save`);

    const restore = new vscode.WorkspaceEdit();
    restore.insert(doc.uri, removed.start, text);
    await vscode.workspace.applyEdit(restore);
    await doc.save();
    await within(2000, async () => (await rust()).declaredNotFound.length === 0);
    assert.strictEqual(find(doc, '"lifecycle.get" =>').line, arm.line, 'the arm is restored in place');
  });
});
