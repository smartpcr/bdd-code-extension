// Lint on open and save through the lint tool's program (plan B2.2-B2.4).
// One controller per workspace folder; it owns the results it publishes.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ResolvedBinding } from '../config/layout';
import { TrustGate } from '../config/trust';
import { Debouncer } from '../core/debounce';
import { LintResults, parseLintOutput, Published, tokenEnd, toZeroBased } from '../core/diagnostics';
import { fileKey } from '../core/paths';
import { LINT_DEBOUNCE_MS, LINT_TIMEOUT_MS, MAX_STDERR_BYTES } from '../limits';
import { lintCommand } from '../tools/profiles';
import { runTool, ToolResult } from '../tools/runTool';
import { FolderIndexer } from './indexer';
import { SuiteStatusBar } from './statusBar';

export type LintOutcome = 'published' | 'failed' | 'cancelled' | 'superseded';

export interface LintEvent {
  file: string;
  outcome: LintOutcome;
  status?: string;
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

export class LintController implements vscode.Disposable {
  private readonly running = new Map<string, { source: vscode.CancellationTokenSource; generation: number }>();
  private generation = 0;
  private readonly debouncer = new Debouncer(LINT_DEBOUNCE_MS);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<LintEvent>();
  readonly onDidLint = this.emitter.event;
  /** How many lint processes were started (B2.2-2). */
  lintsStarted = 0;
  private readonly notified = new Set<string>();

  constructor(
    private readonly indexer: FolderIndexer,
    readonly results: LintResults,
    private readonly collection: vscode.DiagnosticCollection,
    private readonly log: (line: string) => void,
    private readonly status: SuiteStatusBar,
    private readonly gate: TrustGate,
    private readonly notify: (tool: string) => void,
  ) {
    this.disposables.push(
      this.emitter,
      vscode.workspace.onDidOpenTextDocument(d => this.schedule(d.uri)),
      vscode.workspace.onDidSaveTextDocument(d => this.schedule(d.uri)),
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

  private isSuite(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && this.indexer.index.isLintCandidate(uri.fsPath);
  }

  /** Lint after LINT_DEBOUNCE_MS, once per burst (B2.2-2). */
  schedule(uri: vscode.Uri): void {
    if (!this.isSuite(uri)) return;
    this.debouncer.schedule(fileKey(uri.fsPath), () => void this.lintNow(uri));
  }

  /** Lint every open suite or library now (start, tool or target change, trust granted). */
  lintOpen(): void {
    for (const d of vscode.workspace.textDocuments) if (this.isSuite(d.uri)) void this.lintNow(d.uri);
  }

  async lintNow(uri: vscode.Uri): Promise<LintEvent> {
    const key = fileKey(uri.fsPath);
    const layout = this.indexer.layout;
    this.running.get(key)?.source.cancel();
    const generation = ++this.generation;
    const source = new vscode.CancellationTokenSource();
    this.running.set(key, { source, generation });
    const done = (event: LintEvent): LintEvent => {
      if (this.running.get(key)?.generation === generation) this.running.delete(key);
      source.dispose();
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
    let command;
    try {
      command = lintCommand(binding, layout.root, rel, this.target);
    } catch (e) {
      return done(this.fail(key, `Lint: ${(e as Error).message}`, (e as Error).message));
    }
    this.lintsStarted++;
    const result = await runTool(command, source.token, { gate: () => this.gate.canRunWorkspaceCode(), maxStderr: MAX_STDERR_BYTES });
    if (result.kind === 'cancelled' || this.running.get(key)?.generation !== generation) {
      return done({ file: key, outcome: result.kind === 'cancelled' ? 'cancelled' : 'superseded' });
    }
    const detail = (extra: string) =>
      `${extra}\n  argv: ${JSON.stringify(command.argv)}\n  cwd: ${command.cwd}\n  stderr: ${result.stderrTail.trim()}`;
    if (result.kind === 'failure') {
      if (result.reason === 'not-found') this.notifyOnce();
      return done(this.fail(key, failureText(this.tool, result), detail(`Lint failed (${result.reason}): ${result.detail}`)));
    }
    const parsed = parseLintOutput(result.stdout, result.code);
    if (!parsed.ok) {
      return done(this.fail(key, failureText(this.tool, { kind: 'bad', detail: parsed.detail }),
        detail(`Lint output was not diagnostics (${parsed.detail}), exit code ${result.code}`)));
    }
    const changed = this.results.replace(key, parsed.value.map(d => toZeroBased(d, layout.root)));
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
    this.debouncer.dispose();
    for (const r of this.running.values()) r.source.cancel();
    for (const d of this.disposables) d.dispose();
  }
}
