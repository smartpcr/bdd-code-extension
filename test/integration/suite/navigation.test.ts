// session: sample
// B1.3-1 in the real host, and E-B3, on the sample workspace: inventory.get is
// implemented by all five bindings, shop.state by PowerShell only, and wait is
// a core action the catalog imports from spec/core.catalog.yaml (DEC-S10).
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { oracleSteps, oracleSuiteFiles } from '../harness/oracle';
import { api, asLocations, at, find, folder, key, lineText, open } from './helpers';

async function definitions(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.Location[]> {
  return asLocations(await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider', uri, pos));
}

/** "<file key>|<line text>" per location; VS Code orders merged results by document, so tests match as a set. */
async function described(locs: vscode.Location[]): Promise<string[]> {
  return Promise.all(locs.map(async l => `${key(l.uri)}|${await lineText(l)}`));
}

function expectEach(found: string[], expected: [string, string][]): void {
  for (const [file, text] of expected) {
    const hits = found.filter(f => f.split('|')[0].includes(key(file)) && f.includes(text));
    assert.strictEqual(hits.length, 1, `${file} / ${text}\n${found.join('\n')}`);
  }
}

describe('B1.3 the suite index in a real VS Code', () => {
  it('B1.3-1 the initial scan indexes exactly the oracle suite files and their action steps', async () => {
    const a = await api();
    const index = a.indexers[0].index;
    const mine = index.suiteFiles().map(s => key(s.file)).sort();
    const oracleFiles = oracleSuiteFiles(folder());
    assert.deepStrictEqual(mine, oracleFiles.map(key).sort());
    let steps = 0;
    for (const f of oracleFiles) {
      const want = oracleSteps(f).map(s => `${s.line}:${s.action}`).sort();
      const got = index.suite(f)!.steps.filter(s => s.action).map(s => `${s.actionRange!.start.line}:${s.action}`).sort();
      assert.deepStrictEqual(got, want, f);
      steps += got.length;
    }
    console.log(`    ${mine.length} files, ${steps} action steps agree with the oracle`);
  });
});

describe('E-B3 Go to Definition on an action', () => {
  // F12 and Ctrl+click land on each binding's handler where it is declared, else on its registration
  // (PowerShell's inline script block); Ctrl+F12 lists the registrations.
  it('inventory.get: the catalog entry and each of the five bindings\' handler, or its registration when the handler is inline', async () => {
    const doc = await open(at('test', 'e2e', 'suites', '_lib', 'shop.yml'));
    const pos = find(doc, 'action: inventory.get', 10);
    const locs = await definitions(doc.uri, pos);
    const found = await described(locs);
    const expected: [string, string][] = [
      [path.join('test', 'e2e', 'schema', 'actions.catalog.yaml'), '- name: inventory.get'],
      [path.join('scripts', 'e2e', 'actions', 'Shop.ps1'), "Register-SuiteAction -Name 'inventory.get'"],
      [path.join('dotnet', 'Suite.Cli', 'Actions.cs'), 'private static object? InventoryGet(ActionRequest request)'],
      [path.join('go', 'actions', 'actions.go'), 'func inventoryGet(request *actions.Request)'],
      [path.join('rust', 'src', 'actions.rs'), 'fn inventory_get(request: &Request)'],
      [path.join('typescript', 'src', 'actions.ts'), 'async function inventoryGet(request: Request)'],
    ];
    assert.strictEqual(locs.length, expected.length, found.join('\n'));
    expectEach(found, expected);
    const registrations = await described(asLocations(await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeImplementationProvider', doc.uri, pos)));
    // Ctrl+F12 lists each binding's registration line.
    expectEach(registrations, [
      ['Shop.ps1', "Register-SuiteAction -Name 'inventory.get'"],
      ['Actions.cs', 'new ActionRegistration("inventory.get", InventoryGet)'],
      ['actions.go', '{Name: "inventory.get", Handler: inventoryGet}'],
      ['actions.rs', 'Action::new("inventory.get", inventory_get)'],
      ['actions.ts', "action('inventory.get', inventoryGet)"],
    ]);
  });

  it('shop.state: exactly the catalog entry and PowerShell', async () => {
    const doc = await open(at('test', 'e2e', 'suites', 'smoke.yml'));
    const found = await described(await definitions(doc.uri, find(doc, 'action: shop.state', 10)));
    assert.strictEqual(found.length, 2, found.join('\n'));
    expectEach(found, [
      ['actions.catalog.yaml', '- name: shop.state'],
      [path.join('scripts', 'e2e', 'actions', 'Shop.ps1'), "Register-SuiteAction -Name 'shop.state'"],
    ]);
  });

  // wait is a core action: its entry is in the catalog the sample imports (spec/core.catalog.yaml,
  // DEC-S10), and every runtime registers it in the runtime's own code, outside the workspace's
  // binding sources. The extension indexes only the workspace's sources, so F12 lands on the
  // imported entry alone and Ctrl+F12 lists no registration.
  it('wait: exactly the entry in the imported core catalog; no workspace registration', async () => {
    const doc = await open(at('test', 'e2e', 'suites', 'waiting.yml'));
    const pos = find(doc, 'action: wait', 10);
    const found = await described(await definitions(doc.uri, pos));
    const core = path.resolve(folder(), '..', '..', 'spec', 'core.catalog.yaml');
    assert.deepStrictEqual(found, [`${key(core)}|  - name: wait`]);
    const registrations = asLocations(await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeImplementationProvider', doc.uri, pos));
    assert.deepStrictEqual(registrations, []);
  });

  it('E-B3 meta half: meta: check-stock in checkout.yml resolves to _lib/shop.yml', async () => {
    const doc = await open(at('test', 'e2e', 'suites', 'checkout.yml'));
    const locs = await definitions(doc.uri, find(doc, 'meta: check-stock', 7));
    assert.strictEqual(locs.length, 1);
    assert.ok(key(locs[0].uri).endsWith(key(path.join('suites', '_lib', 'shop.yml'))));
    assert.ok((await lineText(locs[0])).includes('check-stock'));
  });

  it('a position that is not an action or a meta use has no definition from this extension', async () => {
    const doc = await open(at('test', 'e2e', 'suites', 'smoke.yml'));
    const locs = await definitions(doc.uri, new vscode.Position(0, 0));
    assert.strictEqual(locs.length, 0);
  });
});
