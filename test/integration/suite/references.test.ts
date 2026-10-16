// session: sample
// E-B4 / B1.5: a registration site shows, and lists, the steps that use it.
// On the sample: inventory.get (used in suites, in a library's meta step and
// inside a wait's forStep) and audit.log (registered everywhere, used nowhere).
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { oracleSteps, oracleSuiteFiles } from '../harness/oracle';
import { api, at, find, folder, key, open } from './helpers';

const refs = async (uri: vscode.Uri, pos: vscode.Position): Promise<string[]> =>
  ((await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, pos)) ?? [])
    .filter(l => l.uri.fsPath.endsWith('.yml'))
    .map(l => `${key(l.uri)}:${l.range.start.line}`).sort();

describe('E-B4 references and CodeLens', () => {
  it('B1.5-1/2/3 the Go site, the catalog entry and a step give the same list; the lens counts it; the oracle agrees', async () => {
    await api();
    const goUri = at('test', 'e2e', 'bindings', 'go', 'actions', 'actions.go');
    const goDoc = await open(goUri);
    const goPos = find(goDoc, '"inventory.get"', 2);
    const fromGo = await refs(goUri, goPos);

    const catalog = await open(at('test', 'e2e', 'schema', 'actions.catalog.yaml'));
    const fromCatalog = await refs(catalog.uri, find(catalog, '- name: inventory.get', 10));

    const suite = await open(at('test', 'e2e', 'suites', '_lib', 'shop.yml'));
    const fromStep = await refs(suite.uri, find(suite, 'action: inventory.get', 10));

    const oracle = oracleSuiteFiles(folder()).flatMap(f => oracleSteps(f))
      .filter(s => s.action === 'inventory.get').map(s => `${key(s.file)}:${s.line}`).sort();

    // In large.yml, the library, a wait's forStep (waiting.yml) and the flawed files.
    assert.ok(oracle.length > 20, `${oracle.length}`);
    assert.ok(oracle.some(o => o.startsWith(key(at('test', 'e2e', 'suites', 'waiting.yml')))), 'the forStep use is counted');
    assert.deepStrictEqual(fromGo, oracle);
    assert.deepStrictEqual(fromCatalog, oracle);
    assert.deepStrictEqual(fromStep, oracle);

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', goUri, 100);
    const lens = lenses.find(l => l.range.start.line === goPos.line && l.command?.title.includes('suite step'));
    assert.ok(lens, 'a lens on the inventory.get registration line');
    assert.strictEqual(lens!.command!.title, `${oracle.length} suite step${oracle.length === 1 ? '' : 's'}`);
    assert.strictEqual(lens!.command!.command, 'editor.action.showReferences');
    console.log(`    inventory.get: ${oracle.length} steps; lens "${lens!.command!.title}"`);
  });

  it('B1.5-3 steps inside meta step definitions and libraries are included', async () => {
    const a = await api();
    const index = a.indexers[0].index;
    const uses = index.stepsUsing('inventory.get');
    assert.ok(uses.some(s => s.home.kind === 'meta' && key(s.file).includes(key(path.join('suites', '_lib')))),
      'inventory.get is used inside the check-stock meta step of _lib/shop.yml');
  });

  it('references on a meta definition list its uses across files', async () => {
    const lib = await open(at('test', 'e2e', 'suites', '_lib', 'shop.yml'));
    const pos = find(lib, 'name: check-stock', 7);
    const uses = await refs(lib.uri, pos);
    const checkout = key(at('test', 'e2e', 'suites', 'checkout.yml'));
    assert.strictEqual(uses.filter(u => u.startsWith(checkout)).length, 2, uses.join('\n'));
  });

  it('a registration line for an action no suite uses says so (audit.log)', async () => {
    const a = await api();
    const index = a.indexers[0].index;
    const unused = index.allSites().filter(s => index.stepsUsing(s.action).length === 0);
    // The oracle's answer: registered actions no step in any suite or library names. In the
    // sample that is audit.log (by design) and order.place, price.quote and stock.reserve.
    const used = new Set(oracleSuiteFiles(folder()).flatMap(f => oracleSteps(f)).map(s => s.action));
    const want = [...new Set(index.allSites().map(s => s.action))].filter(n => !used.has(n)).sort();
    assert.deepStrictEqual([...new Set(unused.map(s => s.action))].sort(), want);
    assert.ok(want.includes('audit.log'), want.join(', '));
    const go = unused.find(s => key(s.file).endsWith(key(path.join('go', 'actions', 'actions.go'))))!;
    assert.ok(go, unused.map(s => s.file).join('\n'));
    await open(vscode.Uri.file(go.file));
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider',
      vscode.Uri.file(go.file), 200);
    assert.ok(lenses.some(l => l.range.start.line === go.range.start.line && l.command?.title === 'no suite steps'));
  });
});
