// session: worktree
// E14 (docs/test-providers, D16): the editor knows bddsuite.tests.yaml. The
// sample's C# config, edited without saving: a misspelled key and an unknown
// provider are marked, and completion under provider: offers the providers.
// A scratch suite with a config beside it: the editor's run treats the
// config's offlineActions as offline, as the generated tests do, and without
// the config it is a lab suite again. The runs use a fake binding program and
// answer through SuiteTesting.ui, so nothing reaches a lab.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RunUi } from '../../../src/features/testing';
import { api, at, within } from './helpers';
import { setting } from './lintHelpers';

const W = vscode.ConfigurationTarget.Workspace;
const FAKE_LAB = path.resolve(__dirname, '../../../../test/fake-tool/fake-lab-runner.mjs');
const SAMPLE_CONFIG = ['tests', 'csharp', 'shared', 'bddsuite.tests.yaml'];
const FOLDER = 'test/e2e/suites/_scratch-config';
const SUITE = `${FOLDER}/scratch-offline.yml`;
const CONFIG = `${FOLDER}/bddsuite.tests.yaml`;

const configDiagnostics = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter(d => d.source === 'bdd-suite tests config');

describe('E14 the editor knows bddsuite.tests.yaml', function () {
  this.timeout(120_000);
  let ui: RunUi;

  before(async () => {
    fs.mkdirSync(at(...FOLDER.split('/')).fsPath, { recursive: true });
    fs.writeFileSync(at(...SUITE.split('/')).fsPath, `suite: scratch-offline
tests:
  - name: reads-the-stock
    steps:
      - when: the stock is read
        action: inventory.get
        sku: APPLE
`);
    ui = (await api()).testing.ui;
  });

  after(async () => {
    (await api()).testing.ui = ui;
    fs.rmSync(at(...FOLDER.split('/')).fsPath, { recursive: true, force: true });
    await vscode.workspace.getConfiguration('bddSuite').update('bindings', undefined, W);
    await setting('targetBinding', undefined, W, x => x.indexers[0]?.layout.settings.targetBinding === 'powershell');
  });

  it('E14 a misspelled key and an unknown provider are marked; completion under provider: offers the providers', async () => {
    const doc = await vscode.workspace.openTextDocument(at(...SAMPLE_CONFIG));
    const editor = await vscode.window.showTextDocument(doc);
    await within(10_000, () => configDiagnostics(doc.uri).length === 0);
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    await editor.edit(e => e.insert(end, '\nprovidr: mstest\nprovider: junit\n'));
    await within(10_000, () => configDiagnostics(doc.uri).length === 2);
    const byCode = Object.fromEntries(configDiagnostics(doc.uri).map(d => [String(d.code), d]));
    assert.match(byCode.BDD070!.message, /^providr is not a config key \(spec\/tests\.config\.schema\.json\)\. Did you mean provider\?$/);
    assert.strictEqual(doc.getText(byCode.BDD070!.range), 'providr');
    assert.match(byCode.BDD071!.message, /Valid values: mstest, nunit, xunit, go, rust, node, vitest, jest, mocha, pester/);
    assert.strictEqual(doc.getText(byCode.BDD071!.range), 'junit');
    const line = doc.lineCount - 2;
    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(line, 'provider: '.length));
    const offered = list.items.map(i => (typeof i.label === 'string' ? i.label : i.label.label));
    for (const p of ['mstest', 'nunit', 'xunit', 'go', 'rust', 'node', 'vitest', 'jest', 'mocha', 'pester']) assert.ok(offered.includes(p), `${p} offered: ${offered.join(', ')}`);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  it('E14 a run takes offlineActions from the nearest bddsuite.tests.yaml; without it the suite is a lab suite', async () => {
    const a = await setting('targetBinding', 'go', W, x => x.indexers[0]?.layout.settings.targetBinding === 'go');
    await setting('bindings', { go: { tool: ['node', FAKE_LAB] } }, W, x => x.indexers[0]?.layout.bindings.find(b => b.name === 'go')!.tool[1] === FAKE_LAB);
    const asked: unknown[] = [];
    a.testing.ui = { askLab: async (_have, missing) => { asked.push(missing); return undefined; }, confirmLab: async () => false, confirmStop: async () => true };
    // The fake program's run sleeps until it is killed (a lab run still working), so a run that starts is cancelled once it has.
    const run = async (starts: boolean) => {
      await a.ready;
      await within(10_000, () => !!a.testing.controller.items.get(SUITE));
      a.testing.results.clear();
      const source = new vscode.CancellationTokenSource();
      const done = Promise.resolve(a.testing.runProfile.runHandler(new vscode.TestRunRequest([a.testing.controller.items.get(SUITE)!]), source.token));
      if (starts) {
        await within(30_000, () => a.testing.running.has(SUITE));
        source.cancel();
      }
      await done;
      return a.testing.results.get(`${SUITE}::reads-the-stock`);
    };

    fs.writeFileSync(at(...CONFIG.split('/')).fsPath, 'suites: [ "*.yml" ]\nschemaRoot: ../../schema\nofflineActions: [ "core.*", "wait", "inventory.*" ]\n');
    await run(true);
    assert.deepStrictEqual(asked, [], 'an offline suite asks for no lab value, and its run starts');
    assert.ok(a.log.some(l => l.includes(`offline actions from ${path.join(...CONFIG.split('/'))}`)), a.log.slice(-5).join(' | '));

    fs.rmSync(at(...CONFIG.split('/')).fsPath);
    const lab = await run(false);
    assert.ok(asked.length === 1, `without the config the suite is a lab suite, so the run asks: ${JSON.stringify(asked)}`);
    assert.deepStrictEqual(lab, { state: 'skipped', message: 'not run: the lab values were not given' });
  });
});
