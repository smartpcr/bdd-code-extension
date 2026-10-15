// The BDD Suite language mode (`bdd-suite`): a YAML file opened as a suite.
// A .yml file can be switched to it with Change Language Mode, and one whose
// name contains suite, feature or test opens in it (package.json). In this
// mode the extension:
//   * colours what a grammar cannot know (semantic tokens): an action by where
//     it is implemented, a step's keys by whether the schema or the action
//     declares them, a meta step's `with:` keys by its definition;
//   * enforces the workspace's generated suite.schema.json while typing;
//   * completes a step's keys from that schema, the action's parameters first.
// The schema check and key completion also serve a suite in plain YAML mode,
// unless a YAML extension is enabled to do that itself. No other extension is
// needed. Every other feature (navigation, hover, lint, scaffolding) serves
// both modes.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ValidateFunction } from 'ajv';
import { commonStepKeys } from '../core/catalogEdit';
import { keyPrefix, stepAtColumn } from '../core/completionContext';
import { checkAgainstSchema, compileSuiteSchema } from '../core/schemaCheck';
import { ActionStatus, suiteTokens, TOKEN_MODIFIERS, TOKEN_TYPES, TokenContext } from '../core/suiteTokens';
import { Debouncer } from '../core/debounce';
import { fileKey } from '../core/paths';
import { FolderIndexer, toRange } from './indexer';
import { stepEnvelopeKeys } from './scaffold';

export const LANGUAGE_ID = 'bdd-suite';
/** What the suite features answer for: a YAML file, or one in the BDD Suite mode. */
export const SUITE_DOCUMENTS: vscode.DocumentFilter[] = [{ scheme: 'file', language: 'yaml' }, { scheme: 'file', language: LANGUAGE_ID }];
export const SCHEMA_DIAGNOSTIC_CODE = 'BDD060';
/** A YAML extension that checks YAML-mode files against schemas itself; when it is enabled, this extension leaves YAML mode to it. */
const YAML_EXTENSION = 'redhat.vscode-yaml';

/**
 * Whether this extension checks and completes `doc` against the suite schema:
 * always in the BDD Suite mode; in YAML mode, for a file the index holds as a
 * suite or library, unless a YAML extension is enabled to do it (so nothing is
 * reported or offered twice).
 */
export function schemaServes(doc: vscode.TextDocument, ix: FolderIndexer): boolean {
  if (doc.languageId === LANGUAGE_ID) return true;
  return doc.languageId === 'yaml' && !vscode.extensions.getExtension(YAML_EXTENSION) && ix.index.isSuiteOrLibrary(doc.uri.fsPath);
}
const SCHEMA_DEBOUNCE_MS = 300;
const DEFAULT_ENVELOPE = ['given', 'when', 'then', 'and', 'why', 'requires', 'timeoutSec', 'captureAs', 'ifCapture', 'table', 'asserts'];

type Owner = (uri: vscode.Uri) => FolderIndexer | undefined;

interface LoadedSchema {
  file: string;
  mtimeMs: number;
  json?: { $defs?: Record<string, { properties?: Record<string, { description?: string }>; required?: string[] }> };
  validate?: ValidateFunction;
  error?: string;
}

/** suite.schema.json beside the catalog, compiled once per change of the file. */
class SchemaCache {
  private readonly loaded = new Map<string, LoadedSchema>();

  get(ix: FolderIndexer): LoadedSchema {
    const file = path.join(path.dirname(ix.layout.catalogPath), 'suite.schema.json');
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return { file, mtimeMs, error: `There is no ${path.basename(file)} beside the catalog.` };
    }
    const cached = this.loaded.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    let entry: LoadedSchema;
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const compiled = compileSuiteSchema(json);
      entry = 'validate' in compiled ? { file, mtimeMs, json, validate: compiled.validate } : { file, mtimeMs, json, error: compiled.error };
    } catch (e) {
      entry = { file, mtimeMs, error: `${path.basename(file)} is not JSON: ${(e as Error).message}` };
    }
    this.loaded.set(file, entry);
    return entry;
  }
}

/** What the tokens need to know about actions and meta steps, from the index and the target binding. */
export function tokenContext(ix: FolderIndexer, file: string): TokenContext {
  const catalog = ix.index.catalog;
  const target = ix.layout.settings.targetBinding;
  const envelope = new Set(stepEnvelopeKeys(ix.layout.catalogPath) ?? DEFAULT_ENVELOPE);
  const metas = ix.index.visibleMetaSteps(file);
  return {
    envelope,
    action(name) {
      const entry = catalog?.actions.get(name);
      if (!entry) return { status: 'undeclared' };
      const bindings = ix.index.sitesFor(name).map(s => s.binding);
      const status: ActionStatus = bindings.includes(target) ? 'implemented' : bindings.length ? 'notInTarget' : 'unimplemented';
      return { status, params: entry.params.map(p => ({ name: p.name, required: !!p.required })) };
    },
    meta(name) {
      const def = metas.get(name)?.def;
      return def?.params.map(p => ({ name: p, required: def.required.includes(p) }));
    },
  };
}

export const LEGEND = new vscode.SemanticTokensLegend([...TOKEN_TYPES], [...TOKEN_MODIFIERS]);

export function registerSuiteLanguage(owner: Owner, changed: vscode.Event<void>): vscode.Disposable[] {
  const selector: vscode.DocumentFilter = { scheme: 'file', language: LANGUAGE_ID };
  const schemas = new SchemaCache();
  const diagnostics = vscode.languages.createDiagnosticCollection('bddSuite.schema');
  const debouncer = new Debouncer(SCHEMA_DEBOUNCE_MS);
  const tokensChanged = new vscode.EventEmitter<void>();

  const validate = (doc: vscode.TextDocument) => {
    const ix = owner(doc.uri);
    if (!ix || !schemaServes(doc, ix)) {
      diagnostics.delete(doc.uri);
      return;
    }
    const schema = schemas.get(ix);
    if (!schema.validate) {
      const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), `The suite schema cannot be used: ${schema.error}`, vscode.DiagnosticSeverity.Warning);
      d.source = 'bdd-suite schema';
      d.code = SCHEMA_DIAGNOSTIC_CODE;
      diagnostics.set(doc.uri, [d]);
      return;
    }
    diagnostics.set(doc.uri, checkAgainstSchema(doc.getText(), schema.validate).map(f => {
      const d = new vscode.Diagnostic(toRange(f.range), f.message, vscode.DiagnosticSeverity.Error);
      d.source = 'bdd-suite schema';
      d.code = SCHEMA_DIAGNOSTIC_CODE;
      return d;
    }));
  };
  const validateOpen = () => vscode.workspace.textDocuments.forEach(validate);
  const watcher = vscode.workspace.createFileSystemWatcher('**/suite.schema.json');
  validateOpen();

  // Changing a document's language mode closes and reopens it, so the open and
  // close events also cover a switch to the mode and away from it.
  return [
    diagnostics, debouncer, tokensChanged, watcher,
    // A file the index now holds as a suite is checked in YAML mode too.
    changed(() => {
      tokensChanged.fire();
      validateOpen();
    }),
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument(e => {
      const ix = owner(e.document.uri);
      if (ix && schemaServes(e.document, ix)) debouncer.schedule(fileKey(e.document.uri.fsPath), () => validate(e.document));
    }),
    vscode.workspace.onDidCloseTextDocument(d => diagnostics.delete(d.uri)),
    watcher.onDidChange(validateOpen), watcher.onDidCreate(validateOpen), watcher.onDidDelete(validateOpen),
    vscode.languages.registerDocumentSemanticTokensProvider(selector, {
      onDidChangeSemanticTokens: tokensChanged.event,
      async provideDocumentSemanticTokens(doc) {
        const ix = owner(doc.uri);
        await ix?.ready;
        const builder = new vscode.SemanticTokensBuilder(LEGEND);
        if (!ix) return builder.build();
        for (const t of suiteTokens(doc.getText(), tokenContext(ix, doc.uri.fsPath))) {
          builder.push(new vscode.Range(t.line, t.character, t.line, t.character + t.length), t.type, t.modifiers);
        }
        return builder.build();
      },
    }, LEGEND),
    vscode.languages.registerCompletionItemProvider(SUITE_DOCUMENTS, {
      async provideCompletionItems(doc, pos) {
        const ix = owner(doc.uri);
        await ix?.ready;
        const prefix = keyPrefix(doc.lineAt(pos.line).text.slice(0, pos.character));
        if (!ix || !prefix || !schemaServes(doc, ix)) return undefined;
        const lines = doc.getText().split(/\r?\n/);
        const step = stepAtColumn(lines, pos.line, prefix.column);
        if (!step.item) return undefined;
        const defs = schemas.get(ix).json?.$defs ?? {};
        const action = step.keys.get('action')?.replace(/\s+#.*$/, '').trim();
        const branch = action ? defs[`step.${action}`] : step.keys.has('meta') ? defs['step.meta'] : undefined;
        if (!branch?.properties) return undefined;
        const required = new Set(branch.required ?? []);
        const params = new Set((action && ix.index.catalog?.actions.get(action)?.params.map(p => p.name)) || []);
        const range = new vscode.Range(pos.line, pos.character - prefix.typed.length, pos.line, pos.character);
        return Object.entries(branch.properties).filter(([k]) => !step.keys.has(k) || k === prefix.typed).map(([k, s]) => {
          const isParam = params.has(k);
          const item = new vscode.CompletionItem(k, isParam ? vscode.CompletionItemKind.Variable : vscode.CompletionItemKind.Property);
          item.range = range;
          item.detail = `${required.has(k) ? 'required ' : ''}${isParam ? `parameter of ${action}` : 'step key'}`;
          if (s.description) item.documentation = s.description;
          item.sortText = `${required.has(k) ? '0' : isParam ? '1' : '2'}${k}`;
          item.insertText = `${k}: `;
          return item;
        });
      },
    }),
  ];
}
