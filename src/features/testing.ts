// Suites in Test Explorer (plan B6, DEC-B11): files, cases and outline rows as
// test items; a run or dry run of a file under the target binding, mapped from
// its trace; the lab path with its confirmation; cancellation that says what it
// leaves behind.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TrustGate } from '../config/trust';
import {
  aggregate, isLabSuite, ItemResult, mapDryRun, MappedRun, mapTrace, parseNUnit, parseTrace, reportedNames, selectionTags,
} from '../core/trace';
import { CaseInfo, SuiteFile } from '../core/types';
import { MAX_STDERR_BYTES } from '../limits';
import { LabValues, listCommand, runCommand } from '../tools/profiles';
import { runTool } from '../tools/runTool';
import { FolderIndexer, toRange } from './indexer';

/** The questions a run asks. Modal by default; the integration tests answer them (B6.4-1, B6.5-2). */
export interface RunUi {
  /** Missing lab values, asked one by one; undefined when the operator gives up. */
  askLab(have: LabValues, missing: (keyof LabValues)[]): Promise<LabValues | undefined>;
  /** The confirmation before a lab run (INV-6): true only on *Run*. */
  confirmLab(detail: { binding: string; labId: string; apiUrl: string; cases: string[] }): Promise<boolean>;
  /** Before a lab run is killed: true only on *Stop*. */
  confirmStop(): Promise<boolean>;
}

const LAB_KEYS: { key: keyof LabValues; setting: string; prompt: string }[] = [
  { key: 'apiUrl', setting: 'lab.apiUrl', prompt: 'The lab\'s lifecycle API URL' },
  { key: 'labId', setting: 'lab.labId', prompt: 'The lab\'s lineage id (the id the API records)' },
  { key: 'connectionFile', setting: 'lab.connectionFile', prompt: 'The lab\'s connection file' },
];

export const modalUi: RunUi = {
  async askLab(have, missing) {
    const out: LabValues = { ...have };
    for (const k of LAB_KEYS.filter(l => missing.includes(l.key))) {
      let value: string | undefined;
      if (k.key === 'connectionFile') {
        value = (await vscode.window.showOpenDialog({ title: k.prompt, canSelectMany: false, filters: { JSON: ['json'] } }))?.[0]?.fsPath;
      } else {
        value = await vscode.window.showInputBox({ prompt: k.prompt, ignoreFocusOut: true });
      }
      if (!value) return undefined;
      out[k.key] = value;
    }
    const save = await vscode.window.showInformationMessage('Save these lab values to the workspace settings?', 'Save', 'Not now');
    if (save === 'Save') {
      const config = vscode.workspace.getConfiguration('bddSuite');
      for (const k of LAB_KEYS.filter(l => missing.includes(l.key))) await config.update(k.setting, out[k.key], vscode.ConfigurationTarget.Workspace);
    }
    return out;
  },
  async confirmLab(d) {
    const pick = await vscode.window.showWarningMessage(`Run ${d.cases.length} case(s) against lab ${d.labId}?`, {
      modal: true,
      detail: `Binding: ${d.binding}\nLab: ${d.labId}\nAPI: ${d.apiUrl}\n\n${d.cases.join('\n')}`,
    }, 'Run');
    return pick === 'Run';
  },
  async confirmStop() {
    const pick = await vscode.window.showWarningMessage('The suite\'s cleanup and teardown may not run. Stop anyway?', { modal: true }, 'Stop');
    return pick === 'Stop';
  },
};

interface ItemData {
  ix: FolderIndexer;
  file: string;
  rel: string;
  /** Unset on a file item. */
  caseName?: string;
  /** Set on an outline row. */
  row?: string;
}

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const quoteArg = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

export class SuiteTesting implements vscode.Disposable {
  readonly controller = vscode.tests.createTestController('bddSuite', 'Suites');
  private readonly data = new WeakMap<vscode.TestItem, ItemData>();
  private byId = new Map<string, vscode.TestItem>();
  private readonly disposables: vscode.Disposable[] = [this.controller];
  ui: RunUi = modalUi;
  /** The last command line each file ran, as printed to the output channel (B6.4 item 4). */
  readonly lastCommand = new Map<string, string[]>();
  /** Each item's last result by id, for the integration tests: a TestRun's results cannot be read back. */
  readonly results = new Map<string, ItemResult>();
  /** The pid of each file's run while it runs. */
  readonly running = new Map<string, number>();
  readonly runProfile: vscode.TestRunProfile;
  readonly dryRunProfile: vscode.TestRunProfile;

  constructor(
    private readonly indexers: () => FolderIndexer[],
    private readonly storage: string,
    private readonly log: (line: string) => void,
    private readonly gate: TrustGate,
  ) {
    this.runProfile = this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (r, t) => this.run(r, t, false), true);
    this.dryRunProfile = this.controller.createRunProfile('Dry run', vscode.TestRunProfileKind.Run, (r, t) => this.run(r, t, true), false);
    this.disposables.push(this.runProfile, this.dryRunProfile);
  }

  /** Files, cases and outline rows from every folder's index (B6.1); libraries are not suites. */
  refresh(): void {
    // Items are kept by id and updated in place, so an item a run request or
    // the Test Explorer holds stays valid across the refresh every index change
    // causes (a replaced item makes createTestRun fail).
    const seen = new Map<string, vscode.TestItem>();
    // A suite lint rejects (two cases or two rows with one name, E213) still lists; its repeats are left out.
    const unique = (items: vscode.TestItem[]) => items.filter((it, i) => items.findIndex(x => x.id === it.id) === i);
    const item = (id: string, label: string, uri: vscode.Uri, data: ItemData): vscode.TestItem => {
      const old = this.byId.get(id);
      const it = old && old.uri?.toString() === uri.toString() ? old : this.controller.createTestItem(id, label, uri);
      it.label = label;
      this.data.set(it, data);
      seen.set(id, it);
      return it;
    };
    const files: vscode.TestItem[] = [];
    for (const ix of this.indexers()) {
      for (const suite of ix.index.suiteFiles()) {
        if (!suite.hasSuiteKey) continue;
        const rel = path.relative(ix.layout.root, suite.file).split(path.sep).join('/');
        const uri = vscode.Uri.file(suite.file);
        const fileItem = item(rel, rel, uri, { ix, file: suite.file, rel });
        const cases: vscode.TestItem[] = [];
        for (const c of suite.cases) {
          const caseItem = item(`${rel}::${c.name}`, c.name, uri, { ix, file: suite.file, rel, caseName: c.name });
          caseItem.range = toRange(c.range);
          caseItem.tags = [...new Set([...suite.tags, ...c.tags])].map(t => new vscode.TestTag(t));
          caseItem.children.replace(unique(c.examples.length ? reportedNames(c).map(name => {
            const row = item(`${rel}::${name}`, name.slice(c.name.length + 1), uri, { ix, file: suite.file, rel, caseName: c.name, row: name });
            row.range = caseItem.range;
            return row;
          }) : []));
          cases.push(caseItem);
        }
        fileItem.children.replace(unique(cases));
        files.push(fileItem);
      }
    }
    this.byId = seen;
    this.controller.items.replace(unique(files));
  }

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken, dryRun: boolean): Promise<void> {
    const run = this.controller.createTestRun(request);
    const excluded = new Set((request.exclude ?? []).map(i => i.id));
    const roots: vscode.TestItem[] = request.include ? [...request.include] : [];
    if (!request.include) this.controller.items.forEach(i => roots.push(i));
    const byFile = new Map<string, { fileItem: vscode.TestItem; cases: Set<string> }>();
    for (const item of roots) {
      const d = this.data.get(item);
      if (!d) continue;
      const fileItem = this.controller.items.get(d.rel);
      if (!fileItem) continue;
      const entry = byFile.get(d.rel) ?? { fileItem, cases: new Set<string>() };
      byFile.set(d.rel, entry);
      const caseItems: vscode.TestItem[] = [];
      if (d.caseName === undefined) fileItem.children.forEach(c => caseItems.push(c));
      else caseItems.push(fileItem.children.get(`${d.rel}::${d.caseName}`)!);
      for (const c of caseItems) if (!excluded.has(c.id)) entry.cases.add(this.data.get(c)!.caseName!);
    }
    try {
      for (const { fileItem, cases } of byFile.values()) {
        if (token.isCancellationRequested) break;
        await this.runFile(run, fileItem, cases, dryRun, token);
      }
    } finally {
      run.end();
    }
  }

  /** Every action the file's steps and its imported libraries' steps use, for B6.4 item 1. */
  private actionsOf(ix: FolderIndexer, suite: SuiteFile, seen = new Set<string>()): string[] {
    if (seen.has(suite.file)) return [];
    seen.add(suite.file);
    const own = suite.steps.flatMap(s => (s.action ? [s.action] : []));
    return [...own, ...suite.imports.flatMap(i => {
      const lib = ix.index.suite(i.resolved);
      return lib ? this.actionsOf(ix, lib, seen) : [];
    })];
  }

  private async runFile(run: vscode.TestRun, fileItem: vscode.TestItem, included: Set<string>, dryRun: boolean, token: vscode.CancellationToken): Promise<void> {
    const { ix, file, rel } = this.data.get(fileItem)!;
    const suite = ix.index.suite(file);
    const caseItems: vscode.TestItem[] = [];
    fileItem.children.forEach(c => caseItems.push(c));
    const leaves = (items: vscode.TestItem[]) => items.flatMap(c => (c.children.size ? [c, ...childrenOf(c)] : [c]));
    const chosen = caseItems.filter(c => included.has(this.data.get(c)!.caseName!));
    for (const item of leaves(chosen)) run.enqueued(item);
    const all = (state: 'errored' | 'skipped', message: string) => {
      for (const item of leaves(chosen)) {
        this.results.set(item.id, { state, message });
        if (state === 'errored') run.errored(item, new vscode.TestMessage(message));
        else run.skipped(item);
      }
      run.appendOutput(crlf(`${rel}: ${message}\n`));
    };
    const settings = ix.layout.settings;
    const binding = ix.layout.bindings.find(b => b.name === settings.targetBinding);
    if (!suite || !binding) return all('errored', !suite ? 'the suite is not indexed' : `no binding named ${settings.targetBinding}`);

    const cases = suite.cases.map((c: CaseInfo) => ({ name: c.name, tags: [...new Set([...suite.tags, ...c.tags])] }));
    const tags = selectionTags(cases, included);
    const testName = binding.kind === 'powershell' && tags === undefined && included.size === 1 ? [...included][0] : undefined;
    const lab = isLabSuite(this.actionsOf(ix, suite));
    let labValues: LabValues | undefined;
    if (lab) {
      labValues = { apiUrl: settings['lab.apiUrl'] || undefined, labId: settings['lab.labId'] || undefined, connectionFile: settings['lab.connectionFile'] || undefined };
      const missing = LAB_KEYS.map(k => k.key).filter(k => !labValues![k]);
      if (missing.length) labValues = await this.ui.askLab(labValues, missing);
      if (!labValues) return all('skipped', 'not run: the lab values were not given');
      const list = await runTool(listCommand(binding, ix.layout.root, rel, tags ?? []), undefined,
        { gate: () => this.gate.canRunWorkspaceCode(), maxStderr: MAX_STDERR_BYTES });
      if (list.kind !== 'exited' || list.code !== 0) {
        return all('errored', `not run: \`list\` failed (${list.kind === 'exited' ? `exit ${list.code}` : list.kind === 'failure' ? list.reason : 'cancelled'})`);
      }
      const lines = list.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const ok = await this.ui.confirmLab({ binding: binding.label, labId: labValues.labId ?? '', apiUrl: labValues.apiUrl ?? '', cases: lines });
      if (!ok) return all('skipped', 'not run: the lab run was not confirmed');
    }

    const dir = path.join(this.storage, 'runs', hash(rel));
    fs.mkdirSync(dir, { recursive: true });
    const traceFile = path.join(dir, 'trace.json');
    const resultsFile = path.join(dir, 'results.xml');
    for (const f of [traceFile, resultsFile]) fs.rmSync(f, { force: true });
    const cmd = runCommand(binding, ix.layout.root, rel, { traceFile, resultsFile, dryRun, tags, testName, lab: labValues });
    this.lastCommand.set(rel, cmd.argv);
    this.log(`Run (${binding.label}${dryRun ? ', dry run' : ''}${lab ? ', lab' : ''}) in ${cmd.cwd}: ${cmd.argv.map(quoteArg).join(' ')}`);
    if (binding.kind !== 'powershell' && included.size < suite.cases.length && !tags?.length) {
      run.appendOutput(crlf(`${binding.label} runs whole files; this run reports every case in ${rel}.\n`));
    }
    for (const item of leaves(chosen)) run.started(item);

    const stop = new vscode.CancellationTokenSource();
    // A lab run is killed only on Stop; otherwise it runs on and the Test Explorer run stays active (B6.5-2).
    // The token fires once, so a declined stop is final for this run.
    const sub = token.onCancellationRequested(async () => {
      if (!lab || await this.ui.confirmStop()) stop.cancel();
      else run.appendOutput(crlf(`${rel}: stop declined; the lab run continues to its end.\n`));
    });
    const result = await runTool({ ...cmd, onOutput: t => run.appendOutput(crlf(t)), onSpawn: pid => this.running.set(rel, pid) }, stop.token,
      { gate: () => this.gate.canRunWorkspaceCode(), maxStderr: MAX_STDERR_BYTES });
    this.running.delete(rel);
    sub.dispose();
    stop.dispose();
    if (result.kind === 'failure') return all('errored', `the run did not start (${result.reason}: ${result.detail})`);

    const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined);
    const report = parseNUnit(read(resultsFile) ?? '');
    const trace = parseTrace(read(traceFile) ?? '');
    let mapped: MappedRun;
    let missing: { state: 'errored' | 'skipped'; message: string };
    if (result.kind === 'cancelled') {
      mapped = trace ? mapTrace(trace, report) : { cases: new Map(), file: [] };
      missing = { state: 'skipped', message: 'cancelled' };
      run.appendOutput(crlf(`${rel}: cancelled; cases the trace does not report are marked skipped.\n`));
    } else if (dryRun) {
      if (!report.size && !trace) return all('errored', 'no report from the dry run');
      mapped = mapDryRun(report);
      missing = { state: 'skipped', message: 'not selected' };
    } else {
      if (!trace) return all('errored', 'no trace');
      mapped = mapTrace(trace, report);
      missing = { state: 'skipped', message: 'not reported by the run' };
    }
    this.apply(run, fileItem, caseItems, mapped, missing, chosen);
  }

  private apply(run: vscode.TestRun, fileItem: vscode.TestItem, caseItems: vscode.TestItem[], mapped: MappedRun,
    missing: { state: 'errored' | 'skipped'; message: string }, chosen: vscode.TestItem[]): void {
    const set = (item: vscode.TestItem, r: ItemResult) => {
      this.results.set(item.id, r);
      const message = new vscode.TestMessage(r.message ?? r.state);
      if (item.uri && item.range) message.location = new vscode.Location(item.uri, item.range);
      if (r.state === 'passed') run.passed(item);
      else if (r.state === 'failed') run.failed(item, message);
      else if (r.state === 'errored') run.errored(item, message);
      else run.skipped(item);
    };
    for (const caseItem of caseItems) {
      const d = this.data.get(caseItem)!;
      // A chosen item always gets a result; another one only when the run reports it (B6.2 item 3).
      const must = chosen.includes(caseItem);
      if (caseItem.children.size) {
        const states: ItemResult[] = [];
        caseItem.children.forEach(row => {
          const r = mapped.cases.get(this.data.get(row)!.row!);
          if (r) states.push(r);
          if (r) set(row, r);
          else if (must) set(row, { state: missing.state, message: missing.message });
        });
        const state = aggregate(states.map(s => s.state));
        if (state) set(caseItem, { state, message: states.filter(s => s.state === state).map(s => s.message).filter(Boolean).join('\n') || state });
        else if (must) set(caseItem, { state: missing.state, message: missing.message });
        continue;
      }
      const r = mapped.cases.get(d.caseName!);
      if (r) set(caseItem, r);
      else if (must) set(caseItem, { state: missing.state, message: missing.message });
    }
    if (mapped.file.length) {
      this.results.set(fileItem.id, { state: 'errored', message: mapped.file.join('\n') });
      run.errored(fileItem, new vscode.TestMessage(mapped.file.join('\n')));
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function childrenOf(item: vscode.TestItem): vscode.TestItem[] {
  const out: vscode.TestItem[] = [];
  item.children.forEach(c => out.push(c));
  return out;
}
