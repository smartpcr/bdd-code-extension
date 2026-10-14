// session: worktree
// E-B11 (B2.4), B2.2-2, B2.2-3 and the save half of E-B1, in a disposable worktree.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { api, at, open, within } from './helpers';
import { lint, setting, shown } from './lintHelpers';

const W = vscode.ConfigurationTarget.Workspace;
const fake = () => path.join(vscode.extensions.getExtension('local.bdd-suite')!.extensionPath, 'test', 'fake-tool', 'fake-suiterun.mjs');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The worktree has no build output; the real program is the main checkout's, run from the worktree. */
const REAL_RUST = () => [path.join(process.env.OS_CONTEXT_ROOT!, 'test', 'e2e', 'bindings', 'rust', 'target', 'debug', 'suiterun.exe')];

async function rustTool(tool: string[] | undefined) {
  const want = tool ?? REAL_RUST();
  return setting('bindings', { rust: { tool: want } }, W,
    a => JSON.stringify(a.indexers[0].layout.settings.bindings.rust.tool) === JSON.stringify(want));
}

describe('B2.2 lint on save', () => {
  before(async () => {
    await setting('lintTool', 'rust', W, a => a.controllers[0].tool === 'rust');
    await rustTool(undefined);
  });

  it('E-B1 save half: saving gives the same set, not a doubled one', async () => {
    const uri = at('test', 'e2e', 'conformance', 'validate', 'typos.yml');
    const doc = await open(uri);
    await lint(uri);
    const before = shown(uri).map(d => d.sig);
    assert.deepStrictEqual(before, ['E101 error 4:5', 'E104 error 6:17', 'E101 error 8:5']);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(doc.lineCount, 0), '# saved\n');
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    await within(5000, async () => (await api()).controllers[0].lintsStarted > 0 && shown(uri).length === 3);
    await new Promise(r => setTimeout(r, 1000));
    assert.deepStrictEqual(shown(uri).map(d => d.sig), before);
  });

  it('B2.2-2 two saves within LINT_DEBOUNCE_MS produce one lint', async () => {
    const uri = at('test', 'e2e', 'conformance', 'validate', 'typos.yml');
    const doc = await open(uri);
    const c = (await api()).controllers[0];
    await new Promise(r => setTimeout(r, 1000));
    const startCount = c.lintsStarted;
    for (const text of ['# one\n', '# two\n']) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(doc.lineCount, 0), text);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    }
    await new Promise(r => setTimeout(r, 2000));
    assert.strictEqual(c.lintsStarted - startCount, 1);
  });

  it('B2.2-3 a lint started during a running lint cancels it; only the second publishes', async () => {
    const answer = path.join(require('os').tmpdir(), 'bdd-suite-empty.json');
    fs.writeFileSync(answer, '[]');
    await rustTool(['node', fake(), '--sleep=2000', `--print-file=${answer}`]);
    const uri = at('test', 'e2e', 'conformance', 'validate', 'typos.yml');
    const c = (await api()).controllers[0];
    const first = c.lintNow(uri);
    await new Promise(r => setTimeout(r, 300));
    const second = c.lintNow(uri);
    assert.strictEqual((await first).outcome, 'cancelled');
    assert.strictEqual((await second).outcome, 'published');
    assert.deepStrictEqual(shown(uri), []);
    await rustTool(undefined);
  });
});

describe('E-B11 a missing, slow or broken lint tool is reported, not hidden', () => {
  const uri = () => at('test', 'e2e', 'conformance', 'validate', 'dataflow.yml');

  before(async () => {
    await setting('lintTool', 'rust', W, a => a.controllers[0].tool === 'rust');
    await rustTool(undefined);
    await open(uri());
    const e = await lint(uri());
    assert.strictEqual(e.outcome, 'published');
    assert.ok(shown(uri()).some(d => d.sig.startsWith('E301')), 'a known E301 is shown from a successful lint');
  });

  const cases: [string, () => string[], string][] = [
    ['missing', () => [path.join(path.dirname(fake()), 'no-such-suiterun.exe')], 'Lint: rust not built'],
    ['junk', () => ['node', fake(), '--exit=2', '--print=not json'], 'Lint output was not diagnostics'],
    ['oversize', () => ['node', fake(), '--bytes=17000000'], 'Lint output too large'],
    ['slow', () => ['node', fake(), '--child', '--sleep=600000'], 'Lint timed out after 20 s'],
  ];
  for (const [name, tool, text] of cases) {
    it(`B2.4-1/2 ${name}: "${text}", the E301 kept and marked stale`, async () => {
      const a = await rustTool(tool());
      const logFrom = a.log.length;
      const e = await lint(uri());
      assert.strictEqual(e.outcome, 'failed');
      assert.strictEqual(e.status, text);
      assert.strictEqual(a.status.text, text);
      const d = shown(uri());
      assert.ok(d.length > 0, 'no failure replaces the set with an empty one');
      assert.ok(d.every(x => x.message.startsWith('[stale] ')), JSON.stringify(d));
      assert.ok(d.some(x => x.sig.startsWith('E301')));
      assert.ok(a.log.slice(logFrom).some(l => l.includes('argv:') && l.includes('cwd:')), 'the output channel has argv and cwd');
      if (name === 'slow') {
        const pid = Number(/grandchild (\d+)/.exec(a.log.slice(logFrom).join('\n'))?.[1]);
        assert.ok(pid > 0, 'the grandchild pid is in the program\'s stderr');
        await new Promise(r => setTimeout(r, 1000));
        assert.strictEqual(alive(pid), false, 'B2.4-3 no child survives KILL_GRACE_MS after a timeout');
      }
    });
  }

  it('restoring the tool and linting clears the stale marks', async () => {
    const a = await rustTool(undefined);
    const e = await lint(uri());
    assert.strictEqual(e.outcome, 'published');
    assert.ok(shown(uri()).every(d => !d.message.startsWith('[stale] ')));
    assert.strictEqual(a.status.text, 'Suite: lint rust -> powershell');
  });

  it('B2.4-4 Build lint tool for Go produces the program, after which the next lint publishes', async () => {
    const a = await setting('lintTool', 'go', W, x => x.controllers[0].tool === 'go');
    const exe = a.indexers[0].layout.bindings.find(b => b.name === 'go')!.tool[0];
    if (fs.existsSync(exe)) fs.renameSync(exe, `${exe}.bak`);
    try {
      const missing = await lint(uri());
      assert.strictEqual(missing.status, 'Lint: go not built');
      const built = await vscode.commands.executeCommand<boolean>('bddSuite.buildLintTool');
      assert.strictEqual(built, true);
      assert.ok(fs.existsSync(exe));
      const e = await lint(uri());
      assert.strictEqual(e.outcome, 'published');
      console.log(`    built ${exe}`);
    } finally {
      if (fs.existsSync(`${exe}.bak`)) fs.rmSync(`${exe}.bak`);
    }
  });
});
