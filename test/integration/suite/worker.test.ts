// session: worktree
// B8.1 and the typescript half of E-B11: lint through the library in the lint
// worker, in the worktree's sample, whose library this test builds and breaks.
// The library is the sample's test/e2e/bindings/typescript/dist/index.js: it
// re-exports the TypeScript runtime and defines createLinter with the shop
// extension applied, and it is the file the extension loads and watches. The
// breaks are made there: an apiVersion export of its own (an explicit export
// wins over the runtime's re-exported one), and a createLinter whose lint()
// loops or throws.
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { api, at, open, within } from './helpers';
import { lint, nextLint, setting, shown, typeScriptLibrary } from './lintHelpers';

const W = vscode.ConfigurationTarget.Workspace;

describe('B8.1 the lint worker, and E-B11 for the typescript library', function () {
  this.timeout(600_000);
  const uri = () => at('test', 'e2e', 'suites', 'flawed', 'dataflow.yml');

  it('B8.1 item 4: Build lint tool builds the typescript library; open lints through one worker', async () => {
    const lib = typeScriptLibrary();
    const a = await setting('lintTool', 'typescript', W, x => x.controllers[0].tool === 'typescript');
    // An earlier file may have built it; move it aside so the build is this test's.
    if (fs.existsSync(lib)) {
      fs.renameSync(lib, `${lib}.prebuilt`);
      await within(10_000, () => !a.lintWorker.current);
    }
    try {
      // No library in the workspace: the runtime the extension carries lints instead (docs/packages, DEC-P08).
      const missing = await lint(uri());
      assert.strictEqual(missing.outcome, 'published', missing.status);
      assert.strictEqual(a.status.text, 'Suite: lint bundled runtime (no binding check)');
      assert.ok(shown(uri()).some(x => x.sig.startsWith('E301')), 'the bundled runtime finds the format\'s findings');
      const built = await vscode.commands.executeCommand<boolean>('bddSuite.buildLintTool');
      assert.strictEqual(built, true);
      assert.ok(fs.existsSync(lib));
    } finally {
      if (!fs.existsSync(lib) && fs.existsSync(`${lib}.prebuilt`)) fs.renameSync(`${lib}.prebuilt`, lib);
      fs.rmSync(`${lib}.prebuilt`, { force: true });
    }
    await open(uri());
    const e = await lint(uri());
    assert.strictEqual(e.outcome, 'published', e.status);
    const d = shown(uri());
    assert.ok(d.some(x => x.sig.startsWith('E301')), JSON.stringify(d));
    assert.ok(d.every(x => x.source === 'suiterun:typescript' && !x.message.startsWith('[stale] ')));
    assert.strictEqual(a.lintWorker.workerCount, 1);
    assert.strictEqual(a.status.text, 'Suite: lint typescript -> powershell');
  });

  /** Type one character at the end and wait for the live lint it causes. */
  async function typeAndWait() {
    const doc = await open(uri());
    const next = nextLint(uri().fsPath, 30_000, e => !!e.live);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri(), new vscode.Position(doc.lineCount, 0), '#');
    await vscode.workspace.applyEdit(edit);
    return next;
  }

  const CREATE = 'export function createLinter(options) {';
  // A library renamed away is no break any more: the bundled runtime lints (the test after these).
  const breaks: [string, (text: string) => string | undefined, string][] = [
    ['apiVersion 2.0.0', t => (t.includes("export * from '@bdd-suite/runtime';") ? `${t}\nexport const apiVersion = '2.0.0';\n` : t),
      'Lint: the typescript library speaks API 2.0.0; this extension speaks 1.x'],
    ['lint() loops forever', t => t.replace(CREATE, `${CREATE} return { invalidate() { }, lint(request) { for (;;) { } } };`), 'Lint timed out after 5 s'],
    ['lint() throws', t => t.replace(CREATE, `${CREATE} return { invalidate() { }, lint(request) { throw new Error('the library is broken on purpose'); } };`),
      'Lint: the typescript library failed'],
  ];
  for (const [name, broken, text] of breaks) {
    it(`E-B11 ${name}: "${text}", the E301 kept and marked stale; restoring and saving clears it`, async () => {
      const a = await api();
      const lib = typeScriptLibrary();
      const original = fs.readFileSync(lib, 'utf8');
      const changed = broken(original);
      if (changed === undefined) fs.renameSync(lib, `${lib}.away`);
      else {
        assert.notStrictEqual(changed, original, 'the edit applies to the built library');
        fs.writeFileSync(lib, changed);
      }
      try {
        // The library watcher marks the loaded copy old; the next lint starts a new worker.
        await within(10_000, () => !a.lintWorker.current);
        const logFrom = a.log.length;
        const started = Date.now();
        const e = await typeAndWait();
        const took = Date.now() - started;
        assert.deepStrictEqual([e.outcome, e.live, e.status], ['failed', true, text]);
        assert.strictEqual(a.status.text, text);
        const d = shown(uri());
        assert.ok(d.length > 0, 'no failure replaces the set with an empty one');
        assert.ok(d.every(x => x.message.startsWith('[stale] ')), JSON.stringify(d));
        assert.ok(d.some(x => x.sig.startsWith('E301')));
        const logged = a.log.slice(logFrom).join('\n');
        assert.match(logged, /Lint failed \(.+\): .*\n {2}library: .*index\.js/, logged);
        if (name.includes('throws')) assert.match(logged, /the library is broken on purpose/);
        if (name.includes('loops')) {
          assert.ok(took < 400 + 5000 + 1000 + 1000, `${took} ms from the edit`);
          assert.strictEqual(a.lintWorker.workerCount, 0, 'the looping worker is gone');
          console.log(`    looping library: failed ${took} ms after the edit; no worker left`);
        }
      } finally {
        if (changed === undefined) fs.renameSync(`${lib}.away`, lib);
        else fs.writeFileSync(lib, original);
      }
      const doc = await open(uri());
      // A superseded lint publishes nothing (INV-4); wait for the one that finishes.
      const saved = nextLint(uri().fsPath, 30_000, x => x.outcome === 'published' || x.outcome === 'failed');
      await doc.save();
      const s = await saved;
      assert.strictEqual(s.outcome, 'published', s.status);
      assert.ok(shown(uri()).every(x => !x.message.startsWith('[stale] ')));
      assert.strictEqual(a.status.text, 'Suite: lint typescript -> powershell');
    });
  }

  it('E9 (packages) the library renamed away: the bundled runtime lints, without the binding check; restoring it brings the library back', async () => {
    const a = await api();
    const lib = typeScriptLibrary();
    fs.renameSync(lib, `${lib}.away`);
    try {
      await within(10_000, () => !a.lintWorker.current);
      const e = await typeAndWait();
      assert.deepStrictEqual([e.outcome, e.live], ['published', true], e.status);
      assert.strictEqual(a.status.text, 'Suite: lint bundled runtime (no binding check)');
      const d = shown(uri());
      assert.ok(d.some(x => x.sig.startsWith('E301')) && d.every(x => !x.message.startsWith('[stale] ')), JSON.stringify(d));
      assert.ok(d.every(x => !x.sig.startsWith('E201')), 'no binding check');
    } finally {
      fs.renameSync(`${lib}.away`, lib);
    }
    const doc = await open(uri());
    const saved = nextLint(uri().fsPath, 30_000, x => x.outcome === 'published' || x.outcome === 'failed');
    await doc.save();
    const s = await saved;
    assert.strictEqual(s.outcome, 'published', s.status);
    assert.strictEqual(a.status.text, 'Suite: lint typescript -> powershell');
  });

  after(async () => {
    await vscode.workspace.getConfiguration('bddSuite').update('lintTool', undefined, W);
  });
});
