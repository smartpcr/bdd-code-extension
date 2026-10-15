// session: oscontext
// B1.3-1 in the real host, and E-B3. The TypeScript locations (B7.5, B7.7)
// are expected when the checkout carries the TypeScript binding.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { oracleSteps, oracleSuiteFiles } from '../harness/oracle';
import { api, asLocations, at, find, folder, hasTypeScript, key, lineText, open } from './helpers';

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
  it('lifecycle.get: the catalog entry and one registration in each binding', async () => {
    const doc = await open(at('test', 'e2e', 'suites', 'lifecycle-stage0.yml'));
    const locs = await definitions(doc.uri, find(doc, 'action: lifecycle.get', 10));
    const found = await described(locs);
    const expected: [string, string][] = [
      [path.join('test', 'e2e', 'schema', 'actions.catalog.yaml'), '- name: lifecycle.get'],
      [path.join('scripts', 'e2e', 'actions'), "Register-LabAction -Name 'lifecycle.get'"],
      [path.join('Actions', 'Lifecycle', 'LifecycleActions.cs'), '["lifecycle.get"] ='],
      [path.join('go', 'internal', 'lifecycle', 'actions.go'), '"lifecycle.get":'],
      [path.join('rust', 'src', 'lifecycle', 'actions.rs'), '"lifecycle.get" =>'],
    ];
    if (hasTypeScript()) expected.push([path.join('typescript', 'src', 'lifecycle', 'actions.ts'), "action('lifecycle.get', lifecycleGet)"]);
    assert.strictEqual(locs.length, expected.length, found.join('\n'));
    expectEach(found, expected);
  });

  it('cluster.state: exactly the catalog entry and PowerShell', async () => {
    const doc = await open(at('test', 'e2e', 'suites', 'smoke.yml'));
    const found = await described(await definitions(doc.uri, find(doc, 'action: cluster.state', 10)));
    assert.strictEqual(found.length, 2, found.join('\n'));
    expectEach(found, [
      ['actions.catalog.yaml', '- name: cluster.state'],
      [path.join('scripts', 'e2e', 'actions'), "Register-LabAction -Name 'cluster.state'"],
    ]);
  });

  it('wait: the catalog, Wait.ps1, and the wait lines in Go exec.go, Rust actions.rs and C# Executor.cs', async () => {
    const doc = await open(at('test', 'e2e', 'suites', 'lifecycle-stage2.yml'));
    const found = await described(await definitions(doc.uri, find(doc, 'action: wait', 10)));
    const expected: [string, string][] = [
      ['actions.catalog.yaml', '- name: wait'],
      ['Wait.ps1', "Register-LabAction -Name 'wait'"],
      ['Executor.cs', 'names.Add("wait")'],
      ['exec.go', 'append(names, "wait")'],
      ['actions.rs', 'names.push("wait"'],
    ];
    if (hasTypeScript()) expected.push([path.join('typescript', 'src', 'actions', 'core.ts'), "action('wait', wait)"]);
    assert.strictEqual(found.length, expected.length, found.join('\n'));
    expectEach(found, expected);
  });

  it('E-B3 meta half: meta: select-lab in stage 0 resolves to _lib/lifecycle.yml', async () => {
    const doc = await open(at('test', 'e2e', 'suites', 'lifecycle-stage0.yml'));
    const locs = await definitions(doc.uri, find(doc, 'meta: select-lab', 7));
    assert.strictEqual(locs.length, 1);
    assert.ok(key(locs[0].uri).endsWith(key(path.join('suites', '_lib', 'lifecycle.yml'))));
    assert.ok((await lineText(locs[0])).includes('select-lab'));
  });

  it('a position that is not an action or a meta use has no definition from this extension', async () => {
    const doc = await open(at('test', 'e2e', 'suites', 'smoke.yml'));
    const locs = await definitions(doc.uri, new vscode.Position(0, 0));
    assert.strictEqual(locs.length, 0);
  });
});
