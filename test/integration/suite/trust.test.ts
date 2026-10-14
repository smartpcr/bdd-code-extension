// session: untrusted
// E-B15 program half (B2.6): in an untrusted workspace no binding code runs.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { api, asLocations, find, folder, hoverText, open, within } from './helpers';
import { shown } from './lintHelpers';

describe('E-B15 an untrusted workspace runs no binding code', () => {
  it('the window is untrusted, and the status bar says lint and run are disabled', async () => {
    assert.strictEqual(vscode.workspace.isTrusted, false);
    const a = await api();
    assert.strictEqual(a.status.text, 'Suite: untrusted, lint and run disabled');
  });

  it('B2.6-1 opening a suite, linting it and asking for actions start no process', async () => {
    const a = await api();
    const uri = vscode.Uri.file(path.join(folder(), 'test/e2e/conformance/validate/typos.yml'));
    await open(uri);
    await new Promise(r => setTimeout(r, 1500));
    const e = await a.controllers[0].lintNow(uri);
    assert.strictEqual(e.outcome, 'failed');
    assert.strictEqual(e.status, 'Suite: untrusted, lint and run disabled');
    assert.strictEqual(a.controllers[0].lintsStarted, 0, 'no lint process was started');
    assert.deepStrictEqual(shown(uri), []);
    const actions = await vscode.commands.executeCommand('bddSuite.showActions', 'rust');
    assert.strictEqual(actions, undefined);
    assert.ok(a.log.some(l => l.includes('untrusted') || l.includes('not trusted')), a.log.join('\n'));
    const built = await vscode.commands.executeCommand('bddSuite.buildLintTool', 'go');
    assert.strictEqual(built, false);
  });

  it('B2.6-2 navigation and hover still answer', async () => {
    const doc = await open(vscode.Uri.file(path.join(folder(), 'test/e2e/suites/smoke.yml')));
    const pos = find(doc, 'action: cluster.state', 10);
    assert.match(await hoverText(doc.uri, pos), /\*\*cluster\.state\*\*/);
    const defs = asLocations(await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, pos));
    assert.strictEqual(defs.length, 2);
  });

  it('B2.6-3 granting trust lints open suites without a reload', async () => {
    const a = await api();
    const uri = vscode.Uri.file(path.join(folder(), 'test/e2e/conformance/validate/typos.yml'));
    const instance = a.controllers[0];
    // VS Code offers no API to grant trust; the harness calls what the
    // onDidGrantWorkspaceTrust listener calls (see the evidence's named gap).
    assert.ok(a.grantTrustForTest, 'the harness set BDD_TEST_TRUST_SEAM');
    a.grantTrustForTest!();
    await within(15_000, () => shown(uri).length === 3);
    assert.strictEqual(a.controllers[0], instance, 'the same controller: no reload or rebuild');
    assert.ok(instance.lintsStarted > 0);
    assert.strictEqual(a.status.text, 'Suite: lint rust -> powershell');
  });
});
