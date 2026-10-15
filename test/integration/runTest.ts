// Runs the integration scenarios in a real VS Code (plan B1.1 item 7, DEC-B14).
// Sessions: `oscontext` opens OS_CONTEXT_ROOT read-only; `empty` opens an empty
// folder; `worktree` opens a disposable worktree for scenarios that edit files.
//
// With `--vsix <path>` (B9.2) the package is installed into a fresh extensions
// folder and the development path is an empty stub, so what runs is the
// installed package, not this source tree; each test's outcome is collected and
// written to artifacts/acceptance-<date>.json with the package's SHA-256.
import { execFileSync, spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { createWorktree, osContextRoot, removeWorktree } from './harness/worktree';

const repo = path.resolve(__dirname, '../../..');

/** Which scenario each test file is evidence for (plan section 4's index). */
const SCENARIOS: Record<string, string> = {
  'activation.test.ts': 'B1.1', 'inert.test.ts': 'B1.1', 'lint.test.ts': 'E-B1', 'target.test.ts': 'E-B2', 'hover.test.ts': 'E-B2',
  'navigation.test.ts': 'E-B3', 'references.test.ts': 'E-B4', 'completion.test.ts': 'E-B5', 'scaffold.test.ts': 'E-B6',
  'coverage.test.ts': 'E-B7', 'coverageDrift.test.ts': 'E-B7', 'watch.test.ts': 'E-B8', 'testing.test.ts': 'E-B9',
  'testingCancel.test.ts': 'E-B9', 'lintFailures.test.ts': 'E-B11', 'worker.test.ts': 'E-B11', 'liveLint.test.ts': 'E-B14',
  'latency.test.ts': 'E-B14', 'trust.test.ts': 'E-B15', 'lab.test.ts': 'E-B10',
};

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

async function main(): Promise<void> {
  // Launched from inside VS Code, this process inherits ELECTRON_RUN_AS_NODE=1,
  // which would start the test instance as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root = osContextRoot();
  // Insiders, so a stable VS Code the developer has open does not block the run.
  const version = process.env.BDD_VSCODE_VERSION ?? 'insiders';
  // test-electron 2.5 cannot read the versioned layout of current Insiders
  // archives and downloads again every run; reuse the copy when it is there.
  const cached = path.join(repo, '.vscode-test', 'vscode-win32-x64-archive-insiders', 'Code - Insiders.exe');
  const exe = process.env.BDD_VSCODE_EXE
    ?? (version === 'insiders' && process.platform === 'win32' && fs.existsSync(cached) && !process.env.BDD_VSCODE_REFRESH
      ? cached : await downloadAndUnzipVSCode(version));
  console.log(`VS Code under test: ${exe}`);
  const vsixArg = argValue('--vsix');
  const vsix = vsixArg && path.resolve(vsixArg);
  if (vsix && !fs.existsSync(vsix)) throw new Error(`No package at ${vsix}`);
  // A fresh extensions folder per package run, so nothing from an earlier install or the source tree is loaded.
  const extensionsDir = vsix ? path.join(repo, '.vscode-test', 'extensions-vsix') : undefined;
  if (extensionsDir) fs.rmSync(extensionsDir, { recursive: true, force: true });
  const [cli, ...defaultCliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe);
  const cliArgs = extensionsDir ? [`--extensions-dir=${extensionsDir}`, ...defaultCliArgs.filter(a => !a.startsWith('--extensions-dir'))] : defaultCliArgs;
  const install = (what: string) => {
    const r = spawnSync(cli, [...cliArgs, '--install-extension', what, '--force'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error(`Installing ${what} failed: ${r.stderr}`);
  };
  install('redhat.vscode-yaml');
  let stub = repo;
  let packageInfo: { file: string; sha256: string; version: string } | undefined;
  if (vsix) {
    install(vsix);
    const listed = spawnSync(cli, [...cliArgs, '--list-extensions', '--show-versions'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout;
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    if (!listed.includes(`${pkg.publisher}.${pkg.name}@${pkg.version}`)) throw new Error(`The package is not installed:\n${listed}`);
    packageInfo = { file: path.basename(vsix), sha256: createHash('sha256').update(fs.readFileSync(vsix)).digest('hex'), version: pkg.version };
    console.log(`Package under test: ${vsix} (sha256 ${packageInfo.sha256}), installed in ${extensionsDir}`);
    // An extension that does nothing, so the development path loads no code of ours.
    stub = path.join(repo, '.vscode-test', 'acceptance-stub');
    fs.mkdirSync(stub, { recursive: true });
    fs.writeFileSync(path.join(stub, 'package.json'), JSON.stringify({
      name: 'bdd-acceptance-stub', publisher: 'local', version: '0.0.0', engines: { vscode: '*' },
    }));
  }
  const results: { session: string; outcomes: { file: string; title: string; state: string; error?: string }[] }[] = [];
  const started = new Date();

  // --lab (B9.3) runs only the lab session; the offline sessions never run lab.test.ts.
  const labRun = process.argv.includes('--lab');
  const only = labRun ? ['lab'] : process.env.BDD_SESSIONS?.split(',');
  const sessions: { name: string; folder: () => string; cleanup?: (f: string) => void }[] = [
    { name: 'oscontext', folder: () => root },
    { name: 'empty', folder: () => fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-suite-empty-')),
      cleanup: f => fs.rmSync(f, { recursive: true, force: true }) },
    { name: 'worktree', folder: createWorktree, cleanup: removeWorktree },
    // Its own user data, so the trust it grants never reaches another session.
    { name: 'untrusted', folder: () => root },
    // The real checkout, read only; the lab is named at run time (BDD_LAB_*).
    ...(labRun ? [{ name: 'lab', folder: () => root }] : []),
  ];
  const untrustedData = path.join(repo, '.vscode-test', 'user-data-untrusted');
  let failed = 0;
  for (const s of sessions.filter(x => !only || only.includes(x.name))) {
    const folder = s.folder();
    console.log(`\n=== session ${s.name}: ${folder}`);
    let trustArgs = ['--disable-workspace-trust'];
    if (s.name === 'untrusted') {
      fs.rmSync(untrustedData, { recursive: true, force: true });
      fs.mkdirSync(path.join(untrustedData, 'User'), { recursive: true });
      fs.writeFileSync(path.join(untrustedData, 'User', 'settings.json'), JSON.stringify({
        'security.workspace.trust.enabled': true,
        'security.workspace.trust.startupPrompt': 'never',
        'bddSuite.lintTool': 'rust',
      }, null, 2));
      trustArgs = ['--user-data-dir', untrustedData, '--extensions-dir', extensionsDir ?? path.join(repo, '.vscode-test', 'extensions')];
    } else if (extensionsDir) {
      trustArgs = [...trustArgs, `--extensions-dir=${extensionsDir}`];
    }
    const resultsFile = path.join(os.tmpdir(), `bdd-results-${process.pid}-${s.name}.json`);
    fs.rmSync(resultsFile, { force: true });
    const env: Record<string, string> = {
      BDD_SESSION: s.name, OS_CONTEXT_ROOT: root, BDD_FOLDER: folder, BDD_FILES: process.env.BDD_FILES ?? '', BDD_RESULTS_FILE: resultsFile,
      ...(vsix ? { BDD_VSIX_EXTENSIONS_DIR: extensionsDir!, BDD_VSIX_VERSION: packageInfo!.version, BDD_VSIX_SHA256: packageInfo!.sha256 } : {}),
    };
    try {
      if (s.name === 'untrusted') {
        // runTests() always adds --disable-workspace-trust, so this session is
        // launched directly with the same arguments minus that one.
        const code = await launchWithoutTrustOverride(exe, [
          folder, ...trustArgs, '--disable-extension', 'vscode.git',
          '--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes',
          `--extensionTestsPath=${path.join(__dirname, 'suite', 'index')}`, `--extensionDevelopmentPath=${stub}`,
        ], { ...env, BDD_TEST_TRUST_SEAM: '1' });
        if (code !== 0) throw new Error(`Test run failed with code ${code}`);
      } else {
        await runTests({
          vscodeExecutablePath: exe,
          extensionDevelopmentPath: stub,
          extensionTestsPath: path.join(__dirname, 'suite', 'index'),
          launchArgs: [folder, ...trustArgs, '--disable-extension', 'vscode.git'],
          extensionTestsEnv: env,
        });
      }
    } catch (e) {
      failed++;
      console.error(`session ${s.name} failed: ${(e as Error).message}`);
    } finally {
      s.cleanup?.(folder);
      if (fs.existsSync(resultsFile)) results.push(JSON.parse(fs.readFileSync(resultsFile, 'utf8')));
      else results.push({ session: s.name, outcomes: [{ file: '', title: `session ${s.name} wrote no results`, state: 'failed' }] });
    }
  }
  // The lab run records itself (artifacts/lab-acceptance-<date>.json); this record is the offline batch's.
  if (packageInfo && !labRun) writeAcceptance(packageInfo, root, exe, started, results);
  if (failed) throw new Error(`${failed} session(s) failed`);
}

/** artifacts/acceptance-<date>.json (B9.2): what was tested, on what, and each scenario's verdict. */
function writeAcceptance(pkg: { file: string; sha256: string; version: string }, root: string, exe: string, started: Date,
  results: { session: string; outcomes: { file: string; title: string; state: string; error?: string }[] }[]): void {
  const all = results.flatMap(r => r.outcomes.map(o => ({ ...o, session: r.session, scenario: SCENARIOS[o.file] ?? 'other' })));
  const scenarios: Record<string, { passed: number; failed: number; pending: number; verdict: string }> = {};
  for (const o of all) {
    const s = scenarios[o.scenario] ??= { passed: 0, failed: 0, pending: 0, verdict: '' };
    s[o.state as 'passed' | 'failed' | 'pending']++;
  }
  // A skipped (pending) or failed test leaves its scenario open (B9.2-1).
  for (const s of Object.values(scenarios)) s.verdict = s.failed ? 'failed' : s.pending ? 'open (skipped or blocked)' : 'passed';
  const version = (() => {
    // Insiders keeps resources/ under a folder named for its commit.
    const base = path.dirname(exe);
    for (const dir of ['', ...fs.readdirSync(base)]) {
      const p = path.join(base, dir, 'resources', 'app', 'package.json');
      if (fs.existsSync(p)) return `${JSON.parse(fs.readFileSync(p, 'utf8')).version} (${dir || 'root'})`;
    }
    return 'unknown';
  })();
  const record = {
    package: pkg,
    extensionCommit: git(repo, 'rev-parse', 'HEAD'),
    extensionTreeClean: git(repo, 'status', '--porcelain') === '',
    osContext: { path: root, commit: git(root, 'rev-parse', 'HEAD'), uncommittedChanges: git(root, 'status', '--porcelain').split('\n').filter(Boolean).length },
    vscode: { executable: exe, version },
    node: process.version,
    started: started.toISOString(),
    finished: new Date().toISOString(),
    scenarios,
    tests: all,
  };
  const dir = path.join(repo, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `acceptance-${started.toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(out, JSON.stringify(record, null, 2));
  console.log(`\nAcceptance record: ${out}`);
  for (const [k, v] of Object.entries(scenarios).sort()) console.log(`  ${k}: ${v.verdict} (${v.passed} passed, ${v.failed} failed, ${v.pending} skipped)`);
}

function launchWithoutTrustOverride(exe: string, args: string[], extra: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn(exe, args, { env: { ...process.env, ...extra }, stdio: 'inherit' });
    child.on('exit', code => resolve(code));
    child.on('error', () => resolve(-1));
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
