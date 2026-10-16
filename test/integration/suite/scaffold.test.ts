// session: worktree
// E-B6 (B5.1-B5.5) in the worktree's sample: an unknown action is declared
// from the quick fix (catalog entry, PowerShell stub, regenerated schema) and
// implemented in Go, Rust, C# and TypeScript. Each generated registry then
// builds with the sample's real toolchain, its program's `actions --json`
// lists the action, and a run of the suite using it fails the step "not
// implemented in the <language> binding yet", as PowerShell's stub does. The
// catalog's checks (harness/catalog-check.ps1) pass. Afterwards the sample is
// exactly as this file found it, `git status -- samples/workspace` included.
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'yaml';
import * as vscode from 'vscode';
import type { ScaffoldResult } from '../../../src/features/scaffold';
import { api, at, find, folder, open, restoreSample, sampleChanges, sampleSnapshot, sampleStatus, within } from './helpers';
import { lint, nextLint, setting, shown } from './lintHelpers';

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

  /** What `git status -- samples/workspace` said, and every file's content, before this file ran: `after` restores both. */
  let baseline = '';
  let snapshot: Map<string, Buffer>;
  /** How many actions the sample's catalog declares before this file adds one. */
  let declaredBefore = 0;

  before(async () => {
    baseline = sampleStatus();
    snapshot = sampleSnapshot();
    declaredBefore = (parse(fs.readFileSync(path.join(folder(), 'test/e2e/schema/actions.catalog.yaml'), 'utf8')).actions as unknown[]).length;
    // Lint by the Go program, which this scenario's E104 and quick fix were written against.
    await setting('lintTool', 'go', vscode.ConfigurationTarget.Workspace, a => a.controllers[0].tool === 'go');
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
    assert.match(stub, /Register-SuiteAction -Name 'demo\.echo' -Handler \{/);
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

  it('B5.2-B5.5 Implement in Go (from the step), Rust, C# and TypeScript: registry entry, stub, binding listed, no new drift', async () => {
    const doc = await open(uri);
    const pos = find(doc, 'demo.echo', 2);
    const offered = (await codeActions(uri, pos)).map(a => a.title).filter(t => t.startsWith('Implement'));
    assert.deepStrictEqual(offered.sort(), ['Implement demo.echo in C#', 'Implement demo.echo in Go', 'Implement demo.echo in Rust', 'Implement demo.echo in TypeScript']);
    const go = (await codeActions(uri, pos)).find(a => a.title === 'Implement demo.echo in Go')!;
    const results = [await runAction(go)];
    for (const binding of ['rust', 'csharp', 'typescript']) {
      results.push(await vscode.commands.executeCommand<ScaffoldResult>('bddSuite.implementAction', 'demo.echo', binding));
    }
    for (const r of results) {
      assert.ok(r.ok, r.message);
      assert.strictEqual(r.generator, 'exit 0', r.message);
    }
    assert.deepStrictEqual(catalogEntry()?.bindings, ['powershell', 'csharp', 'go', 'rust', 'typescript'], 'in the catalog\'s top-level order');
    const a = await api();
    // The sample's one deliberate drift (report.export, declared for csharp and registered nowhere) stays; nothing else.
    const drift = () => a.coverage.rows().flatMap(r => [...r.declaredNotFound, ...r.foundNotDeclared, ...r.duplicates].map(n => `${r.binding} ${n}`));
    await within(10_000, () => JSON.stringify(drift()) === JSON.stringify(['csharp report.export']));
    assert.ok(a.coverage.rows().every(r => r.found.includes('demo.echo')), 'every binding registers demo.echo');
    const again = await vscode.commands.executeCommand<ScaffoldResult>('bddSuite.implementAction', 'demo.echo', 'go');
    assert.match(again.message, /already registered in the go binding/);
    assert.deepStrictEqual((await codeActions(uri, pos)).filter(x => x.title.startsWith('Implement')), [], 'nothing left to implement');
  });

  it('B5.1-1 Build-Schema.ps1 -Check exits 0 and the catalog checks (harness/catalog-check.ps1) pass', async () => {
    const check = exec(['pwsh', '-NoProfile', '-NonInteractive', '-File', 'test/e2e/schema/Build-Schema.ps1', '-Check'], folder());
    assert.strictEqual(check.status, 0, check.out);
    const checks = exec(['pwsh', '-NoProfile', '-NonInteractive', '-File', path.resolve(__dirname, '../../../../test/integration/harness/catalog-check.ps1'), '-Root', folder()], folder());
    assert.strictEqual(checks.status, 0, checks.out);
    assert.match(checks.out, new RegExp(`Catalog checks passed: \\d+ checks over ${declaredBefore + 1} workspace actions`));
    console.log(`    ${checks.out.trim().split(/\r?\n/).pop()}`);
  });

  const exe = process.platform === 'win32' ? '.exe' : '';
  const bindingDir = (name: string) => path.join(folder(), 'test', 'e2e', 'bindings', name);
  const GO_OUT = path.join(os.tmpdir(), 'bdd-b6-go');
  /** Each language's build of the worktree sample (none for PowerShell) and the program it gives. */
  const programs: { label: string; build?: () => { status: number | null; out: string }; argv: () => string[] }[] = [
    {
      label: 'Go',
      build: () => {
        const b = exec(['go', 'build', '-o', path.join(GO_OUT, `suiterun${exe}`), './cmd/suiterun'], bindingDir('go'));
        return b.status === 0 ? exec(['go', 'vet', './...'], bindingDir('go')) : b;
      },
      argv: () => [path.join(GO_OUT, `suiterun${exe}`)],
    },
    {
      label: 'Rust',
      build: () => exec(['cargo', 'build'], bindingDir('rust'), { CARGO_TARGET_DIR: CARGO_TARGET }),
      argv: () => [path.join(CARGO_TARGET, 'debug', `suiterun${exe}`)],
    },
    {
      label: 'C#',
      build: () => exec(['dotnet', 'build', 'Suite.sln'], bindingDir('dotnet')),
      argv: () => [path.join(bindingDir('dotnet'), 'artifacts', 'bin', 'Suite.Cli', 'Debug', 'net10.0', `suiterun${exe}`)],
    },
    {
      label: 'TypeScript',
      // npm is npm.cmd on Windows: one fixed command line through the shell.
      build: () => {
        const command = fs.existsSync(path.join(bindingDir('typescript'), 'node_modules')) ? 'npm run build' : 'npm ci && npm run build';
        const r = spawnSync(command, { cwd: bindingDir('typescript'), shell: true, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
        return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
      },
      argv: () => ['node', path.join(bindingDir('typescript'), 'dist', 'cli.js')],
    },
    {
      label: 'PowerShell',
      argv: () => ['pwsh', '-NoProfile', '-NonInteractive', '-File', path.join(folder(), 'scripts', 'e2e', 'suiterun.ps1')],
    },
  ];
  for (const { label, build, argv } of programs) {
    it(`B5.2-B5.5 ${label}: ${build ? 'builds clean, ' : ''}actions --json lists demo.echo, running the suite fails the step "not implemented"`, async () => {
      if (build) {
        const b = build();
        assert.strictEqual(b.status, 0, b.out);
        if (label === 'Rust') assert.ok(!/^warning/m.test(b.out), `B5.3-1 no new warnings:\n${b.out}`);
      }
      const names = exec([...argv(), 'actions', '--json'], folder());
      assert.strictEqual(names.status, 0, names.out);
      assert.ok((JSON.parse(names.out) as string[]).includes('demo.echo'), names.out);
      // The trace carries outcomes only; the failure message is in the results report.
      const results = path.join(os.tmpdir(), `bdd-b6-${label.replace('#', 'sharp').toLowerCase()}-results.xml`);
      fs.rmSync(results, { force: true });
      const run = exec([...argv(), 'run', '--path', SCRATCH.join('/'), '--results', results, '--format', 'junit'], folder(), {}, 300_000);
      const said = run.out + (fs.existsSync(results) ? fs.readFileSync(results, 'utf8') : '');
      fs.rmSync(results, { force: true });
      assert.strictEqual(run.status, 1, run.out);
      assert.match(said, new RegExp(`demo\\.echo: not implemented in the ${label.replace('#', '\\#')} binding yet`), said);
      console.log(`    ${label}: ${build ? 'built, ' : ''}actions --json has demo.echo, run exit 1 with "not implemented"`);
    });
  }

  // Later files in this session expect the sample this file found (watch.test.ts uses demo.echo as an undeclared name).
  after(async () => {
    fs.rmSync(GO_OUT, { recursive: true, force: true });
    await vscode.workspace.getConfiguration('bddSuite').update('lintTool', undefined, vscode.ConfigurationTarget.Workspace);
    const touched = restoreSample(snapshot);
    console.log(`    put back ${touched.length} file(s) of the sample`);
    assert.deepStrictEqual(sampleChanges(snapshot), [], 'every file of the sample has the content this file found');
    assert.strictEqual(sampleStatus(), baseline, 'git status -- samples/workspace is what this file found');
    const a = await api();
    await within(10_000, () => !a.indexers[0].index.catalog?.actions.has('demo.echo'));
  });
});
