// Go to Definition, Find All References and CodeLens (plan B1.3-B1.6).
import * as vscode from 'vscode';
import { SUITE_DOCUMENTS } from './suiteLanguage';
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
  // Ctrl+click lands on the code that runs: each binding's handler where it is
  // declared (the C# method, the Go `func`, the Rust `fn`, the TypeScript
  // `function`), or the registration itself when the handler is written inline,
  // as PowerShell's script block is. The catalog entry comes first.
  const out: vscode.Location[] = [];
  const entry = index.catalog?.actions.get(step.action);
  if (entry) out.push(loc(entry.file ?? index.catalog!.file, entry.nameRange));
  for (const site of index.sitesFor(step.action)) out.push(loc(site.file, site.handlerRange ?? site.range));
  return out;
}

/** Go to Implementations on a step's action or a catalog entry: each binding's registration line. */
export function implementationsAt(indexer: FolderIndexer, file: string, position: vscode.Position): vscode.Location[] {
  const { index } = indexer;
  const pos = { line: position.line, character: position.character };
  const step = index.stepAt(file, pos);
  const name = step?.action !== undefined && step.actionRange && contains(step.actionRange, pos)
    ? step.action : index.catalogActionAt(file, pos)?.name;
  if (name === undefined) return [];
  return index.sitesFor(name).map(s => loc(s.file, s.range));
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
  const yaml: vscode.DocumentFilter[] = SUITE_DOCUMENTS;
  const sources: vscode.DocumentFilter[] = indexers().flatMap(ix => ix.layout.bindings.flatMap(b =>
    b.sources.map(g => ({ scheme: 'file', pattern: new vscode.RelativePattern(vscode.Uri.file(ix.layout.folder), g) }))));
  const lensChanged = new vscode.EventEmitter<void>();
  const subscriptions = indexers().map(ix => ix.onDidChangeIndex(() => lensChanged.fire()));
  return [
    lensChanged,
    ...subscriptions,
    vscode.languages.registerDefinitionProvider(yaml, {
      async provideDefinition(doc, position) {
        const ix = owner(doc.uri);
        await ix?.ready;
        return ix ? definitionsAt(ix, doc.uri.fsPath, position) : undefined;
      },
    }),
    vscode.languages.registerImplementationProvider(yaml, {
      async provideImplementation(doc, position) {
        const ix = owner(doc.uri);
        await ix?.ready;
        return ix ? implementationsAt(ix, doc.uri.fsPath, position) : undefined;
      },
    }),
    vscode.languages.registerReferenceProvider([...yaml, ...sources], {
      async provideReferences(doc, position) {
        const ix = owner(doc.uri);
        await ix?.ready;
        return ix ? referencesAt(ix, doc.uri.fsPath, position) : undefined;
      },
    }),
    vscode.languages.registerCodeLensProvider(sources, {
      onDidChangeCodeLenses: lensChanged.event,
      async provideCodeLenses(doc) {
        const ix = owner(doc.uri);
        await ix?.ready;
        if (!ix) return [];
        // A lens on each registration, and one on its handler where the handler is declared on another line.
        return ix.index.sitesIn(doc.uri.fsPath).flatMap(site => {
          const steps = ix.index.stepsUsing(site.action);
          const ranges = [site.range, ...(site.handlerRange && site.handlerRange.start.line !== site.range.start.line ? [site.handlerRange] : [])];
          return ranges.map(r => {
            const range = toRange(r);
            return new vscode.CodeLens(range, steps.length
              ? {
                title: `${steps.length} suite step${steps.length === 1 ? '' : 's'}`,
                command: 'editor.action.showReferences',
                arguments: [doc.uri, range.start, steps.map(stepLoc)],
              }
              : { title: 'no suite steps', command: '' });
          });
        });
      },
    }),
  ];
}
