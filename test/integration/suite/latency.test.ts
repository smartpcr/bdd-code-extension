// session: worktree
// B8.3: live lint measured. Edit-to-published time on the sample's large.yml
// (about 1000 lines, 20 cases, 120 steps) with the typescript lint tool: 20 one-character edits, each after a pause of
// LIVE_LINT_DEBOUNCE_MS + 50 ms, with the worker warm; and the cold first lint,
// which includes import() and the schema load. O10 asks for p95 under 1 s.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { LIVE_LINT_DEBOUNCE_MS } from '../../../src/limits';
import { api, at, open, revert } from './helpers';
import { lint, nextLint, setting, typeScriptLibrary } from './lintHelpers';

const W = vscode.ConfigurationTarget.Workspace;
const large = () => at('test', 'e2e', 'suites', 'large.yml');

describe('B8.3 live lint latency on large.yml (typescript tool)', function () {
  this.timeout(600_000);

  before(async () => {
    await setting('lintTool', 'typescript', W, x => x.controllers[0].tool === 'typescript');
    if (!fs.existsSync(typeScriptLibrary())) assert.strictEqual(await vscode.commands.executeCommand<boolean>('bddSuite.buildLintTool'), true);
  });

  it('cold first lint, then 20 live edits: p50, p95 and max from edit to published', async () => {
    const a = await api();
    const doc = await open(large());
    assert.ok(doc.lineCount > 1000, `large.yml has ${doc.lineCount} lines`);
    // Let the lint that opening schedules finish first, so nothing supersedes the timed one.
    assert.strictEqual((await lint(large())).outcome, 'published');
    await new Promise(r => setTimeout(r, 1000));
    a.lintWorker.reload();
    const coldStart = Date.now();
    const cold = await a.controllers[0].lintNow(large());
    const coldMs = Date.now() - coldStart;
    assert.strictEqual(cold.outcome, 'published', cold.status);
    const startedWorkers = a.lintWorker.workersStarted;
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    const times: number[] = [];
    try {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, LIVE_LINT_DEBOUNCE_MS + 50));
        const next = nextLint(large().fsPath, 30_000, e => !!e.live && e.outcome === 'published');
        const edit = new vscode.WorkspaceEdit();
        edit.insert(large(), i === 0 ? new vscode.Position(end.line + 1, 0) : doc.lineAt(doc.lineCount - 1).range.end, i === 0 ? '#' : 'x');
        const started = Date.now();
        await vscode.workspace.applyEdit(edit);
        await next;
        times.push(Date.now() - started);
      }
    } finally {
      await revert(large());
    }
    assert.strictEqual(a.lintWorker.workersStarted, startedWorkers, 'warm: one worker served every edit');
    times.sort((x, y) => x - y);
    const p = (q: number) => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)];
    const [p50, p95, max] = [p(0.5), p(0.95), times[times.length - 1]];
    console.log(`    | typescript (live, worker) | ${p50} | ${p95} | ${max} | cold first lint ${coldMs} ms |`);
    console.log(`    debounce ${LIVE_LINT_DEBOUNCE_MS} ms; ${doc.getText().length} characters; ${os.cpus()[0].model}, ${os.cpus().length} logical CPUs; node ${process.version}`);
    assert.ok(p95 < 1000, `E-B14 / O10: p95 ${p95} ms is not under 1 s`);
  });

  after(async () => {
    await vscode.workspace.getConfiguration('bddSuite').update('lintTool', undefined, W);
  });
});
