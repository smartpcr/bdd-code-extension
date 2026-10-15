// session: oscontext
// E-B9 (B6.1-B6.3): the offline corpus suites as test items, run under each
// binding through the TestController API, each item's result equal to the
// corpus's expected trace. Runs write only to the extension's storage and to
// a temporary record file; the checkout is read only.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ItemResult } from '../../../src/core/trace';
import { api, folder } from './helpers';
import { setting } from './lintHelpers';

const G = vscode.ConfigurationTarget.Global;
const FILES = ['gherkin', 'case-setup-fails'];
const rel = (stem: string) => `test/e2e/conformance/execute/${stem}.yml`;
const FAKE = path.resolve(__dirname, '../../../../test/fake-tool/fake-suiterun.mjs');
const STATE: Record<string, string> = { passed: 'passed', failed: 'failed', error: 'errored', skipped: 'skipped' };

function expectedCases(stem: string): { case: string; status: string }[] {
  const t = JSON.parse(fs.readFileSync(path.join(folder(), 'test/e2e/conformance/execute', `${stem}.expected.json`), 'utf8'));
  return (t.trace as { phase: string; case: string; status: string }[]).filter(e => e.phase === 'case');
}

async function fileItem(stem: string): Promise<vscode.TestItem> {
  const item = (await api()).testing.controller.items.get(rel(stem));
  assert.ok(item, `${rel(stem)} is a test item`);
  return item;
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
  return t.results;
}

const target = (b: string) => setting('targetBinding', b, G, a => a.indexers[0]?.layout.settings.targetBinding === b);

describe('E-B9 an offline suite runs under each binding, and each case shows the corpus result', function () {
  this.timeout(600_000);

  it('B6.1 / B6.1-1 every suite file, its cases and its outline rows are items; row names are the bindings\' names', async () => {
    const a = await api();
    await a.ready;
    const gherkin = await fileItem('gherkin');
    const cases = children(gherkin);
    assert.deepStrictEqual(cases.map(c => c.label), ['a-scenario-that-reads-as-one', 'a-table-drives-three-rows-in-order',
      'an-outline-named-by-its-columns', 'a-failure-says-the-sentence-and-the-keyword']);
    const outline = cases[2];
    const rowNames = children(outline).map(r => r.id.slice(`${rel('gherkin')}::`.length));
    assert.deepStrictEqual(rowNames, expectedCases('gherkin').map(e => e.case).filter(n => n.includes(' [')));
    assert.deepStrictEqual(children(outline).map(r => r.label), ['[node=N1, expected=N1]', '[node=N2, expected=N2]']);
    assert.deepStrictEqual(cases[0].tags.map(t => t.id), ['conformance'], 'suite-level tags are on each case');
    assert.ok(cases[0].range && cases[0].uri?.fsPath.toLowerCase().endsWith('gherkin.yml'));
    const tables = a.testing.controller.items.get('test/e2e/conformance/validate/tables.yml')!;
    const twoRow = tables.children.get('test/e2e/conformance/validate/tables.yml::two-row-scopes')!;
    assert.deepStrictEqual(children(twoRow).map(r => r.label), ['[node=WSFC-N2]', '[node=WSFC-N3]'],
      'a suite lint rejects for a repeated row (E213) still lists, without the repeat');
    a.testing.refresh();
    assert.strictEqual(await fileItem('gherkin'), gherkin, 'a refresh keeps an item, so a run request holding it stays valid');
    assert.strictEqual(children(gherkin)[2], outline);
    let count = 0;
    a.testing.controller.items.forEach(() => count++);
    const suites = a.indexers[0].index.suiteFiles().filter(s => s.hasSuiteKey).length;
    assert.strictEqual(count, suites, 'one item per suite file, no libraries');
    console.log(`    ${count} suite files as items; gherkin rows: ${rowNames.join('; ')}`);
  });

  const signatures: string[] = [];
  for (const binding of ['go', 'rust', 'csharp', 'powershell']) {
    it(`B6.2-1 / B6.3 under ${binding}: results equal the expected traces; dry run starts no action`, async () => {
      await target(binding);
      const record = path.join(os.tmpdir(), `bdd-b6-record-${binding}.txt`);
      fs.rmSync(record, { force: true });
      process.env.HCI_SUITE_RECORD_PATH = record;
      try {
        const dry = await run([await fileItem('gherkin')], true);
        assert.ok(!fs.existsSync(record), 'B6.3-1: a dry run starts no action, so core.record writes nothing');
        for (const e of expectedCases('gherkin')) {
          assert.deepStrictEqual(dry.get(`${rel('gherkin')}::${e.case}`), { state: 'skipped', message: 'would run (dry run)' }, `dry ${e.case}`);
        }

        const sig: string[] = [];
        for (const stem of FILES) {
          const results = await run([await fileItem(stem)]);
          for (const e of expectedCases(stem)) {
            const r = results.get(`${rel(stem)}::${e.case}`);
            assert.strictEqual(r?.state, STATE[e.status], `${binding} ${stem} ${e.case}: ${JSON.stringify(r)}`);
            sig.push(`${stem}::${e.case}=${r!.state}`);
          }
        }
        assert.ok(fs.existsSync(record), 'the normal run did start core.record (the control for B6.3-1)');
        const all = await run([await fileItem('gherkin')]);
        assert.strictEqual(all.get(`${rel('gherkin')}::an-outline-named-by-its-columns`)?.state, 'passed', 'the outline aggregates its rows');
        const failed = all.get(`${rel('gherkin')}::a-failure-says-the-sentence-and-the-keyword`)!;
        assert.match(failed.message!, /then it reads Paused, which it does not \(core\.noop\)/, 'the failing step\'s keyword and sentence');
        assert.match(failed.message!, /got 'Up'/, 'and the report\'s detail');
        const hook = (await run([await fileItem('case-setup-fails')])).get(`${rel('case-setup-fails')}::the-one-whose-setup-fails`)!;
        assert.match(hook.message!, /^case setup: step 1 \(core\.fail\) failed \(action\)/);
        signatures.push(sig.join(', '));
        console.log(`    ${binding}: ${sig.length} items as expected; dry run wrote no record`);
      } finally {
        delete process.env.HCI_SUITE_RECORD_PATH;
        fs.rmSync(record, { force: true });
      }
    });
  }

  it('the four bindings produce the same item results', () => {
    assert.strictEqual(signatures.length, 4);
    assert.ok(signatures.every(s => s === signatures[0]));
  });

  it('B6.2-2 a run that leaves no trace marks every item errored "no trace"', async () => {
    try {
      await target('go');
      await setting('bindings', { go: { tool: ['node', FAKE, '--exit=1'] } }, G,
        a => a.indexers[0]?.layout.bindings.find(b => b.name === 'go')!.tool[1] === FAKE);
      const results = await run([await fileItem('gherkin')]);
      for (const e of expectedCases('gherkin')) {
        assert.deepStrictEqual(results.get(`${rel('gherkin')}::${e.case}`), { state: 'errored', message: 'no trace' }, e.case);
      }
    } finally {
      await setting('bindings', undefined, G, a => a.indexers[0]?.layout.bindings.find(b => b.name === 'go')!.tool[1] !== FAKE);
      await setting('targetBinding', undefined, G, a => a.indexers[0]?.layout.settings.targetBinding === 'powershell');
    }
  });

  it('B6.2 item 3 one case under PowerShell runs that case only (-TestName); under Go the file runs and reports every case', async () => {
    try {
      await target('powershell');
      const gherkin = await fileItem('gherkin');
      const one = children(gherkin)[0];
      const ps = await run([one]);
      assert.deepStrictEqual([...ps.keys()], [one.id]);
      assert.strictEqual(ps.get(one.id)!.state, 'passed');
      assert.ok((await api()).testing.lastCommand.get(rel('gherkin'))!.includes('-TestName'));
      await target('go');
      const go = await run([one]);
      assert.strictEqual(go.get(one.id)!.state, 'passed');
      assert.strictEqual(go.get(`${rel('gherkin')}::a-failure-says-the-sentence-and-the-keyword`)?.state, 'failed', 'Go reports the cases it ran too');
    } finally {
      await setting('targetBinding', undefined, G, a => a.indexers[0]?.layout.settings.targetBinding === 'powershell');
    }
  });
});
