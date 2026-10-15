// Completion (plan B3.1-B3.5): action names, expressions, meta steps and their
// `with:` parameters. Answers from the index only (INV-9).
import * as path from 'path';
import * as vscode from 'vscode';
import { SUITE_DOCUMENTS } from './suiteLanguage';
import { actionSortKey, renderBindingBadge } from '../core/coverage';
import { actionPrefix, metaPrefix, requiredParamsSnippet, stepKeysAround, withKeyPrefix } from '../core/completionContext';
import { CONTEXT_KEYS, cursorContext, ExprContext, FUNCTIONS } from '../core/exprCursor';
import { actionHoverMarkdown } from '../core/hoverText';
import { scopeAt, shapeAt } from '../core/scope';
import { siteLink } from './hover';
import { FolderIndexer } from './indexer';

type Owner = (uri: vscode.Uri) => FolderIndexer | undefined;
const K = vscode.CompletionItemKind;

function item(label: string, kind: vscode.CompletionItemKind, range: vscode.Range, detail?: string,
  doc?: string | vscode.MarkdownString): vscode.CompletionItem {
  const i = new vscode.CompletionItem(label, kind);
  i.range = range;
  i.detail = detail;
  if (doc) i.documentation = doc;
  return i;
}

/**
 * The catalog's actions. Each says which bindings implement it and which do
 * not; those the target binding implements come first; choosing one also
 * inserts the required parameters the step does not have yet.
 */
function actionItems(ix: FolderIndexer, range: vscode.Range, step: { keyColumn: number; keys: Set<string> }, eol: string): vscode.CompletionItem[] {
  const catalog = ix.index.catalog;
  if (!catalog) return [];
  const known = ix.layout.bindings.map(b => ({ name: b.name, abbreviation: b.abbreviation, label: b.label }));
  const labels = catalog.bindings.map(name => ({ name, label: known.find(k => k.name === name)?.label ?? name }));
  const target = ix.layout.settings.targetBinding;
  return [...catalog.actions.values()].map(a => {
    const lacking = catalog.bindings.filter(b => !a.bindings.includes(b));
    const badge = renderBindingBadge(catalog.bindings, a.bindings, known) + (lacking.length ? ` · not in ${renderBindingBadge(catalog.bindings, lacking, known)}` : '');
    const i = item(a.name, K.Function, range, badge,
      new vscode.MarkdownString(actionHoverMarkdown(a, labels, ix.index.sitesFor(a.name), s => siteLink(s.file, s.range.start.line))));
    i.sortText = actionSortKey(a.name, a.bindings, target);
    const required = a.params.filter(p => p.required).map(p => p.name);
    i.insertText = new vscode.SnippetString(requiredParamsSnippet(a.name, required, step.keyColumn, step.keys, eol));
    if (a.deprecated) i.tags = [vscode.CompletionItemTag.Deprecated];
    return i;
  });
}

function expressionItems(ix: FolderIndexer, file: string, pos: vscode.Position, ctx: ExprContext,
  range: vscode.Range): vscode.CompletionItem[] {
  const scope = scopeAt(ix.index, file, { line: pos.line, character: pos.character });
  if (ctx.kind === 'root') {
    const out = ['capture', 'param', 'var', ...(scope.rows ? ['row'] : [])]
      .map(n => item(n, K.Module, range, 'namespace'));
    out.push(...CONTEXT_KEYS.map(k => item(k, K.Variable, range, 'context')));
    out.push(...Object.entries(FUNCTIONS).map(([name, sig]) => {
      const i = item(name, K.Function, range, sig);
      i.insertText = new vscode.SnippetString(`${name}($0)`);
      return i;
    }));
    return out;
  }
  if (ctx.root === 'capture') {
    if (ctx.segments.length === 0) {
      return [...scope.captures.values()].map(c =>
        item(c.name, K.Field, range, c.step.action ? `captured by ${c.step.action}` : 'capture',
          `${path.basename(c.step.file)}:${c.step.range.start.line + 1}`));
    }
    const source = scope.captures.get(ctx.segments[0]);
    const action = source?.step.action && ix.index.catalog?.actions.get(source.step.action);
    if (!source || !action) return [];
    const shape = shapeAt(action, ctx.segments.slice(1), source.fromTable);
    if (!shape || shape === 'open') return [];
    return [...shape.properties.entries()].map(([name, s]) => item(name, K.Property, range, s.type ?? ''));
  }
  if (ctx.segments.length > 0) return [];
  const names = ctx.root === 'param' ? scope.params : ctx.root === 'var' ? scope.vars : ctx.root === 'row' ? scope.rows ?? [] : [];
  return names.map(n => item(n, K.Variable, range, ctx.root));
}

export function registerCompletion(owner: Owner): vscode.Disposable {
  return vscode.languages.registerCompletionItemProvider(SUITE_DOCUMENTS, {
    async provideCompletionItems(doc, pos) {
      const ix = owner(doc.uri);
      await ix?.ready;
      if (!ix || !ix.index.isSuiteOrLibrary(doc.uri.fsPath)) return undefined;
      const line = doc.lineAt(pos.line).text;
      const before = line.slice(0, pos.character);
      const rangeFrom = (start: number) => new vscode.Range(pos.line, start, pos.line, pos.character);

      const expr = cursorContext(line, pos.character);
      if (expr) return expressionItems(ix, doc.uri.fsPath, pos, expr, rangeFrom(expr.start));

      const actionTyped = actionPrefix(before);
      if (actionTyped !== undefined) {
        return actionItems(ix, rangeFrom(pos.character - actionTyped.length), stepKeysAround(doc.getText().split(/\r?\n/), pos.line),
          doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
      }

      const metaTyped = metaPrefix(before);
      if (metaTyped !== undefined) {
        return ix.index.metaCompletions(doc.uri.fsPath).map(t => item(t.def.name, K.Module,
          rangeFrom(pos.character - metaTyped.length), path.basename(t.file),
          `params: ${t.def.params.join(', ') || 'none'}; exports: ${t.def.exports.join(', ') || 'none'}`));
      }

      const lines = doc.getText().split(/\r?\n/);
      const keyTyped = withKeyPrefix(lines, pos.line, pos.character);
      if (keyTyped !== undefined) {
        const step = ix.index.stepAt(doc.uri.fsPath, { line: pos.line, character: pos.character });
        const target = step && ix.index.metaTargetOf(step);
        if (!target) return undefined;
        const written = new Set(step!.withKeys.map(k => k.name));
        return target.def.params.filter(p => !written.has(p) || p === keyTyped).map(p => {
          const required = target.def.required.includes(p);
          const i = item(p, K.Property, rangeFrom(pos.character - keyTyped.length), required ? 'required' : 'optional');
          i.sortText = `${required ? '0' : '1'}${p}`;
          i.insertText = `${p}: `;
          return i;
        });
      }
      return undefined;
    },
  }, ':', ' ', '.', '{', '$', ',', '(');
}
