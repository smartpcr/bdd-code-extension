// Runs the integration scenarios in a real VS Code (plan B1.1 item 7, DEC-B14).
// Sessions: `oscontext` opens OS_CONTEXT_ROOT read-only; `empty` opens an empty
// folder; `worktree` opens a disposable worktree for scenarios that edit files.
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { createWorktree, osContextRoot, removeWorktree } from './harness/worktree';

const repo = path.resolve(__dirname, '../../..');

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
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe);
  const installed = spawnSync(cli, [...cliArgs, '--install-extension', 'redhat.vscode-yaml', '--force'],
    { encoding: 'utf8', shell: process.platform === 'win32' });
  if (installed.status !== 0) throw new Error(`Installing redhat.vscode-yaml failed: ${installed.stderr}`);

  const only = process.env.BDD_SESSIONS?.split(',');
  const sessions: { name: string; folder: () => string; cleanup?: (f: string) => void }[] = [
    { name: 'oscontext', folder: () => root },
    { name: 'empty', folder: () => fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-suite-empty-')),
      cleanup: f => fs.rmSync(f, { recursive: true, force: true }) },
    { name: 'worktree', folder: createWorktree, cleanup: removeWorktree },
    // Its own user data, so the trust it grants never reaches another session.
    { name: 'untrusted', folder: () => root },
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
      trustArgs = ['--user-data-dir', untrustedData, '--extensions-dir', path.join(repo, '.vscode-test', 'extensions')];
    }
    const env = { BDD_SESSION: s.name, OS_CONTEXT_ROOT: root, BDD_FOLDER: folder, BDD_FILES: process.env.BDD_FILES ?? '' };
    try {
      if (s.name === 'untrusted') {
        // runTests() always adds --disable-workspace-trust, so this session is
        // launched directly with the same arguments minus that one.
        const code = await launchWithoutTrustOverride(exe, [
          folder, ...trustArgs, '--disable-extension', 'vscode.git',
          '--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes',
          `--extensionTestsPath=${path.join(__dirname, 'suite', 'index')}`, `--extensionDevelopmentPath=${repo}`,
        ], { ...env, BDD_TEST_TRUST_SEAM: '1' });
        if (code !== 0) throw new Error(`Test run failed with code ${code}`);
      } else {
        await runTests({
          vscodeExecutablePath: exe,
          extensionDevelopmentPath: repo,
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
    }
  }
  if (failed) throw new Error(`${failed} session(s) failed`);
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
