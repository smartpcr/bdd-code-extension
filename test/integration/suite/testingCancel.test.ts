// session: worktree
// B6.5 cancellation and the lab path of B6.4, with scratch suites in the
// worktree's sample. A lab suite is one using an action outside
// bddSuite.offlineActions (by default core.* and wait): here inventory.get.
// The lab path runs a fake binding program (test/fake-tool/fake-lab-runner.mjs)
// and answers the run's questions through SuiteTesting.ui, so nothing reaches a
// lab. E-B10 against a real lab is os-context's acceptance (S7, DEC-S11).
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ItemResult } from '../../../src/core/trace';
import type { RunUi } from '../../../src/features/testing';
import { KILL_GRACE_MS } from '../../../src/limits';
import { api, at, within } from './helpers';
import { setting } from './lintHelpers';

const W = vscode.ConfigurationTarget.Workspace;
const FAKE_LAB = path.resolve(__dirname, '../../../../test/fake-tool/fake-lab-runner.mjs');
const HANG = 'test/e2e/suites/_scratch-hang.yml';
const LAB = 'test/e2e/suites/_scratch-lab.yml';
const RUN_LOG = path.join(os.tmpdir(), 'bdd-b6-fake-lab-runs.jsonl');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function item(rel: string): Promise<vscode.TestItem> {
  const a = await api();
  await a.ready;
  await within(10_000, () => !!a.testing.controller.items.get(rel));
  return a.testing.controller.items.get(rel)!;
}

/** Start a run and hand back its cancellation and its completion. */
async function start(items: vscode.TestItem[]): Promise<{ cancel(): void; done: Promise<Map<string, ItemResult>> }> {
  const t = (await api()).testing;
  t.results.clear();
  const source = new vscode.CancellationTokenSource();
  const done = Promise.resolve(t.runProfile.runHandler(new vscode.TestRunRequest(items), source.token)).then(() => t.results);
  return { cancel: () => source.cancel(), done };
}

describe('B6.5 cancellation, and the lab path of B6.4 with a fake program', function () {
  this.timeout(300_000);
  let ui: RunUi;

  before(async () => {
    fs.writeFileSync(at(...HANG.split('/')).fsPath, `suite: scratch-hang
tests:
  - name: sleeps-for-ten-minutes
    timeoutSec: 900
    steps:
      - given: a step that would run for ten minutes
        action: core.sleep
        seconds: 600
        timeoutSec: 900
`);
    fs.writeFileSync(at(...LAB.split('/')).fsPath, `suite: scratch-lab
tests:
  - name: first
    steps:
      - when: the lab is read
        action: inventory.get
        sku: APPLE
  - name: second
    steps:
      - when: the lab is read again
        action: inventory.get
        sku: APPLE
`);
    const a = await api();
    ui = a.testing.ui;
  });

  after(async () => {
    const a = await api();
    a.testing.ui = ui;
    delete process.env.BDD_FAKE_RUN_LOG;
    for (const f of [HANG, LAB]) fs.rmSync(at(...f.split('/')).fsPath, { force: true });
    fs.rmSync(RUN_LOG, { force: true });
    for (const k of ['bindings', 'lab.apiUrl', 'lab.labId', 'lab.connectionFile']) await vscode.workspace.getConfiguration('bddSuite').update(k, undefined, W);
    await setting('targetBinding', undefined, W, x => x.indexers[0]?.layout.settings.targetBinding === 'powershell');
  });

  for (const binding of ['go', 'powershell']) {
    it(`B6.5-1 under ${binding}, cancelling an offline run leaves no child after KILL_GRACE_MS; the case is skipped "cancelled"`, async () => {
      const a = await setting('targetBinding', binding, W, x => x.indexers[0]?.layout.settings.targetBinding === binding);
      const hang = await item(HANG);
      const run = await start([hang]);
      await within(60_000, () => a.testing.running.has(HANG));
      const pids = [a.testing.running.get(HANG)!];
      await new Promise(r => setTimeout(r, 3000));
      assert.ok(pids.every(alive), 'the run is still sleeping before the cancel');
      const t0 = Date.now();
      run.cancel();
      const ms = await within(KILL_GRACE_MS, () => pids.every(p => !alive(p)));
      const results = await run.done;
      assert.ok(!a.testing.running.has(HANG) && !a.children.has(pids[0]));
      assert.deepStrictEqual(results.get(`${HANG}::sleeps-for-ten-minutes`), { state: 'skipped', message: 'cancelled' });
      console.log(`    ${binding}: the run's process was gone ${ms} ms after the cancel (${Date.now() - t0} ms to the result)`);
    });
  }

  it('B6.4 item 1 the lab scratch is a lab suite under the default offlineActions', async () => {
    const offline = (await api()).indexers[0].layout.settings.offlineActions;
    assert.deepStrictEqual(offline, ['core.*', 'wait']);
  });

  it('B6.4-1 / B6.4-2 a lab suite asks for the missing value, shows the list output, and Cancel starts nothing', async () => {
    const a = await setting('targetBinding', 'go', W, x => x.indexers[0]?.layout.settings.targetBinding === 'go');
    await setting('bindings', { go: { tool: ['node', FAKE_LAB] } }, W, x => x.indexers[0]?.layout.bindings.find(b => b.name === 'go')!.tool[1] === FAKE_LAB);
    const config = vscode.workspace.getConfiguration('bddSuite');
    await config.update('lab.apiUrl', 'https://lab.invalid/api/v1', W);
    await config.update('lab.connectionFile', 'C:/labs/lab-x.json', W);
    await within(10_000, () => a.indexers[0]?.layout.settings['lab.apiUrl'] === 'https://lab.invalid/api/v1');
    fs.rmSync(RUN_LOG, { force: true });
    process.env.BDD_FAKE_RUN_LOG = RUN_LOG;
    const asked: unknown[] = [];
    const shown: { binding: string; labId: string; apiUrl: string; cases: string[] }[] = [];
    a.testing.ui = {
      askLab: async (have, missing) => { asked.push(missing); return { ...have, labId: 'lab-x' }; },
      confirmLab: async d => { shown.push(d); return false; },
      confirmStop: async () => true,
    };
    const results = await (await start([await item(LAB)])).done;
    assert.deepStrictEqual(asked, [['labId']], 'only the missing value is asked');
    assert.deepStrictEqual(shown, [{ binding: 'Go', labId: 'lab-x', apiUrl: 'https://lab.invalid/api/v1',
      cases: ['_scratch-lab.yml  first', '_scratch-lab.yml  second'] }], 'B6.4-2: the confirmation lists the list output');
    assert.ok(!fs.existsSync(RUN_LOG), 'B6.4-1: nothing ran without the confirmation');
    assert.ok(!a.testing.lastCommand.has(LAB) && !a.testing.running.has(LAB), 'no run command was built or started');
    for (const c of ['first', 'second']) {
      assert.deepStrictEqual(results.get(`${LAB}::${c}`), { state: 'skipped', message: 'not run: the lab run was not confirmed' });
    }
  });

  it('0.8.1 lab.required: only the listed lab values are asked for and shown; a set value is still passed', async () => {
    const a = await setting('targetBinding', 'go', W, x => x.indexers[0]?.layout.settings.targetBinding === 'go');
    await setting('bindings', { go: { tool: ['node', FAKE_LAB] } }, W, x => x.indexers[0]?.layout.bindings.find(b => b.name === 'go')!.tool[1] === FAKE_LAB);
    const config = vscode.workspace.getConfiguration('bddSuite');
    await config.update('lab.apiUrl', '', W);
    await config.update('lab.connectionFile', 'C:/labs/lab-x.json', W);
    await config.update('lab.required', ['labId'], W);
    await within(10_000, () => a.indexers[0]?.layout.settings['lab.required']?.length === 1 && a.indexers[0]?.layout.settings['lab.apiUrl'] === '');
    try {
      fs.rmSync(RUN_LOG, { force: true });
      process.env.BDD_FAKE_RUN_LOG = RUN_LOG;
      const asked: unknown[] = [];
      const shown: { binding: string; labId: string; apiUrl: string; cases: string[] }[] = [];
      a.testing.ui = {
        askLab: async (have, missing) => { asked.push(missing); return { ...have, labId: 'lab-y' }; },
        confirmLab: async d => { shown.push(d); return true; },
        confirmStop: async () => true,
      };
      const results = await (await start([await item(LAB)])).done;
      assert.deepStrictEqual(asked, [['labId']], 'the empty API URL is not asked for: it is not required');
      assert.strictEqual(shown.length, 1);
      assert.strictEqual(shown[0].labId, 'lab-y');
      assert.strictEqual(shown[0].apiUrl, '', 'the confirmation shows only the required values');
      const argv = a.testing.lastCommand.get(LAB)!;
      assert.deepStrictEqual(argv.slice(argv.indexOf('--lab-id'), argv.indexOf('--lab-id') + 2), ['--lab-id', 'lab-y']);
      assert.ok(argv.includes('--connection-file'), 'a value that is set is passed even when it is not required');
      assert.ok(!argv.includes('--api-url'), 'an empty value is not passed');
      assert.ok(results.has(`${LAB}::first`), 'the confirmed run ran');
    } finally {
      await config.update('lab.required', undefined, W);
      await config.update('lab.apiUrl', undefined, W);
      await config.update('lab.connectionFile', undefined, W);
    }
  });

  it('B6.5 Stop ends a run that waits on an unanswered question, or on the confirmation, and starts nothing', async () => {
    const a = await api();
    fs.rmSync(RUN_LOG, { force: true });
    const never = new Promise<never>(() => undefined);
    const uis: [string, RunUi][] = [
      ['the lab values', { askLab: () => never, confirmLab: async () => true, confirmStop: async () => true }],
      ['the confirmation', { askLab: async have => ({ ...have, labId: 'lab-x' }), confirmLab: () => never, confirmStop: async () => true }],
    ];
    for (const [waitingOn, answers] of uis) {
      // Set when the run reaches the question that never answers.
      let waiting = false;
      a.testing.ui = {
        ...answers,
        askLab: (have, missing, token) => { if (waitingOn === 'the lab values') waiting = true; return answers.askLab(have, missing, token); },
        confirmLab: d => { if (waitingOn === 'the confirmation') waiting = true; return answers.confirmLab(d); },
      };
      const run = await start([await item(LAB)]);
      await within(30_000, () => waiting);
      const t0 = Date.now();
      run.cancel();
      const ended = await Promise.race([run.done.then(() => true), new Promise<false>(r => setTimeout(() => r(false), 5000))]);
      assert.ok(ended, `Stop ended the run waiting on ${waitingOn}`);
      const results = await run.done;
      for (const c of ['first', 'second']) {
        assert.deepStrictEqual(results.get(`${LAB}::${c}`), { state: 'skipped', message: 'not run: stopped before it started' }, `${waitingOn}: ${c}`);
      }
      assert.ok(!fs.existsSync(RUN_LOG) && !a.testing.running.has(LAB), `${waitingOn}: nothing ran`);
      console.log(`    waiting on ${waitingOn}: Stop ended the run in ${Date.now() - t0} ms`);
    }
  });

  it('B6.4 item 4 / B6.5-2 a confirmed lab run gets the lab values and is printed; a declined stop leaves it running; Stop kills it', async () => {
    const a = await api();
    let stop = false;
    a.testing.ui = { askLab: async have => ({ ...have, labId: 'lab-x' }), confirmLab: async () => true, confirmStop: async () => stop };
    let run = await start([await item(LAB)]);
    await within(30_000, () => fs.existsSync(RUN_LOG) && a.testing.running.has(LAB));
    const argv = JSON.parse(fs.readFileSync(RUN_LOG, 'utf8').trim().split('\n')[0]) as string[];
    assert.deepStrictEqual(argv.slice(argv.indexOf('--api-url')), ['--api-url', 'https://lab.invalid/api/v1', '--lab-id', 'lab-x', '--connection-file', 'C:/labs/lab-x.json']);
    assert.ok(a.log.some(l => l.startsWith('Run (Go, lab) in ') && l.includes('--lab-id lab-x')), 'the command line is in the output channel');
    const pids = [a.testing.running.get(LAB)!];
    run.cancel();
    await new Promise(r => setTimeout(r, 2000));
    assert.ok(pids.every(alive), 'B6.5-2: declining the stop leaves the lab run running');
    assert.strictEqual(await Promise.race([run.done.then(() => 'ended'), new Promise(r => setTimeout(() => r('running'), 100))]), 'running');
    for (const p of pids) {
      try {
        process.kill(p);
      } catch {
        // already gone
      }
    }
    await run.done;

    stop = true;
    run = await start([await item(LAB)]);
    await within(30_000, () => a.testing.running.has(LAB));
    const second = [a.testing.running.get(LAB)!];
    run.cancel();
    await within(KILL_GRACE_MS + 1000, () => second.every(p => !alive(p)));
    const results = await run.done;
    assert.deepStrictEqual(results.get(`${LAB}::first`), { state: 'skipped', message: 'cancelled' });
    console.log('    a declined stop left the lab run running; Stop killed it');
  });
});
