// session: worktree
// E-B9 (B6.1-B6.3): the sample's suites as test items, run under each binding
// through the TestController API. Each item's result is what that binding's
// own program reports when it runs the same file from a terminal (its trace),
// and the five bindings agree on every suite all five implement; smoke.yml
// (shop.state, PowerShell only) passes under PowerShell and fails elsewhere.
// One scratch suite adds what the sample's suites do not have: core.record
// (so a dry run can be seen to start no action), a failing assertion and a
// failing case setup.
// The worktree has no build output: Rust, C# and TypeScript run the main
// sample's programs (helpers.mainProgram), Go its program in the test
// profile's storage, PowerShell the worktree's suiterun.ps1. The sample's own
// actions are made offline (bddSuite.offlineActions), so no run asks for a lab;
// the lab path is testingCancel.test.ts.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ItemResult } from '../../../src/core/trace';
import { listCommand, runCommand } from '../../../src/tools/profiles';
import { runTool } from '../../../src/tools/runTool';
import { BINDINGS } from '../harness/sample';
import { api, at, mainProgram, restoreSample, sampleSnapshot, within } from './helpers';
import { setting } from './lintHelpers';

const W = vscode.ConfigurationTarget.Workspace;
const rel = (name: string) => `test/e2e/suites/${name}`;
const SCRATCH = rel('_scratch-b6-run.yml');
const SMOKE = rel('smoke.yml');
const FILES = [SMOKE, rel('checkout.yml'), rel('waiting.yml'), rel('shipping.yml'), SCRATCH];
const FAKE = path.resolve(__dirname, '../../../../test/fake-tool/fake-suiterun.mjs');
const STATE: Record<string, string> = { passed: 'passed', failed: 'failed', error: 'errored', skipped: 'skipped' };
const SCRATCH_TEXT = `suite: scratch-b6-run
description: What the sample's suites do not have, for testing.test.ts.
tests:
  - name: records-a-marker
    steps:
      - when: a marker is recorded
        action: core.record
        marker: ran
        captureAs: mark
      - then: it came back
        action: core.noop
        asserts:
          - var: mark.marker
            equals: ran
  - name: a-failure-says-the-sentence-and-the-keyword
    steps:
      - given: a value that is not what the next step claims
        action: core.set
        value: Up
        captureAs: state
      - then: it reads Paused, which it does not
        action: core.noop
        asserts:
          - var: state
            equals: Paused
  - name: the-one-whose-setup-fails
    setup:
      - action: core.fail
        message: this case could not be prepared
    steps:
      - when: this step would run
        action: core.noop
`;
/** The compiled bindings' programs: the main sample's, since the worktree has no build output. */
const TOOLS = () => ({
  rust: { tool: mainProgram('rust') }, csharp: { tool: mainProgram('csharp') }, typescript: { tool: mainProgram('typescript') },
});

async function fileItem(file: string): Promise<vscode.TestItem> {
  const a = await api();
  await within(10_000, () => !!a.testing.controller.items.get(file));
  return a.testing.controller.items.get(file)!;
}

const children = (item: vscode.TestItem) => {
  const out: vscode.TestItem[] = [];
  item.children.forEach(c => out.push(c));
  return out;
};

async function run(items: vscode.TestItem[], dry = false): Promise<Map<string, ItemResult>> {
  const t = (await api()).testing;
  t.results.clear();
  const source = new vscode.CancellationTokenSource();
  await (dry ? t.dryRunProfile : t.runProfile).runHandler(new vscode.TestRunRequest(items), source.token);
  return new Map(t.results);
}

const target = (b: string) => setting('targetBinding', b, W, a => a.indexers[0]?.layout.settings.targetBinding === b);
const bindingsSet = (value: unknown, done: (tool: string[]) => boolean) =>
  setting('bindings', value, W, a => done(a.indexers[0]?.layout.bindings.find(b => b.name === 'go')!.tool ?? []));

/** What the binding's program reports for `file` run from a terminal: case (or outline row) name -> item state. */
async function terminal(binding: string, file: string): Promise<Map<string, string>> {
  const ix = (await api()).indexers[0];
  const b = ix.layout.bindings.find(x => x.name === binding)!;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-b6-terminal-'));
  try {
    const traceFile = path.join(dir, 'trace.json');
    const r = await runTool(runCommand(b, ix.layout.root, file, { traceFile, resultsFile: path.join(dir, 'results.xml') }));
    assert.strictEqual(r.kind, 'exited', `${binding} ${file}: ${JSON.stringify(r)}`);
    const trace = JSON.parse(fs.readFileSync(traceFile, 'utf8')) as { phase: string; case?: string; status: string }[];
    return new Map(trace.filter(e => e.phase === 'case').map(e => [e.case!, STATE[e.status] ?? 'errored']));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('E-B9 a sample suite runs under each binding, and each case shows what the binding reports', function () {
  this.timeout(900_000);
  let snapshot: Map<string, Buffer>;

  before(async () => {
    snapshot = sampleSnapshot();
    fs.writeFileSync(at(...SCRATCH.split('/')).fsPath, SCRATCH_TEXT);
    const a = await api();
    // The sample's own actions are offline: they need nothing deployed.
    const own = [...a.indexers[0].index.catalog!.actions.values()].filter(x => !x.file).map(x => x.name);
    const offline = ['core.*', 'wait', ...own];
    await setting('offlineActions', offline, W, x => x.indexers[0]?.layout.settings.offlineActions.length === offline.length);
    await bindingsSet(TOOLS(), () => true);
    await within(10_000, async () => (await api()).indexers[0].layout.bindings.find(b => b.name === 'rust')!.tool[0] === mainProgram('rust')[0]);
    await fileItem(SCRATCH);
  });

  after(async () => {
    for (const k of ['bindings', 'offlineActions', 'targetBinding']) await vscode.workspace.getConfiguration('bddSuite').update(k, undefined, W);
    restoreSample(snapshot);
  });

  it('B6.1 / B6.1-1 every suite file, its cases and its outline rows are items; row names are the bindings\' names', async () => {
    const a = await api();
    await a.ready;
    const checkout = await fileItem(rel('checkout.yml'));
    const cases = children(checkout);
    assert.deepStrictEqual(cases.map(c => c.label), ['a-gold-customer-fills-a-cart', 'the-default-product-is-in-stock', 'a-standard-customer']);
    assert.deepStrictEqual(cases[0].tags.map(t => t.id), ['checkout'], 'suite-level tags are on each case');
    assert.deepStrictEqual(cases[1].tags.map(t => t.id).sort(), ['checkout', 'quick'], 'and a case\'s own');
    assert.ok(cases[0].range && cases[0].uri?.fsPath.toLowerCase().endsWith('checkout.yml'));

    const shipping = await fileItem(rel('shipping.yml'));
    const outline = children(shipping)[1];
    assert.strictEqual(outline.label, 'express-costs-double');
    const rowNames = children(outline).map(r => r.id.slice(`${rel('shipping.yml')}::`.length));
    // The binding's own names for the rows: what its program's `list` prints.
    const ix = a.indexers[0];
    const listed = await runTool(listCommand(ix.layout.bindings.find(b => b.name === 'go')!, ix.layout.root, rel('shipping.yml'), []));
    assert.strictEqual(listed.kind, 'exited');
    const names = (listed as { stdout: string }).stdout.split(/\r?\n/).filter(Boolean).map(l => l.slice(l.indexOf('  ') + 2));
    assert.deepStrictEqual(rowNames, names.filter(n => n.includes(' [')));
    assert.deepStrictEqual(children(outline).map(r => r.label), ['[weight=1, cost=10]', '[weight=4, cost=40]']);

    const tables = a.testing.controller.items.get(rel('flawed/tables.yml'))!;
    const ragged = tables.children.get(`${rel('flawed/tables.yml')}::ragged-rows`)!;
    assert.deepStrictEqual(children(ragged).map(r => r.label), ['[sku=APPLE]', '[sku=PEAR, extra=yes]'],
      'a suite lint rejects for a repeated row (E213) still lists, without the repeat');
    a.testing.refresh();
    assert.strictEqual(await fileItem(rel('shipping.yml')), shipping, 'a refresh keeps an item, so a run request holding it stays valid');
    assert.strictEqual(children(shipping)[1], outline);
    let count = 0;
    a.testing.controller.items.forEach(() => count++);
    const suites = a.indexers[0].index.suiteFiles().filter(s => s.hasSuiteKey).length;
    assert.strictEqual(count, suites, 'one item per suite file, no libraries');
    console.log(`    ${count} suite files as items; shipping rows: ${rowNames.join('; ')}`);
  });

  const signatures: string[] = [];
  for (const binding of BINDINGS) {
    it(`B6.2-1 / B6.3 under ${binding}: each item's result is what the program reports from a terminal; dry run starts no action`, async () => {
      await target(binding);
      // The program's own answer, from a terminal, before the record file is named.
      const expected = new Map<string, Map<string, string>>();
      for (const f of FILES) expected.set(f, await terminal(binding, f));
      const record = path.join(os.tmpdir(), `bdd-b6-record-${binding}.txt`);
      fs.rmSync(record, { force: true });
      process.env.BDD_SUITE_RECORD_PATH = record;
      try {
        const dry = await run([await fileItem(SCRATCH)], true);
        assert.ok(!fs.existsSync(record), 'B6.3-1: a dry run starts no action, so core.record writes nothing');
        for (const c of expected.get(SCRATCH)!.keys()) {
          assert.deepStrictEqual(dry.get(`${SCRATCH}::${c}`), { state: 'skipped', message: 'would run (dry run)' }, `dry ${c}`);
        }

        const sig: string[] = [];
        const byFile = new Map<string, Map<string, ItemResult>>();
        for (const f of FILES) {
          const results = await run([await fileItem(f)]);
          byFile.set(f, results);
          const want = expected.get(f)!;
          assert.ok(want.size > 0, `${binding} ${f}: the program reported no case`);
          for (const [c, state] of want) {
            const r = results.get(`${f}::${c}`);
            assert.strictEqual(r?.state, state, `${binding} ${f} ${c}: ${JSON.stringify(r)}`);
            if (f !== SMOKE) sig.push(`${f}::${c}=${r!.state}`);
          }
        }
        assert.ok(fs.existsSync(record), 'the normal run did start core.record (the control for B6.3-1)');
        const shipping = byFile.get(rel('shipping.yml'))!;
        assert.strictEqual(shipping.get(`${rel('shipping.yml')}::express-costs-double`)?.state, 'passed', 'the outline aggregates its rows');
        const scratch = byFile.get(SCRATCH)!;
        assert.strictEqual(scratch.get(`${SCRATCH}::records-a-marker`)?.state, 'passed');
        const failed = scratch.get(`${SCRATCH}::a-failure-says-the-sentence-and-the-keyword`)!;
        assert.match(failed.message!, /then it reads Paused, which it does not \(core\.noop\)/, 'the failing step\'s keyword and sentence');
        assert.match(failed.message!, /got 'Up'/, 'and the report\'s detail');
        const hook = scratch.get(`${SCRATCH}::the-one-whose-setup-fails`)!;
        assert.match(hook.message!, /^case setup: step 1 \(core\.fail\) failed \(action\)/);
        // shop.state is PowerShell's alone: every other binding fails both smoke cases at that step.
        const smoke = [...byFile.get(SMOKE)!].filter(([id]) => id.startsWith(`${SMOKE}::`));
        assert.strictEqual(smoke.length, 2);
        for (const [id, r] of smoke) {
          if (binding === 'powershell') assert.strictEqual(r.state, 'passed', id);
          else assert.ok(r.state === 'failed' && /shop\.state/.test(r.message ?? ''), `${id}: ${JSON.stringify(r)}`);
        }
        signatures.push(sig.join(', '));
        console.log(`    ${binding}: ${sig.length + smoke.length} items equal the program's own trace; dry run wrote no record`);
      } finally {
        delete process.env.BDD_SUITE_RECORD_PATH;
        fs.rmSync(record, { force: true });
      }
    });
  }

  it(`the ${BINDINGS.length} bindings give the same item results for every suite all of them implement`, () => {
    assert.strictEqual(signatures.length, BINDINGS.length);
    assert.ok(signatures.every(s => s === signatures[0]), signatures.join('\n'));
  });

  it('B6.2-2 a run that leaves no trace marks every item errored "no trace"', async () => {
    try {
      await target('go');
      await bindingsSet({ ...TOOLS(), go: { tool: ['node', FAKE, '--exit=1'] } }, tool => tool[1] === FAKE);
      const item = await fileItem(SCRATCH);
      const results = await run([item]);
      for (const c of children(item)) assert.deepStrictEqual(results.get(c.id), { state: 'errored', message: 'no trace' }, c.id);
    } finally {
      await bindingsSet(TOOLS(), tool => tool[1] !== FAKE);
    }
  });

  it('B6.2 item 3 one case under PowerShell runs that case only (--test-name); under Go the file runs and reports every case', async () => {
    await target('powershell');
    const checkout = await fileItem(rel('checkout.yml'));
    const one = children(checkout)[0];
    const ps = await run([one]);
    assert.deepStrictEqual([...ps.keys()], [one.id]);
    assert.strictEqual(ps.get(one.id)!.state, 'passed');
    assert.ok((await api()).testing.lastCommand.get(rel('checkout.yml'))!.includes('--test-name'));
    await target('go');
    const go = await run([one]);
    assert.strictEqual(go.get(one.id)!.state, 'passed');
    assert.ok(!(await api()).testing.lastCommand.get(rel('checkout.yml'))!.includes('--test-name'));
    assert.strictEqual(go.get(`${rel('checkout.yml')}::a-standard-customer`)?.state, 'passed', 'Go reports the cases it ran too');
  });
});
