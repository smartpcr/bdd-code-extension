// session: oscontext
// E-B7 clean-tree and program halves (B4.1, B4.2-1, B4.3) on the real checkout.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import * as vscode from 'vscode';
import { CoverageRow } from '../../../src/core/coverage';
import { CoverageNode } from '../../../src/features/coverageView';
import { api, folder, within } from './helpers';
import { setting } from './lintHelpers';

const G = vscode.ConfigurationTarget.Global;

/** Declared actions per binding, read independently of the extension. */
function declaredFromCatalog(): Map<string, string[]> {
  const cat = parse(fs.readFileSync(path.join(folder(), 'test/e2e/schema/actions.catalog.yaml'), 'utf8'));
  const out = new Map<string, string[]>();
  for (const b of cat.bindings as string[]) {
    out.set(b, (cat.actions as { name: string; bindings: string[] }[]).filter(a => a.bindings.includes(b)).map(a => a.name).sort());
  }
  return out;
}

describe('E-B7 the binding table matches the catalog and the programs', () => {
  it('B4.1-1 / B4.2-1 clean tree: the view\'s rows, Declared from the catalog, Found equals Declared, no drift', async () => {
    const a = await api();
    const declared = declaredFromCatalog();
    const roots = a.coverage.getChildren() as Extract<CoverageNode, { kind: 'row' }>[];
    assert.deepStrictEqual(roots.map(r => r.row.binding), [...declared.keys()]);
    assert.deepStrictEqual(roots.map(r => r.row), a.coverage.rows());
    for (const { row } of roots) {
      assert.deepStrictEqual(row.declared, declared.get(row.binding), row.binding);
      assert.deepStrictEqual(row.found, row.declared, row.binding);
      assert.deepStrictEqual([row.declaredNotFound, row.foundNotDeclared, row.duplicates], [[], [], []], row.binding);
      const item = a.coverage.getTreeItem({ kind: 'row', row });
      assert.strictEqual(item.label, `${row.label}  ${row.declared.length} declared, ${row.found.length} found, 0 drift`);
      assert.deepStrictEqual(a.coverage.getChildren({ kind: 'row', row }).map(n => n.kind === 'item' && n.label), ['no drift']);
    }
    console.log(`    ${roots.map(r => `${r.row.label} ${r.row.declared.length}/${r.row.found.length}`).join(', ')}`);
  });

  it('Copy binding table puts the Markdown table on the clipboard', async () => {
    const text = await vscode.commands.executeCommand<string>('bddSuite.copyBindingTable');
    // The system clipboard is shared with every program on the machine; another one holding it reads as ''.
    await within(2000, async () => (await vscode.env.clipboard.readText()) === text);
    assert.match(text, /^\| Binding \| Source \| Declared \| Found \| Drift \|/);
    assert.match(text, /\| PowerShell \| `scripts\/e2e\/actions\/` \| 100 \| 100 \| 0 \|/);
  });

  it('B4.3-1 every program\'s actions --json equals the catalog\'s set for its binding, and Found', async function () {
    this.timeout(120_000);
    const rows = await vscode.commands.executeCommand<CoverageRow[]>('bddSuite.verifyBindingPrograms');
    const declared = declaredFromCatalog();
    for (const r of rows) {
      const p = r.program;
      assert.ok(p?.ok, `${r.binding}: ${p && !p.ok ? p.failure : 'not run'}`);
      assert.deepStrictEqual(p.names, declared.get(r.binding), r.binding);
      assert.deepStrictEqual(p.names, r.found, r.binding);
    }
    const a = await api();
    const item = a.coverage.getTreeItem({ kind: 'row', row: a.coverage.rows()[0] });
    assert.match(String(item.description), /program agrees/);
    console.log(`    programs agree: ${rows.map(r => `${r.label} ${r.program?.ok ? r.program.names.length : 'failed'}`).join(', ')}`);
  });

  it('B4.3-2 a program that fails shows on its row and does not affect the others', async function () {
    this.timeout(120_000);
    const missing = path.join(folder(), 'no-such', 'suiterun.exe');
    try {
      await setting('bindings', { csharp: { tool: [missing] } }, G,
        x => x.indexers[0]?.layout.bindings.find(b => b.name === 'csharp')!.tool[0] === missing);
      const a = await api();
      const rows = await a.coverage.verify();
      const cs = rows.find(r => r.binding === 'csharp')!;
      assert.ok(cs.program && !cs.program.ok && /not-found/.test(cs.program.failure), JSON.stringify(cs.program));
      for (const r of rows.filter(x => x.binding !== 'csharp')) assert.ok(r.program?.ok, r.binding);
      const children = a.coverage.getChildren({ kind: 'row', row: cs });
      assert.ok(children.some(n => n.kind === 'item' && n.label === 'program' && /failed: not-found/.test(n.description ?? '')));
    } finally {
      await setting('bindings', undefined, G, x => /net10\.0/.test(x.indexers[0]?.layout.bindings.find(b => b.name === 'csharp')!.tool[0] ?? ''));
    }
    await within(5000, async () => (await api()).coverage.rows().length > 0);
  });
});
