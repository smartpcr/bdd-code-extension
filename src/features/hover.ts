// Hover on a step's action value (plan B1.2, B1.4).
import * as vscode from 'vscode';
import { fileKey } from '../core/paths';
import { actionHoverMarkdown } from '../core/hoverText';
import { contains } from '../core/workspaceIndex';
import { FolderIndexer, toRange } from './indexer';

export function siteLink(file: string, line: number): string {
  return `${vscode.Uri.file(file).toString()}#L${line + 1}`;
}

export function registerHover(owner: (uri: vscode.Uri) => FolderIndexer | undefined): vscode.Disposable {
  return vscode.languages.registerHoverProvider({ scheme: 'file', language: 'yaml' }, {
    provideHover(doc, position) {
      const indexer = owner(doc.uri);
      if (!indexer) return undefined;
      const { index } = indexer;
      const pos = { line: position.line, character: position.character };
      const step = index.stepAt(doc.uri.fsPath, pos);
      if (!step?.action || !step.actionRange || !contains(step.actionRange, pos)) return undefined;
      const action = index.catalog?.actions.get(step.action);
      const range = toRange(step.actionRange);
      if (!action) return new vscode.Hover(`\`${step.action}\` is not in the action catalog.`, range);
      const labels = indexer.layout.bindings;
      const order = index.catalog!.bindings;
      const bindings = order.map(name => ({ name, label: labels.find(b => b.name === name)?.label ?? name }));
      const md = new vscode.MarkdownString(actionHoverMarkdown(action, bindings, index.sitesFor(action.name),
        s => siteLink(s.file, s.range.start.line)));
      if (index.catalogStale || index.isStale(fileKey(doc.uri.fsPath))) md.appendMarkdown('\n\n*(stale: the last parse failed)*');
      return new vscode.Hover(md, range);
    },
  });
}
