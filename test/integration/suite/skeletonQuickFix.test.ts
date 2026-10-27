// session: empty
// Add parameter: a step key its action does not take (E105, or the schema's
// "not allowed") has a quick fix that adds the key to the action's params in
// the catalog, typed from the step's value, and regenerates the schema, so the
// finding clears. The window's own folder becomes a skeleton workspace
// (TypeScript, so the editor lints with the runtime it carries, with nothing
// built); runs after skeleton.test.ts and inert.test.ts, which need the folder
// empty.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import type { ScaffoldResult } from '../../../src/features/scaffold';
import type { SkeletonResult } from '../../../src/features/skeleton';

const SUITE = `suite: example
tests:
  - name: echoes-text
    steps:
      - when: some text is echoed
        action: example.echo
        text: hello
        name: John
        captureAs: echoed
      - then: the same text comes back
        action: core.noop
        asserts:
          - var: echoed.text
            equals: hello
`;

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 250));
  }
}

const unknownParam = (d: vscode.Diagnostic) =>
  String(typeof d.code === 'object' ? d.code.value : d.code) === 'E105' || /^Property "name" is not allowed here\.$/.test(d.message);

describe('Add parameter: the quick fix on a step key its action does not take', () => {
  it('adds the key to the action\'s params, typed from its value, and the finding clears', async () => {
    const api = (await vscode.extensions.getExtension('asz.bdd-suite')!.activate()) as TestApi;
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const made = await vscode.commands.executeCommand<SkeletonResult>('bddSuite.createSkeleton',
      { target: root, languages: ['typescript'], name: 'example', open: false });
    assert.ok(made.ok && made.generator === 'exit 0', made.message);
    // The folder's new settings rebuild the extension around its catalog.
    await until('the catalog to be indexed', () => api.indexers.length > 0);
    await api.ready;

    const file = path.join(root, 'suites', 'example.yml');
    fs.writeFileSync(file, SUITE);
    const uri = vscode.Uri.file(file);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const line = doc.getText().split('\n').findIndex(l => l.trim() === 'name: John');
    const pos = new vscode.Position(line, 8);
    await until('the finding on name', () => vscode.languages.getDiagnostics(uri).find(d => unknownParam(d) && d.range.contains(pos)));

    const actions = (await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, new vscode.Range(pos, pos))) ?? [];
    const fix = actions.find(a => a.title === 'Add parameter name to example.echo');
    assert.ok(fix, `offered: ${actions.map(a => a.title).join(', ')}`);
    assert.strictEqual(fix.kind?.value, vscode.CodeActionKind.QuickFix.value);
    const r = await vscode.commands.executeCommand<ScaffoldResult>(fix.command!.command, ...(fix.command!.arguments ?? []));
    assert.ok(r.ok, r.message);
    assert.strictEqual(r.generator, 'exit 0');

    const catalog = parse(fs.readFileSync(path.join(root, 'schema', 'actions.catalog.yaml'), 'utf8')) as { actions: { name: string; params: { name: string; type: string }[] }[] };
    assert.deepStrictEqual(catalog.actions.find(a => a.name === 'example.echo')!.params.map(p => [p.name, p.type]), [['text', 'string'], ['name', 'string']]);
    // The next save lints again against the regenerated schema, as after Declare action: the finding is gone.
    // (A save of an unchanged document does nothing, so the edit first.)
    await vscode.window.showTextDocument(doc);
    const touch = new vscode.WorkspaceEdit();
    touch.insert(uri, new vscode.Position(doc.lineCount, 0), '# saved after adding the parameter\n');
    await vscode.workspace.applyEdit(touch);
    await doc.save();
    const remaining = () => vscode.languages.getDiagnostics(uri).filter(d => unknownParam(d) && d.range.contains(pos));
    await until(`the finding to clear (still: ${JSON.stringify(remaining().map(d => [d.source, d.code, d.message]))})`, () => remaining().length === 0);
    // And with the key a parameter, the fix is no longer offered.
    const again = (await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, new vscode.Range(pos, pos))) ?? [];
    assert.ok(!again.some(a => a.title.startsWith('Add parameter')), again.map(a => a.title).join(', '));
  });
});
