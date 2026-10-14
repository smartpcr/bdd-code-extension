// session: worktree
// E-B6, four-binding part (B5.1-B5.4): an unknown action is declared from the
// quick fix and implemented in Go, Rust and C#; the repository's own checks,
// builds and programs then accept it, and each program fails the step with
// "not implemented". The TypeScript part waits for B5.5.
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'yaml';
import * as vscode from 'vscode';
import type { ScaffoldResult } from '../../../src/features/scaffold';
import { api, at, find, folder, open, within } from './helpers';
import { lint, nextLint, shown } from './lintHelpers';

const SCRATCH = ['test', 'e2e', 'suites', '_scratch-b6.yml'];
const SUITE = `suite: scratch-b6
tests:
  - name: echo
    steps:
      - when: the demo echoes twice
        why: B5.1-4, the common keys stay out of the catalog
        action: demo.echo
        text: hello
        times: 2
`;
/** Short, so a cold cargo build stays under the Windows path limit. */
const CARGO_TARGET = path.join(os.tmpdir(), 'bdd-b6-rs');

function exec(argv: string[], cwd: string, env: NodeJS.ProcessEnv = {}, timeout = 900_000): { status: number | null; out: string } {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

const catalogEntry = () => {
  const cat = parse(fs.readFileSync(path.join(folder(), 'test/e2e/schema/actions.catalog.yaml'), 'utf8'));
  return (cat.actions as { name: string; bindings: string[]; params?: { name: string; type: string }[] }[]).find(a => a.name === 'demo.echo');
};

async function codeActions(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.CodeAction[]> {
  return (await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, new vscode.Range(pos, pos))) ?? [];
}

async function runAction(a: vscode.CodeAction): Promise<ScaffoldResult> {
  return vscode.commands.executeCommand<ScaffoldResult>(a.command!.command, ...(a.command!.arguments ?? []));
}

describe('E-B6 a new action is declared and implemented from the editor', function () {
  this.timeout(1_800_000);
  const uri = at(...SCRATCH);

  /** What `git status` said before this file ran, so `after` restores exactly that. */
  let baseline = '';
  const status = () => exec(['git', 'status', '--porcelain', '--untracked-files=all'], folder()).out;

  before(async () => {
    baseline = status();
    fs.writeFileSync(uri.fsPath, SUITE);
    await (await api()).ready;
  });

  it('B5.1 the quick fix on E104 declares the action; the schema is regenerated; E104 clears on the next save', async () => {
    const doc = await open(uri);
    await vscode.window.showTextDocument(doc);
    await lint(uri);
    const pos = find(doc, 'demo.echo', 2);
    const e104 = shown(uri).filter(d => d.sig.startsWith('E104'));
    assert.strictEqual(e104.length, 1, JSON.stringify(shown(uri)));
    const other = vscode.languages.getDiagnostics(uri).filter(d => !(d.source ?? '').startsWith('suiterun:') && d.range.contains(pos));
    console.log(`    E104 from ${e104[0].source}; at the action, other sources report: ${other.map(d => `${d.source} ${d.code}`).join(', ') || 'nothing'}`);

    const fixes = (await codeActions(uri, pos)).filter(a => a.title === 'Declare action demo.echo');
    assert.strictEqual(fixes.length, 1, 'offered once even when two sources report E104');
    assert.strictEqual(fixes[0].kind?.value, 'quickfix');
    const result = await runAction(fixes[0]);
    assert.ok(result.ok, result.message);
    assert.strictEqual(result.generator, 'exit 0');

    const entry = catalogEntry();
    assert.deepStrictEqual(entry?.bindings, ['powershell']);
    assert.deepStrictEqual(entry?.params, [{ name: 'text', type: 'string' }, { name: 'times', type: 'integer' }], 'B5.1-4: when and why are not parameters');
    const stub = fs.readFileSync(at('scripts', 'e2e', 'actions', 'DemoEcho.ps1').fsPath, 'utf8');
    assert.match(stub, /Register-LabAction -Name 'demo\.echo' -Handler \{/);
    assert.ok(/^[\x00-\x7F]*$/.test(stub), 'the PowerShell stub is ASCII');
    assert.match(fs.readFileSync(at('test', 'e2e', 'schema', 'suite.schema.json').fsPath, 'utf8'), /"demo\.echo"/);

    const linted = nextLint(uri.fsPath);
    const touch = new vscode.WorkspaceEdit();
    touch.insert(uri, new vscode.Position(doc.lineCount, 0), '# saved after declaring\n');
    await vscode.workspace.applyEdit(touch);
    await doc.save();
    const after = await linted;
    assert.ok(after.outcome !== 'superseded');
    assert.deepStrictEqual(shown(uri).filter(d => d.sig.startsWith('E104')), [], 'E104 is gone after the next save');
  });

  it('B5.1-2 one undo reverts the catalog entry and the stub file; declaring again restores them', async () => {
    const catalogUri = at('test', 'e2e', 'schema', 'actions.catalog.yaml');
    const stub = at('scripts', 'e2e', 'actions', 'DemoEcho.ps1').fsPath;
    const cat = await open(catalogUri);
    await vscode.window.showTextDocument(cat);
    assert.ok(cat.getText().includes('- name: demo.echo'));
    const undone = await Promise.race([
      Promise.resolve(vscode.commands.executeCommand('undo')).then(() => 'done'),
      new Promise<string>(resolve => setTimeout(() => resolve('no answer within 5 s (a confirmation dialog?)'), 5000)),
    ]);
    assert.strictEqual(undone, 'done');
    await within(5000, () => !cat.getText().includes('- name: demo.echo') && !fs.existsSync(stub));
    await cat.save();
    console.log('    one undo removed the catalog entry and DemoEcho.ps1');
    const again = await vscode.commands.executeCommand<ScaffoldResult>('bddSuite.declareAction', uri, 'demo.echo');
    assert.ok(again.ok, again.message);
    assert.ok(fs.existsSync(stub) && catalogEntry());
  });

  it('B5.1-3 declaring an action already in the catalog refuses and changes nothing', async () => {
    const before = fs.readFileSync(at('test', 'e2e', 'schema', 'actions.catalog.yaml').fsPath, 'utf8');
    const r = await vscode.commands.executeCommand<ScaffoldResult>('bddSuite.declareAction', uri, 'demo.echo');
    assert.ok(!r.ok);
    assert.match(r.message, /already in the catalog/);
    assert.strictEqual(fs.readFileSync(at('test', 'e2e', 'schema', 'actions.catalog.yaml').fsPath, 'utf8'), before);
  });

  it('B5.2-B5.4 Implement in Go (from the step), Rust and C#: registry entry, stub, binding listed, no drift', async () => {
    const doc = await open(uri);
    const pos = find(doc, 'demo.echo', 2);
    const offered = (await codeActions(uri, pos)).map(a => a.title).filter(t => t.startsWith('Implement'));
    assert.deepStrictEqual(offered.sort(), ['Implement demo.echo in C#', 'Implement demo.echo in Go', 'Implement demo.echo in Rust']);
    const go = (await codeActions(uri, pos)).find(a => a.title === 'Implement demo.echo in Go')!;
    const results = [await runAction(go)];
    for (const binding of ['rust', 'csharp']) {
      results.push(await vscode.commands.executeCommand<ScaffoldResult>('bddSuite.implementAction', 'demo.echo', binding));
    }
    for (const r of results) {
      assert.ok(r.ok, r.message);
      assert.strictEqual(r.generator, 'exit 0', r.message);
    }
    assert.deepStrictEqual(catalogEntry()?.bindings, ['powershell', 'csharp', 'go', 'rust'], 'in the catalog\'s top-level order');
    const a = await api();
    await within(10_000, () => a.coverage.rows().every(r => r.declaredNotFound.length === 0 && r.foundNotDeclared.length === 0));
    const again = await vscode.commands.executeCommand<ScaffoldResult>('bddSuite.implementAction', 'demo.echo', 'go');
    assert.match(again.message, /already registered in the go binding/);
    assert.deepStrictEqual((await codeActions(uri, pos)).filter(x => x.title.startsWith('Implement')), [], 'nothing left to implement');
  });

  it('B5.1-1 Build-Schema.ps1 -Check exits 0 and the catalog checks of SuiteLint.Tests.ps1 (Y1.3) pass', async () => {
    const check = exec(['pwsh', '-NoProfile', '-NonInteractive', '-File', 'test/e2e/schema/Build-Schema.ps1', '-Check'], folder());
    assert.strictEqual(check.status, 0, check.out);
    const y13 = exec(['pwsh', '-NoProfile', '-NonInteractive', '-File', path.resolve(__dirname, '../../../../test/integration/harness/catalog-y13.ps1'), '-Root', folder()], folder());
    assert.strictEqual(y13.status, 0, y13.out);
    assert.match(y13.out, /Y1\.3 passed: \d+ checks over 101 actions/);
    console.log(`    ${y13.out.trim().split(/\r?\n/).pop()}`);
    // The whole file cannot pass here (stage B5 evidence): record what it says, never count it as a pass.
    const pester = exec(['pwsh', '-NoProfile', '-NonInteractive', '-Command',
      "$r = Invoke-Pester -Path scripts/e2e/SuiteLint.Tests.ps1 -PassThru -Output None; 'passed={0} failed={1}' -f $r.PassedCount,$r.FailedCount; $r.Failed | ForEach-Object { $_.ErrorRecord[0].Exception.Message }"], folder());
    console.log(`    SuiteLint.Tests.ps1 as a whole (open, blocked in os-context): ${pester.out.trim().split(/\r?\n/).join(' | ')}`);
    assert.match(pester.out, /Expected 100 declared actions, found 101|Expected E101/, 'it fails only for the recorded reasons');
  });

  const programs: [string, string, () => { status: number | null; out: string }, () => string][] = [
    ['Go', 'test/e2e/bindings/go',
      () => {
        const b = exec(['go', 'build', '-o', path.join(os.tmpdir(), 'bdd-b6-go', 'suiterun.exe'), './cmd/suiterun'], path.join(folder(), 'test/e2e/bindings/go'));
        const v = b.status === 0 ? exec(['go', 'vet', './...'], path.join(folder(), 'test/e2e/bindings/go')) : b;
        return v;
      },
      () => path.join(os.tmpdir(), 'bdd-b6-go', 'suiterun.exe')],
    ['Rust', 'test/e2e/bindings/rust',
      () => exec(['cargo', 'build'], path.join(folder(), 'test/e2e/bindings/rust'), { CARGO_TARGET_DIR: CARGO_TARGET }),
      () => path.join(CARGO_TARGET, 'debug', 'suiterun.exe')],
    ['C#', 'test/e2e/bindings/dotnet',
      () => exec(['dotnet', 'build', 'Hci.E2E.Suite.sln'], path.join(folder(), 'test/e2e/bindings/dotnet')),
      () => path.join(folder(), 'test/e2e/bindings/dotnet/artifacts/bin/Hci.E2E.Suite.Cli/Debug/net10.0/suiterun.exe')],
  ];
  for (const [label, , build, exe] of programs) {
    it(`B5.2-B5.4 ${label}: builds clean, actions --json lists demo.echo, running the suite fails the step "not implemented"`, async () => {
      const b = build();
      assert.strictEqual(b.status, 0, b.out);
      if (label === 'Rust') assert.ok(!/^warning/m.test(b.out), `B5.3-1 no new warnings:\n${b.out}`);
      const names = exec([exe(), 'actions', '--json'], folder());
      assert.strictEqual(names.status, 0, names.out);
      assert.ok((JSON.parse(names.out) as string[]).includes('demo.echo'), names.out);
      // The trace carries outcomes only; the failure message is in the results report.
      const results = path.join(os.tmpdir(), `bdd-b6-${label === 'C#' ? 'cs' : label.toLowerCase()}-results.xml`);
      fs.rmSync(results, { force: true });
      const run = exec([exe(), 'run', '--path', SCRATCH.join('/'), '--results', results, '--format', 'junit'], folder(), {}, 120_000);
      const said = run.out + (fs.existsSync(results) ? fs.readFileSync(results, 'utf8') : '');
      assert.strictEqual(run.status, 1, run.out);
      assert.match(said, new RegExp(`demo\\.echo: not implemented in the ${label.replace('#', '\\#')} binding yet`), said);
      console.log(`    ${label}: built, actions --json has demo.echo, run exit 1 with "not implemented"`);
    });
  }

  // Later files in this session expect the tree this file found (watch.test.ts uses demo.echo as an undeclared name).
  after(async () => {
    fs.rmSync(path.join(os.tmpdir(), 'bdd-b6-go'), { recursive: true, force: true });
    const was = new Set(baseline.split('\n').filter(Boolean));
    for (const line of status().split('\n').filter(l => l && !was.has(l))) {
      const file = line.slice(3).trim();
      if (line.startsWith('??')) fs.rmSync(path.join(folder(), file), { force: true });
      else exec(['git', 'checkout', '--', file], folder());
    }
    assert.strictEqual(status(), baseline, 'the worktree is back to what this file found');
    const a = await api();
    await within(10_000, () => !a.indexers[0].index.catalog?.actions.has('demo.echo'));
  });
});
