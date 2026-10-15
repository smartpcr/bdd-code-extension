// session: worktree
// B8.2 and E-B14: with the typescript lint tool, a pause in typing lints the
// editor's unsaved text through overlays, and the answer is the one the saved
// file would get. Nothing is written to disk to do it (INV-12).
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseLintOutput } from '../../../src/core/diagnostics';
import type { LintEvent } from '../../../src/features/lintController';
import { lintCommand } from '../../../src/tools/profiles';
import { runTool } from '../../../src/tools/runTool';
import { sig, validateEntries } from '../harness/corpus';
import { api, at, folder, hasTypeScript, open, revert, within } from './helpers';
import { nextLint, setting, shown, typeScriptLibrary } from './lintHelpers';

const W = vscode.ConfigurationTarget.Workspace;
const CLEAN = `suite: scratch-b14
imports: [_lib/lifecycle.yml, _lib/_scratch-b14-lib.yml]
tests:
  - name: typed
    steps:
      - meta: select-lab
      - meta: scratch-meta
      - action: core.set
        value: \${capture.source.id}
`;
const LIB = `metaSteps:
  - name: scratch-meta
    steps:
      - action: core.noop
`;
const scratch = () => at('test', 'e2e', 'suites', '_scratch-b14.yml');
const scratchLib = () => at('test', 'e2e', 'suites', '_lib', '_scratch-b14-lib.yml');
const live = (e: LintEvent) => !!e.live;
const gitStatus = () => execFileSync('git', ['-C', folder(), 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });

async function replaceAll(uri: vscode.Uri, text: string): Promise<void> {
  const doc = await open(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

describe('B8.2 live lint of unsaved buffers, and E-B14', function () {
  this.timeout(900_000);
  let baseline = '';

  before(async function () {
    if (!hasTypeScript()) this.skip();
    await setting('lintTool', 'typescript', W, x => x.controllers[0].tool === 'typescript');
    if (!fs.existsSync(typeScriptLibrary())) assert.strictEqual(await vscode.commands.executeCommand<boolean>('bddSuite.buildLintTool'), true);
    // The scratch suite and library, saved once: the only change E-B14 allows in git status.
    fs.writeFileSync(scratch().fsPath, CLEAN);
    fs.writeFileSync(scratchLib().fsPath, LIB);
    baseline = gitStatus();
    const a = await api();
    await within(10_000, () => a.indexers[0].index.isSuiteOrLibrary(scratchLib().fsPath));
    await open(scratchLib());
    const first = nextLint(scratch().fsPath, 30_000, e => e.outcome === 'published');
    await open(scratch());
    await first;
    assert.deepStrictEqual(shown(scratch()), [], 'the scratch suite is clean');
  });

  it('B8.2-1 typing ${capture.nosuch} shows E301 at its position before any save; the imported meta is found', async () => {
    const doc = await open(scratch());
    const at9 = doc.lineAt(8).text.indexOf('${capture.source.id}');
    const next = nextLint(scratch().fsPath, 30_000, e => live(e) && e.outcome === 'published');
    const started = Date.now();
    const edit = new vscode.WorkspaceEdit();
    edit.replace(scratch(), new vscode.Range(8, at9, 8, at9 + '${capture.source.id}'.length), '${capture.nosuch}');
    await vscode.workspace.applyEdit(edit);
    await next;
    const took = Date.now() - started;
    assert.strictEqual(doc.isDirty, true, 'not saved');
    const got = shown(scratch()).map(d => d.sig);
    assert.ok(got.includes(`E301 error 9:${at9 + 1}`), got.join(', '));
    assert.ok(!got.some(s => s.startsWith('E206')), 'select-lab from _lib/lifecycle.yml is not reported missing');
    console.log(`    E301 at 9:${at9 + 1}, published ${took} ms after the edit, unsaved`);
    const back = nextLint(scratch().fsPath, 30_000, e => live(e) && e.outcome === 'published');
    await replaceAll(scratch(), CLEAN);
    await back;
    assert.deepStrictEqual(shown(scratch()), []);
  });

  it('B8.2-2 an unsaved edit to an imported library re-lints the open suite that imports it', async () => {
    const libDoc = await open(scratchLib());
    const next = nextLint(scratch().fsPath, 30_000, e => live(e) && e.outcome === 'published');
    await replaceAll(scratchLib(), LIB.replace('scratch-meta', 'renamed-meta'));
    await next;
    assert.strictEqual(libDoc.isDirty, true);
    const got = shown(scratch());
    assert.ok(got.some(d => d.sig === 'E206 error 7:15' && /scratch-meta/.test(d.message)), JSON.stringify(got));
    const back = nextLint(scratch().fsPath, 30_000, e => live(e) && e.outcome === 'published');
    await replaceAll(scratchLib(), LIB);
    await back;
    assert.deepStrictEqual(shown(scratch()), []);
  });

  it('B8.2-3 with a program as the lint tool, typing lints nothing', async () => {
    const a = await setting('lintTool', 'go', W, x => x.controllers[0].tool === 'go');
    try {
      await new Promise(r => setTimeout(r, 1500));
      const c = a.controllers[0];
      const before = c.lintsStarted;
      const doc = await open(scratch());
      const edit = new vscode.WorkspaceEdit();
      edit.insert(scratch(), new vscode.Position(doc.lineCount, 0), '# typed\n');
      await vscode.workspace.applyEdit(edit);
      await new Promise(r => setTimeout(r, 2000));
      assert.strictEqual(c.lintsStarted, before, 'no lint on a pause in typing');
      await replaceAll(scratch(), CLEAN);
    } finally {
      await setting('lintTool', 'typescript', W, x => x.controllers[0].tool === 'typescript');
    }
  });

  it('E-B14 each validate entry\'s text, unsaved in the scratch buffer, gets the saved file\'s diagnostics', async () => {
    const a = await api();
    const { entries } = validateEntries(folder());
    entries.sort((x, y) => x.target.localeCompare(y.target));
    const binding = a.indexers[0].layout.bindings.find(b => b.name === 'typescript')!;
    const times: number[] = [];
    const mismatches: string[] = [];
    const bySaved: string[] = [];
    for (const e of entries) {
      let c = (await api()).controllers[0];
      if (c.target !== e.target) c = (await setting('targetBinding', e.target, W, x => x.controllers[0].target === e.target)).controllers[0];
      const text = fs.readFileSync(path.join(folder(), e.rel), 'utf8');
      const next = nextLint(scratch().fsPath, 30_000, x => live(x) && x.outcome === 'published');
      const started = Date.now();
      await replaceAll(scratch(), text);
      await next;
      times.push(Date.now() - started);
      const got = shown(scratch()).map(d => d.sig);
      const want = e.diagnostics.map(sig);
      if (JSON.stringify(got) === JSON.stringify(want)) continue;
      // The expectation depends on the entry's own name or relative imports:
      // compare with the program's lint of the same text saved at the scratch path.
      fs.writeFileSync(scratch().fsPath, text);
      try {
        const r = await runTool(lintCommand(binding, a.indexers[0].layout.root, 'test/e2e/suites/_scratch-b14.yml', e.target));
        assert.strictEqual(r.kind, 'exited', e.suite);
        const parsed = parseLintOutput((r as { stdout: string }).stdout, (r as { code: number }).code);
        assert.ok(parsed.ok, e.suite);
        const saved = parsed.value.filter(d => d.file === 'test/e2e/suites/_scratch-b14.yml').map(sig);
        if (JSON.stringify(got) === JSON.stringify(saved)) bySaved.push(e.suite);
        else mismatches.push(`${e.suite}: unsaved [${got.join(', ')}]; saved [${saved.join(', ')}]; corpus [${want.join(', ')}]`);
      } finally {
        fs.writeFileSync(scratch().fsPath, CLEAN);
      }
    }
    assert.deepStrictEqual(mismatches, []);
    times.sort((x, y) => x - y);
    const p = (q: number) => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)];
    console.log(`    ${entries.length} entries: ${entries.length - bySaved.length} equal the corpus, ${bySaved.length} equal the saved file's lint (${bySaved.join(', ')})`);
    console.log(`    edit to published, ms: p50 ${p(0.5)}, p95 ${p(0.95)}, max ${times[times.length - 1]}`);
    await revert(scratch());
  });

  after(async () => {
    if (!hasTypeScript()) return;
    for (const u of [scratch(), scratchLib()]) await revert(u);
    // INV-12: nothing but the scratch files as first saved changed in the worktree.
    assert.strictEqual(gitStatus(), baseline, 'git status changed during live lint');
    assert.strictEqual(fs.readFileSync(scratch().fsPath, 'utf8'), CLEAN);
    assert.strictEqual(fs.readFileSync(scratchLib().fsPath, 'utf8'), LIB);
    await vscode.workspace.getConfiguration('bddSuite').update('lintTool', undefined, W);
    await vscode.workspace.getConfiguration('bddSuite').update('targetBinding', undefined, W);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(scratch().fsPath, { force: true });
    fs.rmSync(scratchLib().fsPath, { force: true });
  });
});
