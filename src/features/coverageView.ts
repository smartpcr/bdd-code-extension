// The Suite bindings view (plan B4.2, B4.3): the binding table, each row's
// drift, and what each binding's program says it implements.
import * as vscode from 'vscode';
import { TrustGate } from '../config/trust';
import {
  compareProgramSet, computeCoverage, CoverageRow, driftCount, ProgramCheck, programAgrees,
} from '../core/coverage';
import { parseActionsOutput } from '../core/diagnostics';
import { Range } from '../core/text';
import { MAX_STDERR_BYTES } from '../limits';
import { actionsCommand } from '../tools/profiles';
import { runTool } from '../tools/runTool';
import { FolderIndexer, toRange } from './indexer';

export type CoverageNode =
  | { kind: 'row'; row: CoverageRow }
  | { kind: 'item'; label: string; description?: string; file?: string; range?: Range; warning: boolean };

export class CoverageView implements vscode.TreeDataProvider<CoverageNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<CoverageNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly programs = new Map<string, ProgramCheck>();

  constructor(private readonly indexers: () => FolderIndexer[], private readonly gate: TrustGate) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  /** The table as the view shows it (B4.2-1: the view is this, nothing else). */
  rows(): CoverageRow[] {
    const ix = this.indexers()[0];
    const catalog = ix?.index.catalog;
    if (!ix || !catalog) return [];
    const rows = computeCoverage(catalog, ix.index.allSites(),
      ix.layout.bindings.map(b => ({ name: b.name, label: b.label, sources: b.sources })));
    for (const r of rows) {
      const p = this.programs.get(r.binding);
      if (p) r.program = p.ok ? compareProgramSet(r, p.names) : p;
    }
    return rows;
  }

  /** Ask each binding's program which actions it implements (B4.3). One failure never affects another row. */
  async verify(): Promise<CoverageRow[]> {
    const ix = this.indexers()[0];
    if (!ix) return [];
    const rows = this.rows();
    await Promise.all(rows.map(async r => {
      const binding = ix.layout.bindings.find(b => b.name === r.binding);
      if (!binding) {
        this.programs.set(r.binding, { ok: false, failure: 'no binding settings' });
        return;
      }
      const result = await runTool(actionsCommand(binding, ix.layout.root), undefined,
        { gate: () => this.gate.canRunWorkspaceCode(), maxStderr: MAX_STDERR_BYTES });
      if (result.kind !== 'exited' || result.code !== 0) {
        const why = result.kind === 'failure' ? `${result.reason}: ${result.detail}` : result.kind === 'exited' ? `exit code ${result.code}` : 'cancelled';
        this.programs.set(r.binding, { ok: false, failure: why });
        return;
      }
      const parsed = parseActionsOutput(result.stdout);
      this.programs.set(r.binding, parsed.ok
        ? { ok: true, names: parsed.value, programOnly: [], programMissing: [], notInSource: [], sourceOnly: [] }
        : { ok: false, failure: parsed.detail });
    }));
    this.refresh();
    return this.rows();
  }

  getTreeItem(node: CoverageNode): vscode.TreeItem {
    if (node.kind === 'row') {
      const r = node.row;
      const drift = driftCount(r);
      const item = new vscode.TreeItem(`${r.label}  ${r.declared.length} declared, ${r.found.length} found, ${drift} drift`,
        vscode.TreeItemCollapsibleState.Collapsed);
      const agrees = programAgrees(r.program);
      item.description = r.source + (agrees === undefined ? '' : agrees ? '  program agrees' : '  program differs');
      item.iconPath = new vscode.ThemeIcon(drift || agrees === false ? 'warning' : 'pass');
      item.contextValue = 'bindingRow';
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon(node.warning ? 'warning' : 'info');
    if (node.file && node.range) {
      item.command = {
        title: 'Open', command: 'vscode.open',
        arguments: [vscode.Uri.file(node.file), { selection: toRange(node.range) }],
      };
    }
    return item;
  }

  getChildren(node?: CoverageNode): CoverageNode[] {
    if (!node) return this.rows().map(row => ({ kind: 'row', row }));
    if (node.kind === 'item') return [];
    const r = node.row;
    const ix = this.indexers()[0]!;
    const catalog = ix.index.catalog!;
    const siteOf = (action: string) => ix.index.sitesFor(action).find(s => s.binding === r.binding);
    const out: CoverageNode[] = [];
    for (const a of r.declaredNotFound) {
      const entry = catalog.actions.get(a)!;
      out.push({ kind: 'item', label: a, description: 'declared, not registered', file: entry.file ?? catalog.file, range: entry.nameRange, warning: true });
    }
    for (const a of r.foundNotDeclared) {
      const s = siteOf(a)!;
      out.push({ kind: 'item', label: a, description: 'registered, not declared', file: s.file, range: s.range, warning: true });
    }
    for (const a of r.duplicates) {
      const s = siteOf(a)!;
      out.push({ kind: 'item', label: a, description: 'registered twice', file: s.file, range: s.range, warning: true });
    }
    const p = r.program;
    if (p && !p.ok) out.push({ kind: 'item', label: 'program', description: `failed: ${p.failure}`, warning: true });
    if (p && p.ok) {
      for (const a of p.programOnly) out.push({ kind: 'item', label: a, description: 'program only (not declared)', warning: true });
      for (const a of p.programMissing) out.push({ kind: 'item', label: a, description: 'declared, program lacks it', warning: true });
      for (const a of p.notInSource) {
        if (!p.programOnly.includes(a)) out.push({ kind: 'item', label: a, description: 'program has it, source scan does not', warning: true });
      }
      if (programAgrees(p)) out.push({ kind: 'item', label: 'program', description: `agrees: ${p.names.length} actions`, warning: false });
    }
    if (!out.length) out.push({ kind: 'item', label: 'no drift', warning: false });
    return out;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
