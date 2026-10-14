// Activation (plan B1.1, B1.7): one layout and one index per workspace folder
// that holds a catalog; inert where there is none.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readSettings, WorkspaceLayout } from './config/layout';
import { fileKey } from './core/paths';
import { registerHover } from './features/hover';
import { FolderIndexer } from './features/indexer';
import { registerNavigation } from './features/navigation';

/** What the integration tests read; not a public API. */
export interface TestApi {
  log: string[];
  providerCount: number;
  indexers: FolderIndexer[];
  ready: Promise<void>;
  rebuild(): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<TestApi> {
  const channel = vscode.window.createOutputChannel('Suite Authoring');
  const catalogDiagnostics = vscode.languages.createDiagnosticCollection('bddSuite.catalog');
  const indexDiagnostics = vscode.languages.createDiagnosticCollection('bddSuite.index');
  context.subscriptions.push(channel, catalogDiagnostics, indexDiagnostics);
  const api: TestApi = { log: [], providerCount: 0, indexers: [], ready: Promise.resolve(), rebuild: async () => {} };
  const log = (line: string) => {
    api.log.push(line);
    channel.appendLine(line);
  };
  let session: vscode.Disposable[] = [];

  const owner = (uri: vscode.Uri): FolderIndexer | undefined => {
    const key = fileKey(uri.fsPath);
    return api.indexers.find(ix => key === ix.layout.folder || key.startsWith(ix.layout.folder + path.sep));
  };

  const build = async (): Promise<void> => {
    for (const d of session) d.dispose();
    session = [];
    api.indexers = [];
    api.providerCount = 0;
    catalogDiagnostics.clear();
    indexDiagnostics.clear();
    const storage = context.globalStorageUri.fsPath;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const config = vscode.workspace.getConfiguration('bddSuite', folder.uri);
      const { settings, messages } = readSettings(key => {
        const i = config.inspect(key);
        return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
      });
      for (const m of messages) log(m);
      const layout = WorkspaceLayout.create(folder.uri.fsPath, settings, storage, p => fs.existsSync(p));
      if (!layout) continue;
      log(`Root: ${layout.root}  Catalog: ${layout.catalogPath}`);
      const indexer = new FolderIndexer(layout, log, catalogDiagnostics, indexDiagnostics);
      api.indexers.push(indexer);
      session.push(indexer);
    }
    if (api.indexers.length === 0) {
      log('No actions catalog in this workspace; Suite Authoring is inert.');
      return;
    }
    const providers = [registerHover(owner), ...registerNavigation(owner, () => api.indexers)];
    api.providerCount = 4;
    session.push(...providers);
    api.ready = Promise.all(api.indexers.map(ix => ix.start())).then(() => undefined);
    await api.ready;
  };
  api.rebuild = build;

  context.subscriptions.push(
    { dispose: () => session.forEach(d => d.dispose()) },
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('bddSuite')) void build();
    }),
  );
  await build();
  return api;
}

export function deactivate(): void {}
