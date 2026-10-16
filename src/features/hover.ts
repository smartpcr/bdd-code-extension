// Hover on a step's action value (plan B1.2, B1.4) and on a ${capture...} path (B3.4).
import * as vscode from 'vscode';
import { SUITE_DOCUMENTS } from './suiteLanguage';
import { fileKey } from '../core/paths';
import { expectedBindings } from '../core/coverage';
import { actionHoverMarkdown, captureHoverMarkdown } from '../core/hoverText';
import { capturePathAt, scopeAt, shapeAt } from '../core/scope';
import { contains } from '../core/workspaceIndex';
import { FolderIndexer, toRange } from './indexer';

export function siteLink(file: string, line: number): string {
  return `${vscode.Uri.file(file).toString()}#L${line + 1}`;
}

export function registerHover(owner: (uri: vscode.Uri) => FolderIndexer | undefined): vscode.Disposable {
  return vscode.languages.registerHoverProvider(SUITE_DOCUMENTS, {
    async provideHover(doc, position) {
      const indexer = owner(doc.uri);
      await indexer?.ready;
      if (!indexer) return undefined;
      const { index } = indexer;
      const pos = { line: position.line, character: position.character };
      const step = index.stepAt(doc.uri.fsPath, pos);
      const expr = step?.expressions.find(e => contains(e.range, pos) && e.range.start.line === pos.line);
      const segments = expr && capturePathAt(expr.text, pos.character - expr.range.start.character);
      if (segments) {
        const source = scopeAt(index, doc.uri.fsPath, pos).captures.get(segments[0]);
        const action = source?.step.action ? index.catalog?.actions.get(source.step.action) : undefined;
        const shape = source && action ? shapeAt(action, segments.slice(1), source.fromTable) : undefined;
        const md = captureHoverMarkdown(segments,
          source && { file: source.step.file, line: source.step.range.start.line, action: source.step.action, fromTable: source.fromTable },
          shape, source ? siteLink(source.step.file, source.step.range.start.line) : '');
        return new vscode.Hover(new vscode.MarkdownString(md), toRange(expr!.range));
      }
      if (!step?.action || !step.actionRange || !contains(step.actionRange, pos)) return undefined;
      const action = index.catalog?.actions.get(step.action);
      const range = toRange(step.actionRange);
      if (!action) return new vscode.Hover(`\`${step.action}\` is not in the action catalog.`, range);
      const labels = indexer.layout.bindings;
      const order = expectedBindings(index.catalog!);
      const bindings = order.map(name => ({ name, label: labels.find(b => b.name === name)?.label ?? name }));
      const md = new vscode.MarkdownString(actionHoverMarkdown(action, bindings, index.sitesFor(action.name),
        s => siteLink(s.file, s.range.start.line)));
      if (index.catalogStale || index.isStale(fileKey(doc.uri.fsPath))) md.appendMarkdown('\n\n*(stale: the last parse failed)*');
      return new vscode.Hover(md, range);
    },
  });
}
