// The integration fixture: this repository's samples/workspace (D8, DEC-S11),
// its five `suiterun` programs, and the build that produces them.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** This repository's root (the harness runs from out-test/test/integration/harness). */
export const repo = path.resolve(__dirname, '../../../..');

/** The sample workspace in this checkout. */
export const sampleRoot = (): string => path.join(repo, 'samples', 'workspace');

const exe = process.platform === 'win32' ? '.exe' : '';

/**
 * The extension's global storage in the test profile (test-electron's default
 * user data, .vscode-test/user-data). Go's default program is
 * `${storage}/go/suiterun.exe` (DEC-S11), so the harness builds it there and
 * the editor finds it with no settings override.
 */
export const testStorage = (): string => path.join(repo, '.vscode-test', 'user-data', 'User', 'globalStorage', 'asz.bdd-suite');

export const BINDINGS = ['powershell', 'csharp', 'go', 'rust', 'typescript'] as const;
export type BindingName = typeof BINDINGS[number];

/**
 * Each binding's `suiterun`, as argv before the verb, built in the sample at
 * `root` (Go's in the test profile's storage). Run with the sample as cwd.
 */
export function samplePrograms(root = sampleRoot()): Record<BindingName, string[]> {
  return {
    powershell: ['pwsh', '-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts', 'e2e', 'suiterun.ps1')],
    csharp: [path.join(root, 'test', 'e2e', 'bindings', 'dotnet', 'artifacts', 'bin', 'Suite.Cli', 'Debug', 'net10.0', `suiterun${exe}`)],
    go: [path.join(testStorage(), 'go', `suiterun${exe}`)],
    rust: [path.join(root, 'test', 'e2e', 'bindings', 'rust', 'target', 'debug', `suiterun${exe}`)],
    typescript: [process.execPath, path.join(root, 'test', 'e2e', 'bindings', 'typescript', 'dist', 'cli.js')],
  };
}

/**
 * Build the sample's four compiled bindings once, before VS Code starts:
 * Go into the test profile's storage (where the extension's default looks),
 * Rust, C# and TypeScript in place (where the defaults look). Each build is
 * incremental; `npm ci` runs only when node_modules is missing.
 * BDD_SKIP_SAMPLE_BUILD=1 skips it (the programs must then exist).
 */
export function buildSample(root = sampleRoot()): void {
  if (process.env.BDD_SKIP_SAMPLE_BUILD === '1') {
    console.log('Sample build skipped (BDD_SKIP_SAMPLE_BUILD=1).');
  } else {
    const ts = path.join(root, 'test', 'e2e', 'bindings', 'typescript');
    const steps: [string, string, string, boolean][] = [
      ['go', `go build -o "${samplePrograms(root).go[0]}" ./cmd/suiterun`, 'go', true],
      ['rust', 'cargo build', 'rust', true],
      ['csharp', 'dotnet build Suite.sln', 'dotnet', true],
      ['typescript', fs.existsSync(path.join(ts, 'node_modules')) ? 'npm run build' : 'npm ci && npm run build', 'typescript', true],
    ];
    for (const [name, command, dir, shell] of steps) {
      const started = Date.now();
      const r = spawnSync(command, { cwd: path.join(root, 'test', 'e2e', 'bindings', dir), shell, encoding: 'utf8', timeout: 900_000 });
      if (r.status !== 0) throw new Error(`The sample's ${name} binding did not build (${command}):\n${r.stdout}\n${r.stderr}`);
      console.log(`Built the sample's ${name} binding in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
  }
  const missing = Object.entries(samplePrograms(root)).map(([, argv]) => argv[argv.length - 1]).filter(p => !fs.existsSync(p));
  if (missing.length) throw new Error(`Sample programs missing:\n  ${missing.join('\n  ')}`);
}
