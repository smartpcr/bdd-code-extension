// A self-contained end-to-end demo of the packaged extension. It needs no
// os-context checkout: it copies test/e2e-demo/fixture (a catalog, a YAML
// suite, and registrations in PowerShell, C#, Go, Rust and TypeScript) to a
// temporary workspace, installs the .vsix into a fresh VS Code profile, and
// runs suite/demo.test.ts there, which navigates between the YAML and each
// language's implementation and generates new code with the scaffolding commands.
//
//   npm run test:demo                       builds the .vsix when there is none
//   npm run test:demo -- --vsix <path>      tests that package
//   DEMO_KEEP=1 npm run test:demo           keeps the workspace to look at the generated code
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

const repo = path.resolve(__dirname, '../../..');
const fixture = path.join(repo, 'test', 'e2e-demo', 'fixture');

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const vsix = path.resolve(argValue('--vsix') ?? path.join(repo, `${pkg.name}-${pkg.version}.vsix`));
  if (!fs.existsSync(vsix)) {
    console.log(`No package at ${vsix}; building it with npm run package.`);
    execFileSync('npm', ['run', 'package'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  const sha256 = createHash('sha256').update(fs.readFileSync(vsix)).digest('hex');

  const cached = path.join(repo, '.vscode-test', 'vscode-win32-x64-archive-insiders', 'Code - Insiders.exe');
  const exe = process.env.BDD_VSCODE_EXE
    ?? (process.platform === 'win32' && fs.existsSync(cached) && !process.env.BDD_VSCODE_VERSION
      ? cached : await downloadAndUnzipVSCode(process.env.BDD_VSCODE_VERSION ?? 'stable'));

  // A fresh profile: no extension, setting or state from any other run.
  const profile = path.join(repo, '.vscode-test', 'demo');
  fs.rmSync(profile, { recursive: true, force: true });
  const extensionsDir = path.join(profile, 'extensions');
  const userDataDir = path.join(profile, 'user-data');
  const [cli] = resolveCliArgsFromVSCodeExecutablePath(exe);
  const cliArgs = [`--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDataDir}`];
  // Only the package: it needs no other extension.
  const r = spawnSync(cli, [...cliArgs, '--install-extension', vsix, '--force'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`Installing ${vsix} failed: ${r.stderr}`);
  const listed = spawnSync(cli, [...cliArgs, '--list-extensions', '--show-versions'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout;
  if (!listed.includes(`${pkg.publisher}.${pkg.name}@${pkg.version}`)) throw new Error(`The package did not install:\n${listed}`);
  console.log(`Installed ${path.basename(vsix)} (sha256 ${sha256}) into ${extensionsDir}`);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-demo-'));
  fs.cpSync(fixture, workspace, { recursive: true });
  console.log(`Demo workspace: ${workspace}`);

  // The development path is an empty extension, so the installed package is what runs.
  const stub = path.join(profile, 'stub');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'package.json'), JSON.stringify({ name: 'demo-stub', publisher: 'local', version: '0.0.0', engines: { vscode: '*' } }));

  try {
    await runTests({
      vscodeExecutablePath: exe,
      extensionDevelopmentPath: stub,
      extensionTestsPath: path.join(__dirname, 'suite', 'index'),
      launchArgs: [workspace, `--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDataDir}`, '--disable-extension', 'vscode.git'],
      extensionTestsEnv: { DEMO_WORKSPACE: workspace, DEMO_EXTENSIONS_DIR: extensionsDir, DEMO_VSIX_VERSION: pkg.version },
    });
  } finally {
    if (process.env.DEMO_KEEP === '1') console.log(`Kept the workspace with the generated code: ${workspace}`);
    else fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
