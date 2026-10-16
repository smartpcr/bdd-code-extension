// Lint on open and save through the lint tool's program (plan B2.2-B2.4), or,
// for a binding with a library, through the lint worker on open, save and
// every pause in typing (B8.1, B8.2). One controller per workspace folder; it
// owns the results it publishes.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ResolvedBinding } from '../config/layout';
import { TrustGate } from '../config/trust';
import { Debouncer } from '../core/debounce';
import { LintResults, parseLintOutput, Published, RawDiagnostic, selectOverlays, tokenEnd, toZeroBased } from '../core/diagnostics';
import { fileKey } from '../core/paths';
import { LIVE_LINT_DEBOUNCE_MS, LINT_DEBOUNCE_MS, LINT_TIMEOUT_MS, MAX_STDERR_BYTES } from '../limits';
import { LintWorkerHost, workerFailureText } from '../lint/workerHost';
import { lintCommand } from '../tools/profiles';
import { runTool, ToolResult } from '../tools/runTool';
import { FolderIndexer } from './indexer';
import { SuiteStatusBar } from './statusBar';

export type LintOutcome = 'published' | 'failed' | 'cancelled' | 'superseded';

export interface LintEvent {
  file: string;
  outcome: LintOutcome;
  status?: string;
  /** A lint on a pause in typing (B8.2). */
  live?: boolean;
}

/** The status text for each failure kind (B2.4-2). */
export function failureText(tool: string, result: ToolResult | { kind: 'bad'; detail: string }): string {
  if (result.kind === 'bad') return 'Lint output was not diagnostics';
  if (result.kind !== 'failure') return '';
  switch (result.reason) {
    case 'not-found': return `Lint: ${tool} not built`;
    case 'timeout': return `Lint timed out after ${Math.round(LINT_TIMEOUT_MS / 1000)} s`;
    case 'oversize': return 'Lint output too large';
    case 'untrusted': return 'Suite: untrusted, lint and run disabled';
    default: return `Lint could not start ${tool}`;
  }
}

/** What a back end makes of one lint. */
type BackendOutcome =
  | { kind: 'diagnostics'; raw: RawDiagnostic[] }
  | { kind: 'failed'; status: string; detail: string; notBuilt: boolean }
  | { kind: 'cancelled' }
  | { kind: 'superseded' };

interface LintJob {
  key: string;
  rel: string;
  binding: ResolvedBinding;
  root: string;
  target: string;
  token: vscode.CancellationToken;
  live: boolean;
}

/** One way of linting a file; everything after the result is shared (plan B8, INV-3, INV-4). */
interface LintBackend {
  /** Whether a pause in typing lints (the worker can lint unsaved text; a program cannot). */
  readonly live: boolean;
  lint(job: LintJob): Promise<BackendOutcome>;
}

/** B2's path: the binding's program on the saved file. */
class ProgramBackend implements LintBackend {
  readonly live = false;
  constructor(private readonly gate: TrustGate) {}

  async lint(job: LintJob): Promise<BackendOutcome> {
    let command;
    try {
      command = lintCommand(job.binding, job.root, job.rel, job.target);
    } catch (e) {
      return { kind: 'failed', status: `Lint: ${(e as Error).message}`, detail: (e as Error).message, notBuilt: false };
    }
    const result = await runTool(command, job.token, { gate: () => this.gate.canRunWorkspaceCode(), maxStderr: MAX_STDERR_BYTES });
    if (result.kind === 'cancelled') return { kind: 'cancelled' };
    const detail = (extra: string) =>
      `${extra}\n  argv: ${JSON.stringify(command.argv)}\n  cwd: ${command.cwd}\n  stderr: ${result.stderrTail.trim()}`;
    if (result.kind === 'failure') {
      return { kind: 'failed', status: failureText(job.binding.name, result), detail: detail(`Lint failed (${result.reason}): ${result.detail}`),
        notBuilt: result.reason === 'not-found' };
    }
    const parsed = parseLintOutput(result.stdout, result.code);
    if (!parsed.ok) {
      return { kind: 'failed', status: failureText(job.binding.name, { kind: 'bad', detail: parsed.detail }),
        detail: detail(`Lint output was not diagnostics (${parsed.detail}), exit code ${result.code}`), notBuilt: false };
    }
    return { kind: 'diagnostics', raw: parsed.value };
  }
}

/** B8's path: the binding's library in the lint worker, with the editor's unsaved text as overlays. */
class WorkerBackend implements LintBackend {
  readonly live = true;
  constructor(private readonly host: LintWorkerHost, private readonly overlays: () => Record<string, string>) {}

  async lint(job: LintJob): Promise<BackendOutcome> {
    const libraryPath = path.resolve(job.root, job.binding.library!);
    const r = await this.host.lint(job.key, libraryPath, job.root, {
      paths: [job.key], binding: job.target, bindingCheck: true, strict: false, overlays: this.overlays(),
    }, { live: job.live });
    if (r.kind === 'superseded') return r;
    if (r.kind === 'failure') {
      return { kind: 'failed', status: workerFailureText(job.binding.name, r),
        detail: `Lint failed (${r.reason}): ${r.detail}\n  library: ${libraryPath}`, notBuilt: r.reason === 'not-found' };
    }
    // The same shape check as a program's output, so both paths are held to diagnostic.schema.json (2.4b item 7).
    const parsed = parseLintOutput(JSON.stringify(r.diagnostics), 0);
    if (!parsed.ok) {
      return { kind: 'failed', status: failureText(job.binding.name, { kind: 'bad', detail: parsed.detail }),
        detail: `Lint output was not diagnostics (${parsed.detail})\n  library: ${libraryPath}`, notBuilt: false };
    }
    return { kind: 'diagnostics', raw: parsed.value };
  }
}

export class LintController implements vscode.Disposable {
  private readonly running = new Map<string, { source: vscode.CancellationTokenSource; generation: number }>();
  private generation = 0;
  private readonly debouncer = new Debouncer(LINT_DEBOUNCE_MS);
  private readonly liveDebouncer = new Debouncer(LIVE_LINT_DEBOUNCE_MS);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<LintEvent>();
  readonly onDidLint = this.emitter.event;
  /** How many lints were started, by program or worker (B2.2-2, E-B15). */
  lintsStarted = 0;
  private readonly notified = new Set<string>();
  private disposed = false;
  private readonly programBackend: ProgramBackend;
  private readonly workerBackend: WorkerBackend;

  constructor(
    private readonly indexer: FolderIndexer,
    readonly results: LintResults,
    private readonly collection: vscode.DiagnosticCollection,
    private readonly log: (line: string) => void,
    private readonly status: SuiteStatusBar,
    private readonly gate: TrustGate,
    private readonly notify: (tool: string) => void,
    readonly workerHost: LintWorkerHost,
  ) {
    this.programBackend = new ProgramBackend(gate);
    this.workerBackend = new WorkerBackend(workerHost, () => this.overlays());
    const schemaDir = path.join(indexer.layout.root, 'test', 'e2e', 'schema');
    const watchers = [
      vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(schemaDir, 'suite.schema.json')),
      vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(indexer.layout.catalogPath), path.basename(indexer.layout.catalogPath))),
    ];
    const invalidate = () => workerHost.invalidate(indexer.layout.root);
    // The lint tool's library: a rebuild or any change to its files means the
    // worker's loaded copy is old, so the next lint starts a new worker.
    const library = this.binding()?.library;
    if (library) {
      const dir = path.dirname(path.resolve(indexer.layout.root, library));
      const lib = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '**/*.js'));
      const reload = () => workerHost.reload();
      watchers.push(lib);
      this.disposables.push(lib.onDidChange(reload), lib.onDidCreate(reload), lib.onDidDelete(reload));
    }
    this.disposables.push(
      this.emitter,
      vscode.workspace.onDidOpenTextDocument(d => this.schedule(d.uri)),
      vscode.workspace.onDidSaveTextDocument(d => this.schedule(d.uri)),
      vscode.workspace.onDidChangeTextDocument(e => this.scheduleLive(e.document.uri)),
      ...watchers, ...watchers.flatMap(w => [w.onDidChange(invalidate), w.onDidCreate(invalidate), w.onDidDelete(invalidate)]),
    );
  }

  get tool(): string {
    return this.indexer.layout.settings.lintTool;
  }

  get target(): string {
    return this.indexer.layout.settings.targetBinding;
  }

  private binding(): ResolvedBinding | undefined {
    return this.indexer.layout.bindings.find(b => b.name === this.tool);
  }

  /** The worker when the lint tool has a library (plan B8), the program otherwise. */
  private backend(binding: ResolvedBinding): LintBackend {
    return binding.library ? this.workerBackend : this.programBackend;
  }

  private isSuite(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && this.indexer.index.isLintCandidate(uri.fsPath);
  }

  /** Every dirty suite or library open in the window (B8.2 item 2). */
  private overlays(): Record<string, string> {
    return selectOverlays(
      vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file')
        .map(d => ({ path: d.uri.fsPath, text: d.getText(), dirty: d.isDirty })),
      p => this.indexer.index.isLintCandidate(p));
  }

  /** Lint after LINT_DEBOUNCE_MS, once per burst (B2.2-2). */
  schedule(uri: vscode.Uri): void {
    if (!this.isSuite(uri)) return;
    // A library is linted through the suites that import it.
    for (const t of this.indexer.index.lintTargets(uri.fsPath)) this.debouncer.schedule(t, () => void this.lintNow(vscode.Uri.file(t)));
  }

  /**
   * A pause in typing (B8.2): with the worker, lint the edited file and every
   * open file that imports it after LIVE_LINT_DEBOUNCE_MS. With a program,
   * nothing (B8.2-3).
   */
  scheduleLive(uri: vscode.Uri): void {
    const binding = this.binding();
    if (!binding || !this.backend(binding).live || !this.isSuite(uri)) return;
    const index = this.indexer.index;
    const open = new Set(vscode.workspace.textDocuments.map(d => fileKey(d.uri.fsPath)));
    const targets = new Set([...index.lintTargets(uri.fsPath), ...index.importersOf(uri.fsPath).filter(f => open.has(f) && !index.isLibrary(f))]);
    for (const t of targets) this.liveDebouncer.schedule(t, () => void this.lintNow(vscode.Uri.file(t), { live: true }));
  }

  /** Lint every open suite now, and for an open library the suites that import it (start, tool or target change, trust granted). */
  lintOpen(): void {
    const targets = new Set(vscode.workspace.textDocuments.filter(d => this.isSuite(d.uri)).flatMap(d => this.indexer.index.lintTargets(d.uri.fsPath)));
    for (const t of targets) void this.lintNow(vscode.Uri.file(t));
  }

  async lintNow(uri: vscode.Uri, o: { live?: boolean } = {}): Promise<LintEvent> {
    const key = fileKey(uri.fsPath);
    const layout = this.indexer.layout;
    const live = !!o.live;
    this.running.get(key)?.source.cancel();
    const generation = ++this.generation;
    const source = new vscode.CancellationTokenSource();
    this.running.set(key, { source, generation });
    const done = (event: LintEvent): LintEvent => {
      if (this.running.get(key)?.generation === generation) this.running.delete(key);
      source.dispose();
      if (live) event.live = true;
      this.emitter.fire(event);
      return event;
    };

    const binding = this.binding();
    if (!binding) {
      return done(this.fail(key, `Lint: no binding named ${this.tool}`, `bddSuite.lintTool names ${this.tool}, which is not a configured binding.`));
    }
    if (!this.gate.canRunWorkspaceCode()) {
      this.status.setUntrusted();
      return done({ file: key, outcome: 'failed', status: this.gate.untrustedText });
    }
    const rel = path.relative(layout.root, key).split(path.sep).join('/');
    this.lintsStarted++;
    const r = await this.backend(binding).lint({ key, rel, binding, root: layout.root, target: this.target, token: source.token, live });
    if (r.kind === 'cancelled') return done({ file: key, outcome: 'cancelled' });
    if (r.kind === 'superseded' || this.running.get(key)?.generation !== generation) return done({ file: key, outcome: 'superseded' });
    if (r.kind === 'failed') {
      if (r.notBuilt) this.notifyOnce();
      return done(this.fail(key, r.status, r.detail));
    }
    // A controller replaced by a settings rebuild must not write its late result into
    // the shared results or the shared collection (found by B3's regression run).
    if (this.disposed) return done({ file: key, outcome: 'superseded' });
    const changed = this.results.replace(key, r.raw.map(d => toZeroBased(d, layout.root)));
    this.publish(changed);
    this.status.setOk(this.tool, this.target);
    return done({ file: key, outcome: 'published' });
  }

  private notifyOnce(): void {
    if (this.notified.has(this.tool)) return;
    this.notified.add(this.tool);
    this.notify(this.tool);
  }

  private fail(key: string, status: string, detail: string): LintEvent {
    if (this.disposed) return { file: key, outcome: 'superseded' };
    this.log(detail);
    this.publish(this.results.markStale(key));
    this.status.setFailure(status);
    return { file: key, outcome: 'failed', status };
  }

  private lineOf(file: string, line: number): string {
    const open = vscode.workspace.textDocuments.find(d => fileKey(d.uri.fsPath) === file);
    if (open) return line < open.lineCount ? open.lineAt(line).text : '';
    try {
      return fs.readFileSync(file, 'utf8').split(/\r?\n/)[line] ?? '';
    } catch {
      return '';
    }
  }

  private toDiagnostic(p: Published): vscode.Diagnostic {
    const d = p.diagnostic;
    const end = tokenEnd(this.lineOf(d.file, d.line), d.character);
    const message = `${p.stale ? '[stale] ' : ''}${d.message}${d.suggestion ? `\n${d.suggestion}` : ''}`;
    const out = new vscode.Diagnostic(new vscode.Range(d.line, d.character, d.line, Math.max(end, d.character)), message,
      d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
    out.code = d.code;
    out.source = `suiterun:${this.tool}`;
    return out;
  }

  private publish(files: string[]): void {
    for (const f of files) this.collection.set(vscode.Uri.file(f), this.results.forFile(f).map(p => this.toDiagnostic(p)));
  }

  dispose(): void {
    this.disposed = true;
    this.debouncer.dispose();
    this.liveDebouncer.dispose();
    for (const r of this.running.values()) r.source.cancel();
    for (const d of this.disposables) d.dispose();
  }
}
