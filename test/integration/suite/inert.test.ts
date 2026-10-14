// session: empty
// B1.1-2: in a folder without a catalog the extension registers no provider.
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';

describe('B1.1 an empty folder', () => {
  it('B1.1-2 does not activate on its own, and registers no provider when activated', async () => {
    const ext = vscode.extensions.getExtension('local.bdd-suite')!;
    await new Promise(r => setTimeout(r, 2000));
    assert.strictEqual(ext.isActive, false, 'workspaceContains did not fire');
    const a = (await ext.activate()) as TestApi;
    assert.strictEqual(a.providerCount, 0);
    assert.strictEqual(a.indexers.length, 0);
    assert.deepStrictEqual(a.log, ['No actions catalog in this workspace; Suite Authoring is inert.']);
  });
});
