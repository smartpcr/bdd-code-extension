// session: worktree
// E-B5 (B3.1-B3.5), the completion-order assertion of E-B2 (B3.1) and the
// capture-path hover (B3.4), on a scratch suite in a disposable worktree.
import * as assert from 'assert';
import * as fs from 'fs';
import { parse } from 'yaml';
import * as vscode from 'vscode';
import { api, at, hoverText, open, within } from './helpers';
import { setting } from './lintHelpers';

const W = vscode.ConfigurationTarget.Workspace;
const SCRATCH = `suite: scratch-b5
imports:
  - _lib/lifecycle.yml
params:
  - { name: node, type: string }
vars:
  limit: 3
setup:
  - action: core.set
    value: 1
    captureAs: agent
tests:
  - name: first
    steps:
      - action: cluster.state
        captureAs: cs
      - action: core.noop
        note: ROOT:\${}
        a: CAP:\${capture.}
        b: CS:\${capture.cs.}
        c: PARAM:\${param.}
        d: HOVER:\${capture.cs.Nodes}
      - action: core.noop
        captureAs: later
      - action: cluster.state
        target: ROWT:\${row.}
        rootT: RT:\${}
        table:
          - { node: N1, drain: true }
      - meta:
      - meta: select-lab
        with:
          la
      - action:
  - name: second
    examples:
      - { node: a, mode: b }
    steps:
      - action: core.noop
        x: ROWE:\${}
        y: CAP2:\${capture.}
`;

type Item = vscode.CompletionItem;
const label = (i: Item) => (typeof i.label === 'string' ? i.label : i.label.label);

async function complete(uri: vscode.Uri, pos: vscode.Position): Promise<Item[]> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, pos);
  return list.items;
}

describe('E-B5 completion offers what is in scope, and nothing the format forbids', () => {
  let uri: vscode.Uri;
  let doc: vscode.TextDocument;
  let catalogActions: string[];
  const posAfter = (marker: string) => {
    const text = doc.getText();
    const i = text.indexOf(marker);
    assert.ok(i >= 0, marker);
    return doc.positionAt(i + marker.length);
  };
  const emptyActionPos = () => {
    const lines = doc.getText().split(/\r?\n/);
    const line = lines.findIndex(l => /^\s+- action:\s*$/.test(l));
    assert.ok(line > 0, 'the empty action line');
    return new vscode.Position(line, lines[line].length);
  };
  const labels = async (marker: string, kinds?: vscode.CompletionItemKind[]) =>
    (await complete(uri, posAfter(marker))).filter(i => !kinds || kinds.includes(i.kind!)).map(label);

  before(async () => {
    const a = await api();
    uri = at('test', 'e2e', 'suites', '_scratch-b5.yml');
    fs.writeFileSync(uri.fsPath, SCRATCH);
    await within(5000, () => a.indexers[0].index.isSuiteOrLibrary(uri.fsPath));
    doc = await open(uri);
    catalogActions = [...a.indexers[0].index.catalog!.actions.keys()];
  });

  it('after ${: namespaces, context keys and the 21 functions; row only where a table or examples applies', async () => {
    const got = await labels('ROOT:${');
    for (const n of ['capture', 'param', 'var', 'cluster', 'target', 'timeoutSec', 'labId', 'apiUrl', 'defaults',
      'lower', 'upper', 'trim', 'replace', 'format', 'split', 'join', 'startsWith', 'endsWith', 'contains', 'len',
      'first', 'last', 'int', 'float', 'str', 'bool', 'default', 'env', 'uuid', 'nowIso']) assert.ok(got.includes(n), n);
    assert.ok(!got.includes('row'), 'no row outside a table or examples');
    assert.ok((await labels('RT:${')).includes('row'), 'row in a table step');
    assert.ok((await labels('ROWE:${')).includes('row'), 'row in an outline case');
  });

  it('B3.3-1/2 after ${capture. in the second step: agent and cs, never a later step or another case', async () => {
    assert.deepStrictEqual((await labels('CAP:${capture.', [vscode.CompletionItemKind.Field])).sort(), ['agent', 'cs']);
    assert.deepStrictEqual(await labels('CAP2:${capture.', [vscode.CompletionItemKind.Field]), ['agent']);
  });

  it('B3.4-1 after ${capture.cs.: exactly the cluster.state capture properties', async () => {
    const a = await api();
    const want = [...a.indexers[0].index.catalog!.actions.get('cluster.state')!.captures.properties.keys()].sort();
    assert.ok(want.length > 0);
    assert.deepStrictEqual((await labels('CS:${capture.cs.', [vscode.CompletionItemKind.Property])).sort(), want);
  });

  it('after ${param.: node and the parameters _lib/lifecycle.yml declares', async () => {
    const lib = parse(fs.readFileSync(at('test', 'e2e', 'suites', '_lib', 'lifecycle.yml').fsPath, 'utf8'));
    const want = ['node', ...(lib.params ?? []).map((p: { name: string }) => p.name)].sort();
    assert.deepStrictEqual((await labels('PARAM:${param.', [vscode.CompletionItemKind.Variable])).sort(), want);
  });

  it('after ${row. in the table step: the two column names', async () => {
    assert.deepStrictEqual((await labels('ROWT:${row.', [vscode.CompletionItemKind.Variable])).sort(), ['drain', 'node']);
  });

  it('B3.5 after meta: the visible meta steps; inside its with:, that meta step\'s parameters', async () => {
    const lib = parse(fs.readFileSync(at('test', 'e2e', 'suites', '_lib', 'lifecycle.yml').fsPath, 'utf8'));
    const metas = (lib.metaSteps ?? []) as { name: string; params?: { name: string }[] }[];
    // The YAML extension adds its own key suggestions here; the extension's items name the defining file.
    const mine = (await complete(uri, posAfter('      - meta: ')))
      .filter(i => i.kind === vscode.CompletionItemKind.Module && /\.yml$/.test(i.detail ?? '')).map(label);
    assert.deepStrictEqual(mine.sort(), metas.map(m => m.name).sort());
    const selectLab = metas.find(m => m.name === 'select-lab')!;
    const withLine = doc.getText().split(/\r?\n/).findIndex(l => l.trim() === 'with:') + 1;
    const keys = (await complete(uri, new vscode.Position(withLine, 12)))
      .filter(i => i.detail === 'required' || i.detail === 'optional').map(label);
    assert.deepStrictEqual(keys.sort(), (selectLab.params ?? []).map(p => p.name).sort());
  });

  it('B3.1-1 after action: every catalog action exactly once; what the YAML extension adds is recorded', async () => {
    const items = await complete(uri, emptyActionPos());
    const got = items.map(label);
    for (const name of catalogActions) assert.strictEqual(got.filter(g => g === name).length, 1, name);
    const others = got.filter(g => !catalogActions.includes(g));
    console.log(`    ${catalogActions.length} actions offered once each; the YAML extension added ${others.length} other item(s)${others.length ? `: ${others.slice(0, 10).join(', ')}` : ''}`);
  });

  it('E-B2 completion order: with target rust, every rust action sorts before every other', async () => {
    const a = await setting('targetBinding', 'rust', W, x => x.indexers[0].layout.settings.targetBinding === 'rust');
    try {
      await within(5000, () => a.indexers[0].index.isSuiteOrLibrary(uri.fsPath));
      const items = (await complete(uri, emptyActionPos()))
        .filter(i => catalogActions.includes(label(i)));
      const sorted = [...items].sort((x, y) => (x.sortText ?? label(x)).localeCompare(y.sortText ?? label(y)));
      const catalog = a.indexers[0].index.catalog!;
      const rust = sorted.map(i => catalog.actions.get(label(i))!.bindings.includes('rust'));
      const firstOther = rust.indexOf(false);
      assert.ok(firstOther > 0, 'some actions are rust, some are not');
      assert.ok(rust.slice(firstOther).every(r => !r), 'no rust action after the first non-rust one');
      console.log(`    target rust: the first ${firstOther} of ${rust.length} actions are the ones rust implements`);
    } finally {
      await setting('targetBinding', undefined, W, x => x.indexers[0].layout.settings.targetBinding === 'powershell');
    }
  });

  it('B3.4 hover on ${capture.cs.Nodes} names the producing step and the declared type', async () => {
    const pos = posAfter('HOVER:${capture.cs.No');
    const text = await hoverText(uri, pos);
    assert.match(text, /`capture\.cs\.Nodes`/);
    assert.match(text, /Captured by `cluster\.state` at \[_scratch-b5\.yml:15\]/);
    assert.match(text, /Type: `array`/);
  });

  after(() => {
    fs.rmSync(at('test', 'e2e', 'suites', '_scratch-b5.yml').fsPath, { force: true });
  });
});
