// session: sample
// E-B7 clean-tree and program halves (B4.1, B4.2-1, B4.3) on the sample
// workspace. The sample's one deliberate drift is report.export: declared for
// csharp, registered by no binding. The core actions (core.*, wait) come from
// the imported spec/core.catalog.yaml (DEC-S10) and are registered by the
// runtimes themselves, outside the workspace's sources, so they are not rows'
// Declared, Found or drift.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import * as vscode from 'vscode';
import { CoverageRow } from '../../../src/core/coverage';
import { CoverageNode } from '../../../src/features/coverageView';
import { api, at, folder, open, within } from './helpers';
import { setting } from './lintHelpers';

const G = vscode.ConfigurationTarget.Global;
/** Declared in the catalog and registered by no binding, on purpose (samples/workspace/README.md). */
const DRIFT = { binding: 'csharp', action: 'report.export' };

/** The workspace catalog's own actions per binding, read independently of the extension. */
function declaredFromCatalog(): Map<string, string[]> {
  const cat = parse(fs.readFileSync(path.join(folder(), 'test/e2e/schema/actions.catalog.yaml'), 'utf8'));
  const out = new Map<string, string[]>();
  for (const b of cat.bindings as string[]) {
    out.set(b, (cat.actions as { name: string; bindings: string[] }[]).filter(a => a.bindings.includes(b)).map(a => a.name).sort());
  }
  return out;
}

/** What each binding registers: its declared actions, but report.export nowhere. */
const registeredFor = (declared: Map<string, string[]>, binding: string): string[] =>
  declared.get(binding)!.filter(a => !(binding === DRIFT.binding && a === DRIFT.action));

describe('E-B7 the binding table matches the catalog and the programs', () => {
  it('B4.1-1 / B4.2-1 clean tree: the view\'s rows, Declared from the catalog, Found from the sources, exactly the one known drift', async () => {
    const a = await api();
    const declared = declaredFromCatalog();
    const roots = a.coverage.getChildren() as Extract<CoverageNode, { kind: 'row' }>[];
    assert.deepStrictEqual(roots.map(r => r.row.binding), [...declared.keys()]);
    assert.deepStrictEqual(roots.map(r => r.row), a.coverage.rows());
    for (const { row } of roots) {
      assert.deepStrictEqual(row.declared, declared.get(row.binding), row.binding);
      assert.deepStrictEqual(row.found, registeredFor(declared, row.binding), row.binding);
      const drift = row.binding === DRIFT.binding ? [DRIFT.action] : [];
      assert.deepStrictEqual([row.declaredNotFound, row.foundNotDeclared, row.duplicates], [drift, [], []], row.binding);
      const item = a.coverage.getTreeItem({ kind: 'row', row });
      assert.strictEqual(item.label, `${row.label}  ${row.declared.length} declared, ${row.found.length} found, ${drift.length} drift`);
      const children = a.coverage.getChildren({ kind: 'row', row }).map(n => n.kind === 'item' && [n.label, n.description]);
      if (drift.length) assert.deepStrictEqual(children, [[DRIFT.action, 'declared, not registered']]);
      else assert.deepStrictEqual(children, [['no drift', undefined]]);
    }
    console.log(`    ${roots.map(r => `${r.row.label} ${r.row.declared.length}/${r.row.found.length}`).join(', ')}`);
  });

  it('Copy binding table puts the Markdown table on the clipboard', async () => {
    const declared = declaredFromCatalog();
    // The system clipboard is shared with every program on the machine: another one holding it, or writing
    // to it, makes one copy read back as something else. The command is asked again until a copy lands.
    let text = '';
    let read = '';
    try {
      await within(20_000, async () => {
        text = await vscode.commands.executeCommand<string>('bddSuite.copyBindingTable');
        for (let i = 0; i < 10; i++) {
          read = await vscode.env.clipboard.readText();
          if (read === text) return true;
          await new Promise(r => setTimeout(r, 100));
        }
        return false;
      });
    } catch (e) {
      assert.fail(`${(e as Error).message}: the clipboard held ${JSON.stringify(read.slice(0, 300))}; the command returned ${JSON.stringify(text.slice(0, 300))}`);
    }
    assert.match(text, /^\| Binding \| Source \| Declared \| Found \| Drift \|/);
    const ps = declared.get('powershell')!.length;
    const cs = declared.get('csharp')!.length;
    assert.ok(text.includes(`| PowerShell | \`scripts/e2e/actions/\` | ${ps} | ${ps} | 0 |`), text);
    assert.ok(text.includes(`| C# | \`test/e2e/bindings/dotnet/\` | ${cs} | ${cs - 1} | 1 |`), text);
  });

  it('an imported core action is never offered for implementing: no "Not implemented" lens, no Implement action', async () => {
    await (await api()).ready;
    const doc = await open(at('test', 'e2e', 'suites', 'smoke.yml'));
    const line = [...Array(doc.lineCount).keys()].find(i => doc.lineAt(i).text.includes('action: core.noop')) ?? -1;
    assert.ok(line >= 0, 'smoke.yml uses core.noop');
    const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri, 100)) ?? [];
    assert.deepStrictEqual(lenses.filter(l => l.range.start.line === line).map(l => l.command?.title), [], 'core.noop is implemented by every runtime');
    const col = doc.lineAt(line).text.indexOf('core.noop');
    const actions = (await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(line, col, line, col))) ?? [];
    assert.deepStrictEqual(actions.filter(a => a.title.startsWith('Implement')).map(a => a.title), []);
  });

  it('B4.3-1 every program\'s actions --json, less the imported core, is the catalog\'s set for its binding (report.export aside), and Found', async function () {
    this.timeout(120_000);
    const rows = await vscode.commands.executeCommand<CoverageRow[]>('bddSuite.verifyBindingPrograms');
    const declared = declaredFromCatalog();
    for (const r of rows) {
      const p = r.program;
      assert.ok(p?.ok, `${r.binding}: ${p && !p.ok ? p.failure : 'not run'}`);
      assert.deepStrictEqual(p.names, registeredFor(declared, r.binding), r.binding);
      assert.deepStrictEqual(p.names, r.found, r.binding);
      assert.deepStrictEqual([p.programOnly, p.notInSource, p.sourceOnly], [[], [], []], r.binding);
      assert.deepStrictEqual(p.programMissing, r.binding === DRIFT.binding ? [DRIFT.action] : [], r.binding);
    }
    const a = await api();
    const item = (b: string) => a.coverage.getTreeItem({ kind: 'row', row: a.coverage.rows().find(r => r.binding === b)! });
    for (const b of rows.map(r => r.binding)) assert.match(String(item(b).description), b === DRIFT.binding ? /program differs/ : /program agrees/, b);
    const cs = a.coverage.getChildren({ kind: 'row', row: a.coverage.rows().find(r => r.binding === DRIFT.binding)! });
    assert.ok(cs.some(n => n.kind === 'item' && n.label === DRIFT.action && n.description === 'declared, program lacks it'));
    console.log(`    programs: ${rows.map(r => `${r.label} ${r.program?.ok ? r.program.names.length : 'failed'}`).join(', ')}`);
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
