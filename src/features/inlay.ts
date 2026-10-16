// Per-step binding badges (plan B2.3, O2).
import * as vscode from 'vscode';
import { SUITE_DOCUMENTS } from './suiteLanguage';
import { bindingTooltip, expectedBindings, renderBindingBadge } from '../core/coverage';
import { FolderIndexer } from './indexer';

export function registerInlayHints(owner: (uri: vscode.Uri) => FolderIndexer | undefined,
  changed: vscode.Event<void>): vscode.Disposable {
  return vscode.languages.registerInlayHintsProvider(SUITE_DOCUMENTS, {
    onDidChangeInlayHints: changed,
    async provideInlayHints(doc, range) {
      const ix = owner(doc.uri);
      await ix?.ready;
      if (!ix || !ix.layout.settings['inlayHints.bindings']) return [];
      const catalog = ix.index.catalog;
      const suite = ix.index.suite(doc.uri.fsPath);
      if (!catalog || !suite || !ix.index.isSuiteOrLibrary(doc.uri.fsPath)) return [];
      const known = ix.layout.bindings.map(b => ({ name: b.name, abbreviation: b.abbreviation, label: b.label }));
      const target = ix.layout.settings.targetBinding;
      const expected = expectedBindings(catalog);
      const hints: vscode.InlayHint[] = [];
      for (const step of suite.steps) {
        const action = step.action === undefined ? undefined : catalog.actions.get(step.action);
        if (!action || !step.actionRange) continue;
        const at = new vscode.Position(step.actionRange.end.line, step.actionRange.end.character);
        if (!range.contains(at)) continue;
        const hint = new vscode.InlayHint(at, renderBindingBadge(expected, action.bindings.filter(b => expected.includes(b)), known));
        hint.paddingLeft = true;
        hint.tooltip = bindingTooltip(action.bindings, known, target);
        hints.push(hint);
      }
      return hints;
    },
  });
}
