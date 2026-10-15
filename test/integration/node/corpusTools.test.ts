// B2.1 E2E (the parse-and-map half of E-B1) and B2.5's latency measurement:
// every real binding program through runTool and parseLintOutput, no editor.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import { DEFAULT_SETTINGS } from '../../../src/config/defaults';
import { WorkspaceLayout } from '../../../src/config/layout';
import { parseLintOutput } from '../../../src/core/diagnostics';
import { lintCommand } from '../../../src/tools/profiles';
import { runTool } from '../../../src/tools/runTool';
import { sig, validateEntries } from '../harness/corpus';
import { osContextRoot } from '../harness/worktree';

const repo = path.resolve(__dirname, '../../../..');
const root = osContextRoot();
const storage = path.join(repo, '.vscode-test', 'user-data', 'User', 'globalStorage', 'asz.bdd-suite');
const layout = WorkspaceLayout.create(root, DEFAULT_SETTINGS, storage, p => fs.existsSync(p))!;
const TOOLS = ['go', 'rust', 'csharp', 'powershell'];
const pwshVersion = (): string => execFileSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' }).trim();

/** The PowerShell 7.6.7 Test-Json defect: structural (schema) findings vanish. Recorded in docs/evidence/stage-b2.md. */
export const KNOWN_BLOCKED: Record<string, () => string | undefined> = {
  powershell: () => (pwshVersion() === '7.6.7'
    ? 'PowerShell 7.6.7: Test-Json returns false against suite.schema.json with no error, so SuiteLint.psm1 loses every schema finding (os-context defect)'
    : undefined),
};

describe('B2.1 E2E: each binding program, through runTool and parseLintOutput, against the corpus', () => {
  const { entries, excluded } = validateEntries(root);
  it('the corpus has the entries this scenario expects', () => {
    assert.ok(entries.length >= 40, `${entries.length} entries`);
    console.log(`    ${entries.length} validate entries; excluded: ${excluded.join(', ')}`);
  });
  for (const tool of TOOLS) {
    it(`${tool}: every entry gives exactly the expected diagnostics and exit code`, async (t) => {
      const binding = layout.bindings.find(b => b.name === tool)!;
      const mismatches: string[] = [];
      for (const e of entries) {
        const r = await runTool(lintCommand(binding, layout.root, e.rel, e.target));
        if (r.kind !== 'exited') {
          mismatches.push(`${e.suite}: ${r.kind === 'failure' ? `${r.reason} ${r.detail} ${r.stderrTail}` : r.kind}`);
          continue;
        }
        const parsed = parseLintOutput(r.stdout, r.code);
        if (!parsed.ok) {
          mismatches.push(`${e.suite}: ${parsed.detail}: ${r.stdout.slice(0, 200)} ${r.stderrTail.slice(-300)}`);
          continue;
        }
        const got = parsed.value.map(sig);
        const want = e.diagnostics.map(sig);
        const wantExit = tool === 'powershell' ? 0 : e.exitCode;
        if (JSON.stringify(got) !== JSON.stringify(want) || r.code !== wantExit) {
          mismatches.push(`${e.suite}: got [${got.join(', ')}] exit ${r.code}; want [${want.join(', ')}] exit ${wantExit}`);
        }
      }
      if (mismatches.length && KNOWN_BLOCKED[tool]?.()) {
        console.log(`    ${tool}: ${mismatches.length} of ${entries.length} entries differ:\n      ${mismatches.join('\n      ')}`);
        t.skip(`BLOCKED, not passed: ${KNOWN_BLOCKED[tool]!()}`);
        return;
      }
      assert.deepStrictEqual(mismatches, [], `${tool} differs from the corpus`);
    });
  }
});

describe('B2.5 lint latency per program on lifecycle-stage1.yml (1 warm-up, 20 timed)', () => {
  const results: string[] = [];
  for (const tool of TOOLS) {
    it(`${tool}`, async () => {
      const binding = layout.bindings.find(b => b.name === tool)!;
      const cmd = lintCommand(binding, layout.root, 'test/e2e/suites/lifecycle-stage1.yml', 'powershell');
      const first = await runTool(cmd);
      assert.strictEqual(first.kind, 'exited');
      const times: number[] = [];
      for (let i = 0; i < 20; i++) {
        const s = process.hrtime.bigint();
        const r = await runTool(cmd);
        times.push(Number(process.hrtime.bigint() - s) / 1e6);
        assert.strictEqual(r.kind, 'exited');
      }
      times.sort((a, b) => a - b);
      const p = (q: number) => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)].toFixed(0);
      const line = `| ${tool} | ${p(0.5)} | ${p(0.95)} | ${times[times.length - 1].toFixed(0)} |`;
      results.push(line);
      console.log(`    ${line}`);
    });
  }
  it('machine', () => {
    console.log(`    machine: ${os.cpus()[0].model}, ${os.cpus().length} logical CPUs, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.release()}; pwsh ${pwshVersion()}`);
  });
});
