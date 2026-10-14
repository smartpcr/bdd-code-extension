// Go to Definition, Find All References and CodeLens (plan B1.3-B1.6).
import * as vscode from 'vscode';
import { Range } from '../core/text';
import { StepInfo } from '../core/types';
import { contains } from '../core/workspaceIndex';
import { FolderIndexer, toRange } from './indexer';

const loc = (file: string, r: Range): vscode.Location => new vscode.Location(vscode.Uri.file(file), toRange(r));
const stepLoc = (s: StepInfo): vscode.Location => loc(s.file, s.actionRange ?? s.metaRange ?? s.range);

type Owner = (uri: vscode.Uri) => FolderIndexer | undefined;

export function definitionsAt(indexer: FolderIndexer, file: string, position: vscode.Position): vscode.Location[] {
  const { index } = indexer;
  const pos = { line: position.line, character: position.character };
  const step = index.stepAt(file, pos);
  if (step?.metaRange && contains(step.metaRange, pos)) {
    const target = index.metaTargetOf(step);
    return target ? [loc(target.file, target.def.nameRange)] : [];
  }
  if (!step?.action || !step.actionRange || !contains(step.actionRange, pos)) return [];
  const out: vscode.Location[] = [];
  const entry = index.catalog?.actions.get(step.action);
  if (entry) out.push(loc(index.catalog!.file, entry.nameRange));
  for (const site of index.sitesFor(step.action)) out.push(loc(site.file, site.range));
  return out;
}

export function referencesAt(indexer: FolderIndexer, file: string, position: vscode.Position): vscode.Location[] {
  const { index } = indexer;
  const pos = { line: position.line, character: position.character };
  const def = index.metaDefinitionAt(file, pos);
  if (def) return index.metaUses(def).map(stepLoc);
  const step = index.stepAt(file, pos);
  if (step?.metaRange && contains(step.metaRange, pos)) {
    const target = index.metaTargetOf(step);
    return target ? index.metaUses(target).map(stepLoc) : [];
  }
  const name = index.actionNameAt(file, pos);
  return name === undefined ? [] : index.stepsUsing(name).map(stepLoc);
}

export function registerNavigation(owner: Owner, indexers: () => FolderIndexer[]): vscode.Disposable[] {
  const yaml: vscode.DocumentSelector = { scheme: 'file', language: 'yaml' };
  const sources: vscode.DocumentFilter[] = indexers().flatMap(ix => ix.layout.bindings.flatMap(b =>
    b.sources.map(g => ({ scheme: 'file', pattern: new vscode.RelativePattern(vscode.Uri.file(ix.layout.folder), g) }))));
  const lensChanged = new vscode.EventEmitter<void>();
  const subscriptions = indexers().map(ix => ix.onDidChangeIndex(() => lensChanged.fire()));
  return [
    lensChanged,
    ...subscriptions,
    vscode.languages.registerDefinitionProvider(yaml, {
      provideDefinition(doc, position) {
        const ix = owner(doc.uri);
        return ix ? definitionsAt(ix, doc.uri.fsPath, position) : undefined;
      },
    }),
    vscode.languages.registerReferenceProvider([yaml, ...sources], {
      provideReferences(doc, position) {
        const ix = owner(doc.uri);
        return ix ? referencesAt(ix, doc.uri.fsPath, position) : undefined;
      },
    }),
    vscode.languages.registerCodeLensProvider(sources, {
      onDidChangeCodeLenses: lensChanged.event,
      provideCodeLenses(doc) {
        const ix = owner(doc.uri);
        if (!ix) return [];
        return ix.index.sitesIn(doc.uri.fsPath).map(site => {
          const steps = ix.index.stepsUsing(site.action);
          const range = toRange(site.range);
          return new vscode.CodeLens(range, steps.length
            ? {
              title: `${steps.length} suite step${steps.length === 1 ? '' : 's'}`,
              command: 'editor.action.showReferences',
              arguments: [doc.uri, range.start, steps.map(stepLoc)],
            }
            : { title: 'no suite steps', command: '' });
        });
      },
    }),
  ];
}
