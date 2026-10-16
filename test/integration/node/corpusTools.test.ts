// B2.1 E2E (the parse-and-map half of E-B1) and B2.5's latency measurement:
// every binding program of the sample workspace, through the extension's
// runTool, lintCommand and parseLintOutput, no editor. The expectation is the
// lint oracle (harness/corpus.ts): what the five programs report when run
// directly. Each runtime proves the conformance corpus in its own CI job; this
// proves the extension's tool runner reproduces the binding CLI exactly.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { before, describe, it } from 'node:test';
import { DEFAULT_SETTINGS } from '../../../src/config/defaults';
import { WorkspaceLayout } from '../../../src/config/layout';
import { parseLintOutput } from '../../../src/core/diagnostics';
import { lintCommand } from '../../../src/tools/profiles';
import { runTool } from '../../../src/tools/runTool';
import { prepareSample, sig, ValidateEntry } from '../harness/corpus';
import { BINDINGS, sampleRoot, testStorage } from '../harness/sample';

const root = sampleRoot();
const layout = WorkspaceLayout.create(root, DEFAULT_SETTINGS, testStorage(), p => fs.existsSync(p))!;
const pwshVersion = (): string => execFileSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' }).trim();

describe('B2.1 E2E: each binding program, through runTool and parseLintOutput, against the lint oracle', () => {
  let entries: ValidateEntry[] = [];
  before(async () => {
    entries = await prepareSample(root);
  });

  it('the oracle has every sample suite against every target', () => {
    assert.ok(entries.length >= 40, `${entries.length} entries`);
    assert.ok(entries.some(e => e.exitCode !== 0) && entries.some(e => e.exitCode === 0));
    console.log(`    ${entries.length} oracle entries`);
  });
  for (const tool of BINDINGS) {
    it(`${tool}: every entry gives exactly the oracle's diagnostics and exit code`, async () => {
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
        if (JSON.stringify(got) !== JSON.stringify(want) || r.code !== e.exitCode) {
          mismatches.push(`${e.suite}: got [${got.join(', ')}] exit ${r.code}; want [${want.join(', ')}] exit ${e.exitCode}`);
        }
      }
      assert.deepStrictEqual(mismatches, [], `${tool} through the extension differs from the oracle`);
    });
  }
});

describe('B2.5 lint latency per program on large.yml (1 warm-up, 20 timed)', () => {
  for (const tool of BINDINGS) {
    it(`${tool}`, async () => {
      const binding = layout.bindings.find(b => b.name === tool)!;
      const cmd = lintCommand(binding, layout.root, 'test/e2e/suites/large.yml', 'powershell');
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
      console.log(`    | ${tool} | ${p(0.5)} | ${p(0.95)} | ${times[times.length - 1].toFixed(0)} |`);
    });
  }
  it('machine', () => {
    console.log(`    machine: ${os.cpus()[0].model}, ${os.cpus().length} logical CPUs, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.release()}; pwsh ${pwshVersion()}`);
  });
});
