// session: consumer
// docs/packages, E9: the extension alone serves a C#-only workspace. No
// TypeScript binding, no copy of the spec, default settings: bdd-suite:core is
// the core the extension carries, a misspelled action is underlined by the
// bundled runtime, and the schema regenerates through the bundled generator.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { api, at, within } from './helpers';
import { nextLint, shown } from './lintHelpers';

describe('E9 (packages) a C#-only consumer with default settings', () => {
  const suite = at('test', 'e2e', 'suites', 'greeting.yml');

  after(async () => {
    // Cleanup: the edit is reverted, never saved.
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  it('indexes bdd-suite:core as the bundled core, cut to the catalog\'s bindings, and warns of no other release', async () => {
    const a = await api();
    await a.ready;
    assert.strictEqual(a.indexers.length, 1);
    const catalog = a.indexers[0]!.index.catalog!;
    assert.deepStrictEqual(catalog.errors, []);
    const wait = catalog.actions.get('wait')!;
    const ext = vscode.extensions.getExtension('asz.bdd-suite')!;
    assert.strictEqual(path.resolve(wait.file!).toLowerCase(), path.join(ext.extensionPath, 'spec', 'core.catalog.yaml').toLowerCase());
    assert.deepStrictEqual(wait.bindings, ['csharp']);
    assert.deepStrictEqual(catalog.bindings, ['csharp']);
    assert.ok(!a.log.some(l => l.startsWith('BDD026')), a.log.join('\n'));
  });

  it('underlines a misspelled action through the bundled runtime, with no word of a missing TypeScript binding', async () => {
    const a = await api();
    const doc = await vscode.workspace.openTextDocument(suite);
    const editor = await vscode.window.showTextDocument(doc);
    const offset = doc.getText().indexOf('action: greet.say') + 'action: '.length;
    const published = nextLint(suite.fsPath, 30_000, e => e.outcome === 'published' && !!e.live);
    await editor.edit(b => b.replace(new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + 'greet.say'.length)), 'greet.sya'));
    const started = Date.now();
    await published;
    const found = shown(suite);
    const misspelled = found.find(d => d.message.includes('greet.sya'));
    assert.ok(misspelled, JSON.stringify(found));
    assert.strictEqual(misspelled.source, 'suiterun:typescript');
    assert.match(misspelled.message, /greet\.say/, 'the nearest spelling is offered');
    assert.strictEqual(a.status.text, 'Suite: lint bundled runtime (no binding check)');
    const words = [...a.log, a.status.text, ...found.map(d => d.message)].join('\n');
    assert.doesNotMatch(words, /not built|did not load|no library/i);
    console.log(`      underlined ${Date.now() - started} ms after the edit`);
  });

  it('regenerates the schema through the bundled Build-Schema.ps1', async () => {
    const schema = at('test', 'e2e', 'schema', 'suite.schema.json').fsPath;
    const before = fs.readFileSync(schema, 'utf8').replace(/\r\n/g, '\n');
    fs.rmSync(schema);
    const result = await vscode.commands.executeCommand<{ ok: boolean; message: string }>('bddSuite.regenerateSchema', suite);
    assert.ok(result.ok, result.message);
    await within(10_000, () => fs.existsSync(schema));
    assert.strictEqual(fs.readFileSync(schema, 'utf8').replace(/\r\n/g, '\n'), before, 'the committed schema, generated again');
    const a = await api();
    assert.ok(a.indexers[0]!.layout.schemaGenerator.some(arg => arg.endsWith(path.join('spec', 'Build-Schema.ps1')) || arg.endsWith('spec/Build-Schema.ps1')),
      a.indexers[0]!.layout.schemaGenerator.join(' '));
  });
});
