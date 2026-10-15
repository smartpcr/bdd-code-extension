// B8.1-1: for every E-B1 validate entry, the lint worker (the bundled
// dist/lintWorker.js loading the real library from the checkout) gives exactly
// the diagnostics the `typescript` program prints. Runs only when the checkout
// carries the TypeScript binding (B7).
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it } from 'node:test';
import { DEFAULT_SETTINGS } from '../../../src/config/defaults';
import { WorkspaceLayout } from '../../../src/config/layout';
import { fileKey } from '../../../src/core/paths';
import { parseLintOutput } from '../../../src/core/diagnostics';
import { LintWorkerHost } from '../../../src/lint/workerHost';
import { lintCommand } from '../../../src/tools/profiles';
import { runTool } from '../../../src/tools/runTool';
import { validateEntries } from '../harness/corpus';
import { osContextRoot } from '../harness/worktree';

const repo = path.resolve(__dirname, '../../../..');
const root = osContextRoot();
const layout = WorkspaceLayout.create(root, DEFAULT_SETTINGS, path.join(repo, '.vscode-test'), p => fs.existsSync(p))!;
const binding = layout.bindings.find(b => b.name === 'typescript')!;
const library = path.resolve(layout.root, binding.library!);
const present = fs.existsSync(library);

describe('B8.1-1 the lint worker gives the typescript program\'s diagnostics', { skip: present ? false : `no library at ${library}` }, () => {
  it('every E-B1 validate entry, worker against program', async () => {
    const host = new LintWorkerHost({ workerPath: path.join(repo, 'dist', 'lintWorker.js'), gate: () => true });
    const { entries } = validateEntries(root);
    const mismatches: string[] = [];
    try {
      for (const e of entries) {
        const r = await runTool(lintCommand(binding, layout.root, e.rel, e.target));
        assert.strictEqual(r.kind, 'exited', e.suite);
        const program = parseLintOutput((r as { stdout: string }).stdout, (r as { code: number }).code);
        assert.ok(program.ok, e.suite);
        const file = fileKey(path.join(layout.root, e.rel));
        const w = await host.lint(file, library, layout.root, { paths: [file], binding: e.target, bindingCheck: true, strict: false, overlays: {} });
        assert.strictEqual(w.kind, 'result', `${e.suite}: ${JSON.stringify(w)}`);
        const worker = parseLintOutput(JSON.stringify((w as { diagnostics: unknown[] }).diagnostics), 0);
        assert.ok(worker.ok, e.suite);
        if (JSON.stringify(worker.value) !== JSON.stringify(program.value)) {
          mismatches.push(`${e.suite}:\n  worker  ${JSON.stringify(worker.value)}\n  program ${JSON.stringify(program.value)}`);
        }
      }
      assert.deepStrictEqual(mismatches, []);
      assert.strictEqual(host.workersStarted, 1, 'one worker served every entry');
      console.log(`    ${entries.length} entries: the worker's diagnostics equal the program's, field for field`);
    } finally {
      host.dispose();
    }
  });
});
