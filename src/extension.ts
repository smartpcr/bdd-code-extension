// Activation (plan B1.1, B1.7, B2): one layout, one index and one lint
// controller per workspace folder that holds a catalog; inert where there is none.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readSettings, WorkspaceLayout } from './config/layout';
import { createTrustGate } from './config/trust';
import { LintResults } from './core/diagnostics';
import { fileKey } from './core/paths';
import { registerCommands } from './features/commands';
import { registerCompletion } from './features/completion';
import { registerHover } from './features/hover';
import { FolderIndexer } from './features/indexer';
import { registerInlayHints } from './features/inlay';
import { LintController } from './features/lintController';
import { registerNavigation } from './features/navigation';
import { SuiteStatusBar } from './features/statusBar';
import { killAll } from './tools/runTool';

/** What the integration tests read; not a public API. */
export interface TestApi {
  log: string[];
  providerCount: number;
  indexers: FolderIndexer[];
  controllers: LintController[];
  status: SuiteStatusBar;
  /** Present only when BDD_TEST_TRUST_SEAM=1: what a user's trust grant does. */
  grantTrustForTest?: () => void;
  ready: Promise<void>;
  rebuild(): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<TestApi> {
  const channel = vscode.window.createOutputChannel('Suite Authoring');
  const catalogDiagnostics = vscode.languages.createDiagnosticCollection('bddSuite.catalog');
  const indexDiagnostics = vscode.languages.createDiagnosticCollection('bddSuite.index');
  const lintDiagnostics = vscode.languages.createDiagnosticCollection('bddSuite.lint');
  const status = new SuiteStatusBar();
  // VS Code gives extensions no way to grant trust, so the integration harness
  // (and only it, through this variable) can stand in for the user's grant (B2.6-3).
  const trustSeam = process.env.BDD_TEST_TRUST_SEAM === '1';
  let grantedBySeam = false;
  const gate = createTrustGate(() => vscode.workspace.isTrusted || grantedBySeam);
  context.subscriptions.push(channel, catalogDiagnostics, indexDiagnostics, lintDiagnostics, status);
  const api: TestApi = {
    log: [], providerCount: 0, indexers: [], controllers: [], status, ready: Promise.resolve(), rebuild: async () => {},
  };
  const log = (line: string) => {
    api.log.push(line);
    channel.appendLine(line);
  };
  let session: vscode.Disposable[] = [];
  // Lint results outlive a rebuild, so a settings change never empties a file's findings (B2.4-1).
  const results = new Map<string, LintResults>();

  const owner = (uri: vscode.Uri): FolderIndexer | undefined => {
    const key = fileKey(uri.fsPath);
    return api.indexers.find(ix => key === ix.layout.folder || key.startsWith(ix.layout.folder + path.sep));
  };

  const notifyNotBuilt = (tool: string) => {
    void vscode.window.showWarningMessage(`Suite Authoring: the ${tool} lint tool is not built.`, 'Build lint tool', 'Choose another tool')
      .then(choice => {
        if (choice === 'Build lint tool') void vscode.commands.executeCommand('bddSuite.buildLintTool');
        if (choice === 'Choose another tool') void vscode.commands.executeCommand('bddSuite.chooseLintTool');
      });
  };

  const build = async (): Promise<void> => {
    for (const d of session) d.dispose();
    session = [];
    api.indexers = [];
    api.controllers = [];
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
      if (!results.has(layout.folder)) results.set(layout.folder, new LintResults());
      const controller = new LintController(indexer, results.get(layout.folder)!, lintDiagnostics, log, status, gate, notifyNotBuilt);
      api.indexers.push(indexer);
      api.controllers.push(controller);
      session.push(indexer, controller);
    }
    if (api.indexers.length === 0) {
      log('No actions catalog in this workspace; Suite Authoring is inert.');
      return;
    }
    const hintsChanged = new vscode.EventEmitter<void>();
    session.push(hintsChanged, ...api.indexers.map(ix => ix.onDidChangeIndex(() => hintsChanged.fire())));
    const providers = [registerHover(owner), ...registerNavigation(owner, () => api.indexers),
      registerInlayHints(owner, hintsChanged.event), registerCompletion(owner)];
    api.providerCount = 6;
    session.push(...providers);
    const first = api.indexers[0].layout.settings;
    if (gate.canRunWorkspaceCode()) status.setOk(first.lintTool, first.targetBinding);
    else status.setUntrusted();
    api.ready = Promise.all(api.indexers.map(ix => ix.start())).then(() => {
      for (const c of api.controllers) c.lintOpen();
    });
    await api.ready;
  };
  // Rebuilds run one after another: two quick settings changes never interleave,
  // so a controller is never replaced while a rebuild is half done.
  let building: Promise<void> = Promise.resolve();
  const rebuild = (): Promise<void> => (building = building.then(build, build));
  api.rebuild = rebuild;

  /** Trust was granted: lint every open suite, with no reload (B2.6-3). */
  const onTrustGranted = () => {
    const s = api.indexers[0]?.layout.settings;
    if (s) status.setOk(s.lintTool, s.targetBinding);
    for (const c of api.controllers) c.lintOpen();
  };
  if (trustSeam) {
    api.grantTrustForTest = () => {
      grantedBySeam = true;
      onTrustGranted();
    };
  }

  context.subscriptions.push(
    { dispose: () => session.forEach(d => d.dispose()) },
    ...registerCommands({
      indexers: () => api.indexers,
      controllers: () => api.controllers,
      log,
      show: () => channel.show(true),
      gate,
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('bddSuite')) void rebuild();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(onTrustGranted),
  );
  await rebuild();
  return api;
}

/** INV-5: no child outlives the extension. */
export function deactivate(): void {
  killAll();
}
