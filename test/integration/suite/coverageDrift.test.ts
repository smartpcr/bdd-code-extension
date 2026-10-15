// session: worktree
// E-B7 drift half (B4.2-2) and the timing half B1.7 deferred: removing a
// registration shows as drift within 2 s of save, and restoring it clears it.
// Rust always; TypeScript when the checkout carries it (B7.7).
import * as assert from 'assert';
import * as vscode from 'vscode';
import { CoverageRow } from '../../../src/core/coverage';
import { api, at, find, hasTypeScript, open, within } from './helpers';

const row = async (binding: string): Promise<CoverageRow> => (await api()).coverage.rows().find(r => r.binding === binding)!;

const cases: { binding: string; what: string; file: string[]; line: string }[] = [
  { binding: 'rust', what: 'the Rust dispatch arm', file: ['rust', 'src', 'lifecycle', 'actions.rs'], line: '"lifecycle.get" =>' },
  ...(hasTypeScript()
    ? [{ binding: 'typescript', what: 'the TypeScript registration', file: ['typescript', 'src', 'lifecycle', 'actions.ts'], line: "action('lifecycle.get', lifecycleGet)," }]
    : []),
];

describe('E-B7 drift appears when introduced', () => {
  for (const c of cases) {
    it(`B4.2-2 deleting ${c.what} for lifecycle.get shows "declared, not registered" within 2 s`, async () => {
      const a = await api();
      assert.deepStrictEqual((await row(c.binding)).declaredNotFound, []);
      const doc = await open(at('test', 'e2e', 'bindings', ...c.file));
      const arm = find(doc, c.line);
      const removed = doc.lineAt(arm.line).rangeIncludingLineBreak;
      const text = doc.getText(removed);
      const edit = new vscode.WorkspaceEdit();
      edit.delete(doc.uri, removed);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
      const ms = await within(2000, async () => (await row(c.binding)).declaredNotFound.join() === 'lifecycle.get');
      const now = await row(c.binding);
      assert.strictEqual(now.foundNotDeclared.length + now.duplicates.length, 0);
      const item = a.coverage.getTreeItem({ kind: 'row', row: now });
      assert.match(String(item.label), /1 drift$/);
      const child = a.coverage.getChildren({ kind: 'row', row: now })[0];
      assert.ok(child.kind === 'item' && child.label === 'lifecycle.get' && child.description === 'declared, not registered');
      assert.ok(child.kind === 'item' && child.file && child.file.toLowerCase().endsWith('actions.catalog.yaml'), 'the item opens the catalog entry');
      console.log(`    ${c.binding}: drift shown ${ms} ms after save`);

      const restore = new vscode.WorkspaceEdit();
      restore.insert(doc.uri, removed.start, text);
      await vscode.workspace.applyEdit(restore);
      await doc.save();
      await within(2000, async () => (await row(c.binding)).declaredNotFound.length === 0);
      assert.strictEqual(find(doc, c.line).line, arm.line, 'the registration is restored in place');
    });
  }
});
