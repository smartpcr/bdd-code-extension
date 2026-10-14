// session: oscontext
// E-B4 / B1.5: a registration site shows, and lists, the steps that use it.
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
    const goUri = at('test', 'e2e', 'bindings', 'go', 'internal', 'lifecycle', 'actions.go');
    const goDoc = await open(goUri);
    const goPos = find(goDoc, '"lifecycle.get":', 2);
    const fromGo = await refs(goUri, goPos);

    const catalog = await open(at('test', 'e2e', 'schema', 'actions.catalog.yaml'));
    const fromCatalog = await refs(catalog.uri, find(catalog, '- name: lifecycle.get', 10));

    const suite = await open(at('test', 'e2e', 'suites', 'lifecycle-stage0.yml'));
    const fromStep = await refs(suite.uri, find(suite, 'action: lifecycle.get', 10));

    const oracle = oracleSuiteFiles(folder()).flatMap(f => oracleSteps(f))
      .filter(s => s.action === 'lifecycle.get').map(s => `${key(s.file)}:${s.line}`).sort();

    assert.ok(oracle.length > 0);
    assert.deepStrictEqual(fromGo, oracle);
    assert.deepStrictEqual(fromCatalog, oracle);
    assert.deepStrictEqual(fromStep, oracle);

    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', goUri, 100);
    const lens = lenses.find(l => l.range.start.line === goPos.line && l.command?.title.includes('suite step'));
    assert.ok(lens, 'a lens on the lifecycle.get registration line');
    assert.strictEqual(lens!.command!.title, `${oracle.length} suite step${oracle.length === 1 ? '' : 's'}`);
    assert.strictEqual(lens!.command!.command, 'editor.action.showReferences');
    console.log(`    lifecycle.get: ${oracle.length} steps; lens "${lens!.command!.title}"`);
  });

  it('B1.5-3 steps inside meta step definitions and libraries are included', async () => {
    const a = await api();
    const index = a.indexers[0].index;
    const select = index.stepsUsing('lifecycle.select');
    assert.ok(select.some(s => s.home.kind === 'meta' && key(s.file).includes(key(path.join('suites', '_lib')))),
      'lifecycle.select is used inside the select-lab meta step of _lib/lifecycle.yml');
  });

  it('references on a meta definition list its uses across files', async () => {
    const lib = await open(at('test', 'e2e', 'suites', '_lib', 'lifecycle.yml'));
    const pos = find(lib, 'name: select-lab', 7);
    const uses = await refs(lib.uri, pos);
    const stage0 = key(at('test', 'e2e', 'suites', 'lifecycle-stage0.yml'));
    assert.ok(uses.some(u => u.startsWith(stage0)), uses.join('\n'));
  });

  it('a registration line for an action no suite uses says so', async () => {
    const a = await api();
    const index = a.indexers[0].index;
    const unused = index.allSites().find(s => index.stepsUsing(s.action).length === 0);
    assert.ok(unused, 'some registered action is used by no suite in this checkout');
    await open(vscode.Uri.file(unused!.file));
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider',
      vscode.Uri.file(unused!.file), 200);
    assert.ok(lenses.some(l => l.range.start.line === unused!.range.start.line && l.command?.title === 'no suite steps'));
  });
});
