// The test-generation config, bddsuite.tests.yaml, in the editor
// (docs/test-providers, D16): its findings against spec/tests.config.schema.json
// while it is typed, and completion of its keys and providers. Registered once
// for the window, whether or not the workspace has a catalog: a test project's
// config is worth checking on its own.
import * as vscode from 'vscode';
import { Debouncer } from '../core/debounce';
import { fileKey } from '../core/paths';
import { checkTestsConfig, isTestsConfigFile, testsConfigCompletion } from '../core/testsConfig';
import { TESTS_CONFIG_SCHEMA } from '../core/testsConfigSchema';
import { toRange } from './indexer';

const CONFIG_DEBOUNCE_MS = 250;
const SOURCE = 'bdd-suite tests config';

/** What the schema says about a key or the provider list, for completion's documentation. */
function describe(kind: 'key' | 'value', item: string): string | undefined {
  const properties: Record<string, { description?: string; properties?: Record<string, { description?: string }> }> = TESTS_CONFIG_SCHEMA.properties;
  if (kind === 'value') return properties.provider?.description;
  return properties[item]?.description ?? properties.output?.properties?.[item]?.description;
}

export function registerTestsConfig(): vscode.Disposable[] {
  const diagnostics = vscode.languages.createDiagnosticCollection('bddSuite.testsConfig');
  const debouncer = new Debouncer(CONFIG_DEBOUNCE_MS);
  const serves = (doc: vscode.TextDocument) => doc.uri.scheme === 'file' && isTestsConfigFile(doc.uri.fsPath);
  const validate = (doc: vscode.TextDocument) => {
    if (!serves(doc)) return;
    diagnostics.set(doc.uri, checkTestsConfig(doc.getText()).map(f => {
      const d = new vscode.Diagnostic(toRange(f.range), f.message, vscode.DiagnosticSeverity.Error);
      d.source = SOURCE;
      d.code = f.code;
      return d;
    }));
  };
  vscode.workspace.textDocuments.forEach(validate);
  return [
    diagnostics, debouncer,
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (serves(e.document)) debouncer.schedule(fileKey(e.document.uri.fsPath), () => validate(e.document));
    }),
    vscode.workspace.onDidCloseTextDocument(d => diagnostics.delete(d.uri)),
    vscode.languages.registerCompletionItemProvider({ scheme: 'file', pattern: '**/*.tests.yaml' }, {
      provideCompletionItems(doc, pos) {
        if (!serves(doc)) return undefined;
        const offered = testsConfigCompletion(doc.getText(), doc.offsetAt(pos));
        if (!offered) return undefined;
        return offered.items.map(name => {
          const item = new vscode.CompletionItem(name, offered.kind === 'key' ? vscode.CompletionItemKind.Property : vscode.CompletionItemKind.EnumMember);
          if (offered.kind === 'key') item.insertText = `${name}: `;
          item.detail = offered.kind === 'key' ? 'bddsuite.tests.yaml key' : 'test framework';
          const about = describe(offered.kind, name);
          if (about) item.documentation = about;
          return item;
        });
      },
    }, ':', ' '),
  ];
}
