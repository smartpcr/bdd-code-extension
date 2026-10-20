// Activation (plan B1.1, B1.7, B2): one layout, one index and one lint
// controller per workspace folder that holds a catalog; inert where there is none.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { catalogSourceGlobs, readSettings, servingLayout, WorkspaceLayout } from './config/layout';
import { createTrustGate } from './config/trust';
import { resolveCatalog } from './core/catalog';
import { LintResults } from './core/diagnostics';
import { fileKey } from './core/paths';
import { registerCommands } from './features/commands';
import { CoverageView } from './features/coverageView';
import { registerImplementLens, registerScaffoldActions, registerScaffoldCommands } from './features/scaffold';
import { watchForUpdate } from './features/selfUpdate';
import { registerSuiteLanguage } from './features/suiteLanguage';
import { SuiteTesting } from './features/testing';
import { registerTestsConfig } from './features/testsConfig';
import { registerCompletion } from './features/completion';
import { registerHover } from './features/hover';
import { FolderIndexer } from './features/indexer';
import { registerInlayHints } from './features/inlay';
import { LintController } from './features/lintController';
import { registerNavigation } from './features/navigation';
import { SuiteStatusBar } from './features/statusBar';
import { LintWorkerHost } from './lint/workerHost';
import { killAll, liveChildren } from './tools/runTool';

/**
 * The `bindingSources` of a workspace catalog and the catalogs it imports, merged
 * (resolveCatalog), or undefined when none has any or the catalog cannot be read.
 * The catalog's open buffer wins over the disk and its imports are read from disk,
 * as the indexer reads them, so the two agree and a rebuild settles.
 */
function catalogSourcesOf(file: string): Record<string, string[]> | undefined {
  const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && fileKey(d.uri.fsPath) === fileKey(file));
  const read = (f: string) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return undefined;
    }
  };
  const text = open ? open.getText() : read(file);
  return text === undefined ? undefined : resolveCatalog(text, fileKey(file), read).sources;
}

/** The window's one lint worker (plan 2.4b); terminated by deactivate(). */
let workerHost: LintWorkerHost | undefined;

/** What the integration tests read; not a public API. */
export interface TestApi {
  log: string[];
  providerCount: number;
  indexers: FolderIndexer[];
  controllers: LintController[];
  status: SuiteStatusBar;
  coverage: CoverageView;
  testing: SuiteTesting;
  /** The extension's live child processes (INV-5, B6.5-1). */
  children: Set<number>;
  /** The window's lint worker (B8.1): workerCount, workersStarted. */
  lintWorker: LintWorkerHost;
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
  workerHost = new LintWorkerHost({ workerPath: path.join(context.extensionPath, 'dist', 'lintWorker.js'), gate: () => gate.canRunWorkspaceCode() });
  const lintWorker = workerHost;
  context.subscriptions.push(lintWorker);
  const coverage = new CoverageView(() => api.indexers, gate);
  const tree = vscode.window.createTreeView('bddSuite.bindings', { treeDataProvider: coverage });
  const testing = new SuiteTesting(() => api.indexers, (context.storageUri ?? context.globalStorageUri).fsPath, line => log(line), gate);
  context.subscriptions.push(channel, catalogDiagnostics, indexDiagnostics, lintDiagnostics, status, coverage, tree, testing);
  // bddsuite.tests.yaml is checked whether or not the workspace has a catalog (docs/test-providers, D16).
  context.subscriptions.push(...registerTestsConfig());
  const api: TestApi = {
    log: [], providerCount: 0, indexers: [], controllers: [], status, coverage, testing, children: liveChildren, lintWorker, ready: Promise.resolve(), rebuild: async () => {},
  };
  const log = (line: string) => {
    api.log.push(line);
    channel.appendLine(line);
  };
  // A newer copy installed while this window is open runs only after a reload; offer it.
  context.subscriptions.push(watchForUpdate(context, log));
  let session: vscode.Disposable[] = [];
  // Lint results outlive a rebuild, so a settings change never empties a file's findings (B2.4-1).
  const results = new Map<string, LintResults>();

  // A suite under another test/e2e/schema in the same folder is that tree's, not this catalog's.
  const owner = (uri: vscode.Uri): FolderIndexer | undefined => {
    const layout = servingLayout(uri.fsPath, api.indexers.map(ix => ix.layout), p => fs.existsSync(p));
    return layout && api.indexers.find(ix => ix.layout === layout);
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
      // The catalog's own bindingSources say where each binding's registrations are, over the settings.
      const catalogFile = path.resolve(folder.uri.fsPath, settings.catalogPath);
      const sources = catalogSourcesOf(catalogFile);
      const layout = WorkspaceLayout.create(folder.uri.fsPath, settings, storage, p => fs.existsSync(p), sources);
      if (!layout) continue;
      log(`Root: ${layout.root}  Catalog: ${layout.catalogPath}`);
      for (const s of sources ? catalogSourceGlobs(layout.folder, layout.catalogPath, sources).skipped : []) {
        log(`BDD025 bindingSources ${s}: outside the workspace folder; not indexed.`);
      }
      const indexer = new FolderIndexer(layout, log, catalogDiagnostics, indexDiagnostics, () => void rebuild());
      if (!results.has(layout.folder)) results.set(layout.folder, new LintResults());
      const controller = new LintController(indexer, results.get(layout.folder)!, lintDiagnostics, log, status, gate, notifyNotBuilt, lintWorker);
      api.indexers.push(indexer);
      api.controllers.push(controller);
      session.push(indexer, controller);
    }
    void vscode.commands.executeCommand('setContext', 'bddSuite.active', api.indexers.length > 0);
    coverage.refresh();
    // Test items refresh once the new index is scanned; an empty index here would drop every item a run request holds.
    if (api.indexers.length === 0) testing.refresh();
    if (api.indexers.length === 0) {
      log('No actions catalog in this workspace; Suite Authoring is inert.');
      return;
    }
    session.push(...api.indexers.map(ix => ix.onDidChangeIndex(() => {
      coverage.refresh();
      testing.refresh();
    })));
    const hintsChanged = new vscode.EventEmitter<void>();
    session.push(hintsChanged, ...api.indexers.map(ix => ix.onDidChangeIndex(() => hintsChanged.fire())));
    const providers = [registerHover(owner), ...registerNavigation(owner, () => api.indexers),
      registerInlayHints(owner, hintsChanged.event), registerCompletion(owner), registerScaffoldActions(owner), registerImplementLens(owner, hintsChanged.event),
      ...registerSuiteLanguage(owner, hintsChanged.event)];
    api.providerCount = 10;
    session.push(...providers);
    const first = api.indexers[0].layout.settings;
    if (gate.canRunWorkspaceCode()) status.setOk(first.lintTool, first.targetBinding);
    else status.setUntrusted();
    api.ready = Promise.all(api.indexers.map(ix => ix.start())).then(() => {
      coverage.refresh();
      testing.refresh();
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
      coverage,
    }),
    ...registerScaffoldCommands({
      owner,
      indexers: () => api.indexers,
      log,
      show: () => channel.show(true),
      gate,
      extensionPath: context.extensionPath,
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('bddSuite')) void rebuild();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(onTrustGranted),
  );
  await rebuild();
  return api;
}

/** INV-5: no child outlives the extension; no worker either. */
export function deactivate(): void {
  killAll();
  workerHost?.dispose();
}
