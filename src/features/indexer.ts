// Keeps one folder's WorkspaceIndex current (plan B1.3, B1.4, B1.7): the
// initial scan, file-system watchers, and debounced re-parse of open buffers.
import * as path from 'path';
import { minimatch } from 'minimatch';
import * as vscode from 'vscode';
import { ResolvedBinding, WorkspaceLayout } from '../config/layout';
import * as fs from 'fs';
import { resolveCatalog } from '../core/catalog';
import { Debouncer } from '../core/debounce';
import { fileKey } from '../core/paths';
import { CompiledRecognizer, compileRecognizers, scanRegistrations } from '../core/registrations';
import { parseSuite } from '../core/suites';
import { Range } from '../core/text';
import { CoreError } from '../core/types';
import { WorkspaceIndex } from '../core/workspaceIndex';
import { INDEX_DEBOUNCE_MS, MAX_INDEXED_FILE_BYTES } from '../limits';

export const toRange = (r: Range): vscode.Range =>
  new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);

type Kind = { kind: 'catalog' } | { kind: 'suite' } | { kind: 'source'; binding: ResolvedBinding };

/** An imported catalog's text, or undefined when it cannot be read. */
function readSync(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export class FolderIndexer implements vscode.Disposable {
  readonly index = new WorkspaceIndex();
  private readonly recognizers = new Map<string, CompiledRecognizer[]>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly debouncer = new Debouncer(INDEX_DEBOUNCE_MS);
  private readonly changeDebouncer = new Debouncer(INDEX_DEBOUNCE_MS);
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  /** Fires once per INDEX_DEBOUNCE_MS after any index update (B1.7 item 4). */
  readonly onDidChangeIndex = this.changedEmitter.event;
  private pendingReads = 0;
  /** Watchers on the files the catalog imports (DEC-S10), replaced whenever the catalog is re-read. */
  private importWatchers: vscode.Disposable[] = [];
  private markReady!: () => void;
  /** Resolves when the initial scan is done; providers wait on it, so a rebuild never answers from an empty index. */
  readonly ready: Promise<void> = new Promise(resolve => { this.markReady = resolve; });

  constructor(
    readonly layout: WorkspaceLayout,
    private readonly log: (line: string) => void,
    private readonly catalogDiagnostics: vscode.DiagnosticCollection,
    private readonly indexDiagnostics: vscode.DiagnosticCollection,
    /** Called when the catalog's `bindingSources` no longer match the layout's: the sources to scan changed. */
    private readonly onSourcesChanged?: () => void,
  ) {
    for (const b of layout.bindings) {
      const { ok, errors } = compileRecognizers(b.recognizers, `bddSuite.bindings.${b.name}.recognizers`);
      this.recognizers.set(b.name, ok);
      for (const e of errors) {
        log(e);
        void vscode.window.showWarningMessage(`Suite Authoring: ${e}`);
      }
    }
    this.disposables.push(this.index.onDidChange(() =>
      this.changeDebouncer.schedule('index', () => this.changedEmitter.fire())));
  }

  /** Relative path with forward slashes, or undefined outside the folder. */
  private rel(file: string): string | undefined {
    const r = path.relative(this.layout.folder, file);
    return r.startsWith('..') || path.isAbsolute(r) ? undefined : r.split(path.sep).join('/');
  }

  classify(file: string): Kind | undefined {
    const key = fileKey(file);
    if (key === this.layout.catalogPath) return { kind: 'catalog' };
    const rel = this.rel(key);
    if (rel === undefined || minimatch(rel, this.layout.exclude, { dot: true })) return undefined;
    if (this.layout.suiteGlobs.some(g => minimatch(rel, g, { dot: true }))) return { kind: 'suite' };
    for (const b of this.layout.bindings) {
      if (b.sources.some(g => minimatch(rel, g, { dot: true }))
        && !b.exclude.some(g => minimatch(rel, g, { dot: true }))) return { kind: 'source', binding: b };
    }
    return undefined;
  }

  private async read(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > MAX_INDEXED_FILE_BYTES) {
      this.log(`Skipped ${uri.fsPath}: ${bytes.byteLength} bytes is over the ${MAX_INDEXED_FILE_BYTES}-byte limit.`);
      return undefined;
    }
    return new TextDecoder().decode(bytes);
  }

  private publish(collection: vscode.DiagnosticCollection, file: string, errors: CoreError[]): void {
    collection.set(vscode.Uri.file(file), errors.map(e => {
      const d = new vscode.Diagnostic(toRange(e.range), e.message, vscode.DiagnosticSeverity.Error);
      d.source = 'bddSuite';
      d.code = e.code;
      return d;
    }));
  }

  /** Index one file from its text. */
  apply(file: string, text: string): void {
    const kind = this.classify(file);
    const key = fileKey(file);
    if (!kind) return;
    if (kind.kind === 'catalog') {
      const c = resolveCatalog(text, key, readSync);
      this.index.updateCatalog(c);
      this.publish(this.catalogDiagnostics, key, c.errors);
      this.watchImports(c.imports ?? []);
      if (JSON.stringify(c.sources ?? null) !== JSON.stringify(this.layout.catalogSources ?? null)) this.onSourcesChanged?.();
    } else if (kind.kind === 'suite') {
      const s = parseSuite(text, key);
      this.index.updateSuite(s);
      this.publish(this.indexDiagnostics, key, s.parseError ? [s.parseError] : []);
    } else {
      this.index.updateSources(key, scanRegistrations(text, key, kind.binding.name,
        this.recognizers.get(kind.binding.name) ?? []));
    }
  }

  async load(uri: vscode.Uri): Promise<void> {
    this.pendingReads++;
    try {
      const text = await this.read(uri);
      if (text !== undefined) this.apply(uri.fsPath, text);
    } catch (e) {
      this.log(`Could not read ${uri.fsPath}: ${(e as Error).message}`);
    } finally {
      this.pendingReads--;
    }
  }

  remove(uri: vscode.Uri): void {
    const kind = this.classify(uri.fsPath);
    if (kind?.kind === 'suite') {
      this.index.removeSuite(uri.fsPath);
      this.indexDiagnostics.delete(uri);
    } else if (kind?.kind === 'source') this.index.removeSources(uri.fsPath);
  }

  private globs(): string[] {
    return [...this.layout.suiteGlobs, ...this.layout.bindings.flatMap(b => b.sources)];
  }

  start(): Promise<void> {
    const folder = vscode.Uri.file(this.layout.folder);
    const scan = (async () => {
      const started = Date.now();
      await this.load(vscode.Uri.file(this.layout.catalogPath));
      const found = await Promise.all(this.globs().map(g =>
        vscode.workspace.findFiles(new vscode.RelativePattern(folder, g), this.layout.exclude)));
      const uris = [...new Map(found.flat().map(u => [fileKey(u.fsPath), u])).values()];
      await Promise.all(uris.map(u => this.load(u)));
      const c = this.index.catalog;
      this.log(`Indexed ${c?.actions.size ?? 0} catalog actions, ${this.index.suiteFiles().length} suites and libraries, `
        + `${this.index.allSites().length} registration sites in ${Date.now() - started} ms.`);
    })().finally(() => this.markReady());
    for (const glob of [path.relative(this.layout.folder, this.layout.catalogPath).split(path.sep).join('/'), ...this.globs()]) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, glob));
      this.disposables.push(w,
        w.onDidCreate(u => void this.load(u)),
        w.onDidChange(u => void this.load(u)),
        w.onDidDelete(u => this.remove(u)));
    }
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.scheme !== 'file' || !this.classify(e.document.uri.fsPath)) return;
        const doc = e.document;
        this.debouncer.schedule(fileKey(doc.uri.fsPath), () => this.apply(doc.uri.fsPath, doc.getText()));
      }),
      vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.uri.scheme === 'file' && doc.isDirty && this.classify(doc.uri.fsPath)) void this.load(doc.uri);
      }),
    );
    return scan;
  }

  /** Re-reads the catalog when a file it imports changes, wherever that file is (a pinned submodule, say). */
  private watchImports(files: string[]): void {
    for (const w of this.importWatchers) w.dispose();
    this.importWatchers = files.flatMap(f => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(f)), path.basename(f)));
      const reload = () => void this.load(vscode.Uri.file(this.layout.catalogPath));
      return [w, w.onDidCreate(reload), w.onDidChange(reload), w.onDidDelete(reload)];
    });
  }

  /** True when no read or debounced re-parse is pending (for tests). */
  get idle(): boolean {
    return this.pendingReads === 0 && this.debouncer.size === 0 && this.changeDebouncer.size === 0;
  }

  dispose(): void {
    this.markReady();
    for (const w of this.importWatchers) w.dispose();
    this.debouncer.dispose();
    this.changeDebouncer.dispose();
    this.changedEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
