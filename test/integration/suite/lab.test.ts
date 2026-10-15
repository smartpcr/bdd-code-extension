// session: lab
// B9.3 / E-B10: the portable stage 0 cases run from the editor against a real
// lab, then the same command from a terminal, and the two reports compared.
// The lab is named at run time (BDD_LAB_API_URL, BDD_LAB_ID,
// BDD_LAB_CONNECTION_FILE) and its footprint accepted (BDD_LAB_ACCEPT_FOOTPRINT=1);
// without them the preflight still runs, and the lab half is reported BLOCKED.
import * as assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ItemResult, parseNUnit } from '../../../src/core/trace';
import type { StepInfo, SuiteFile } from '../../../src/core/types';
import { listCommand } from '../../../src/tools/profiles';
import { runTool } from '../../../src/tools/runTool';
import { api, folder } from './helpers';
import { setting } from './lintHelpers';

const G = vscode.ConfigurationTarget.Global;
const REL = 'test/e2e/suites/lifecycle-stage0.yml';
const TAG = 'portable';
const BOOTSTRAP_CASE = 'S0-48-ready-host-bootstrap-is-verified';
const repo = path.resolve(__dirname, '../../../..');
const lab = {
  apiUrl: process.env.BDD_LAB_API_URL ?? '',
  labId: process.env.BDD_LAB_ID ?? '',
  connectionFile: process.env.BDD_LAB_CONNECTION_FILE ?? '',
};
const missingLab = Object.entries({ BDD_LAB_API_URL: lab.apiUrl, BDD_LAB_ID: lab.labId, BDD_LAB_CONNECTION_FILE: lab.connectionFile })
  .filter(([, v]) => !v).map(([k]) => k);

/** Every action a set of cases uses: their steps, the hooks that run around them, and meta steps followed into libraries. */
function actionsUsed(index: { visibleMetaSteps(f: string): Map<string, { file: string; def: { name: string } }>; suite(f: string): SuiteFile | undefined },
  suite: SuiteFile, cases: Set<string>): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (steps: StepInfo[], depth: number) => {
    for (const s of steps) {
      if (s.action) out.add(s.action);
      if (s.meta === undefined || depth >= 5) continue;
      const target = index.visibleMetaSteps(s.file).get(s.meta);
      if (!target || seen.has(`${target.file}#${target.def.name}`)) continue;
      seen.add(`${target.file}#${target.def.name}`);
      const lib = index.suite(target.file)!;
      walk(lib.steps.filter(x => x.home.kind === 'meta' && x.home.metaName === target.def.name), depth + 1);
    }
  };
  walk(suite.steps.filter(s => (s.home.kind === 'case' && cases.has(s.home.caseName))
    || (s.home.kind === 'hook' && (s.home.caseName === undefined || cases.has(s.home.caseName)))), 0);
  return out;
}

describe('E-B10 / B9.3 the portable stage 0 cases from the editor against a real lab', function () {
  this.timeout(0); // No run timeout of the harness's own: the suite's limits apply (plan 2.6).
  let preflight: string[] = [];

  // The test instance's user settings are shared with the offline sessions; leave them as found.
  after(async () => {
    for (const key of ['targetBinding', 'lab.apiUrl', 'lab.labId', 'lab.connectionFile']) {
      await vscode.workspace.getConfiguration('bddSuite').update(key, undefined, G);
    }
  });

  it('preflight: `list --tags portable` names exactly the index\'s portable cases, and every action they use lists go', async () => {
    const a = await setting('targetBinding', 'go', G, x => x.controllers[0].target === 'go');
    const ix = a.indexers[0];
    const go = ix.layout.bindings.find(b => b.name === 'go')!;
    const r = await runTool(listCommand(go, ix.layout.root, REL, [TAG]));
    assert.ok(r.kind === 'exited' && r.code === 0, `list failed: ${JSON.stringify(r).slice(0, 400)}`);
    const listed = (r as { stdout: string }).stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      .map(l => l.split(/\s{2,}/)[1]);
    const suite = ix.index.suite(path.join(folder(), REL))!;
    const indexed = suite.cases.filter(c => [...suite.tags, ...c.tags].includes(TAG)).map(c => c.name);
    assert.deepStrictEqual([...listed].sort(), [...indexed].sort(), '(a) the program and the index agree on the selection');
    const catalog = ix.index.catalog!;
    const actions = [...actionsUsed(ix.index, suite, new Set(indexed))].sort();
    const notGo = actions.filter(x => !catalog.actions.get(x)?.bindings.includes('go'));
    assert.deepStrictEqual(notGo, [], '(b) every action the selection uses is implemented by go');
    preflight = listed;
    console.log(`    ${listed.length} cases: ${listed.join(', ')}`);
    console.log(`    ${actions.length} actions, all listing go: ${actions.join(', ')}`);
  });

  it('footprint: stated, and accepted by the operator before anything runs', function () {
    console.log(`    Footprint: of the ${preflight.length} cases, ${BOOTSTRAP_CASE} submits a bootstrap to the ready host, which`
      + ' verifies it and leaves one succeeded run record of kind bootstrap per execution. The scenario runs the selection'
      + ' twice (editor, then terminal), so it leaves two. The other cases only read, or ask questions the API answers'
      + ' without acting. The extension owns nothing on the lab and cleans nothing up.');
    if (missingLab.length) throw new Error(`BLOCKED, not run: no lab was given (${missingLab.join(', ')} not set)`);
    if (process.env.BDD_LAB_ACCEPT_FOOTPRINT !== '1') throw new Error('BLOCKED, not run: set BDD_LAB_ACCEPT_FOOTPRINT=1 to accept the footprint above');
  });

  it('the editor run, confirmed after its contents are checked, and the terminal run of the printed command give the same report', async () => {
    if (missingLab.length || process.env.BDD_LAB_ACCEPT_FOOTPRINT !== '1') throw new Error('BLOCKED, not run: see the footprint step');
    assert.ok(preflight.length > 0, 'the preflight passed');
    let a = await setting('lab.apiUrl', lab.apiUrl, G, x => x.indexers[0].layout.settings['lab.apiUrl'] === lab.apiUrl);
    a = await setting('lab.labId', lab.labId, G, x => x.indexers[0].layout.settings['lab.labId'] === lab.labId);
    a = await setting('lab.connectionFile', lab.connectionFile, G, x => x.indexers[0].layout.settings['lab.connectionFile'] === lab.connectionFile);
    await a.ready;
    const t = a.testing;
    let confirmed: { binding: string; labId: string; apiUrl: string; cases: string[] } | undefined;
    const saved = t.ui;
    t.ui = {
      askLab: async () => { throw new Error('every lab value is set; nothing should be asked'); },
      confirmLab: async d => {
        confirmed = d;
        assert.strictEqual(d.binding, 'Go');
        assert.strictEqual(d.labId, lab.labId);
        assert.strictEqual(d.apiUrl, lab.apiUrl);
        assert.deepStrictEqual(d.cases.map(l => l.split(/\s{2,}/)[1]).sort(), [...preflight].sort());
        return true;
      },
      confirmStop: async () => false,
    };
    const started = new Date();
    try {
      const file = t.controller.items.get(REL)!;
      const items: vscode.TestItem[] = [];
      file.children.forEach(c => { if (c.tags.some(x => x.id === TAG)) items.push(c); });
      assert.deepStrictEqual(items.map(i => i.label).sort(), [...preflight].sort(), 'Test Explorer\'s tag filter selects the preflight\'s cases');
      t.results.clear();
      await t.runProfile.runHandler(new vscode.TestRunRequest(items), new vscode.CancellationTokenSource().token);
    } finally {
      t.ui = saved;
    }
    assert.ok(confirmed, 'the confirmation was shown');
    const argv = t.lastCommand.get(REL)!;
    const at = (flag: string) => argv[argv.indexOf(flag) + 1];
    const stamp = started.toISOString().replace(/[:.]/g, '-');
    const outDir = path.join(repo, 'artifacts', `lab-${stamp}`);
    fs.mkdirSync(outDir, { recursive: true });
    const editorReport = path.join(outDir, 'editor.xml');
    fs.copyFileSync(at('--results'), editorReport);
    const editor = parseNUnit(fs.readFileSync(editorReport, 'utf8'));

    // The printed command, from a terminal on the same machine, with its own results and trace paths.
    const terminalReport = path.join(outDir, 'terminal.xml');
    const terminalArgv = argv.map((v, i) => (argv[i - 1] === '--results' ? terminalReport : argv[i - 1] === '--trace-file' ? path.join(outDir, 'terminal-trace.json') : v));
    const code = await new Promise<number | null>(resolve => {
      const child = spawn(terminalArgv[0], terminalArgv.slice(1), { cwd: a.indexers[0].layout.root, stdio: 'inherit' });
      child.on('exit', c => resolve(c));
    });
    const finished = new Date();
    assert.strictEqual(code, 0, 'the terminal run exits 0');
    const terminal = parseNUnit(fs.readFileSync(terminalReport, 'utf8'));

    const results: Map<string, ItemResult> = t.results;
    for (const name of preflight) {
      const item = [...results.entries()].find(([id]) => id.endsWith(`::${name}`))?.[1];
      assert.strictEqual(item?.state, 'passed', `${name} in the editor: ${JSON.stringify(item)}`);
      assert.strictEqual(terminal.get(name)?.result, 'Passed', `${name} in the terminal`);
      assert.strictEqual(editor.get(name)?.result, 'Passed', `${name} in the editor's report`);
    }
    const compare = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
      `Import-Module '${path.join(a.indexers[0].layout.root, 'scripts', 'e2e', 'ReportCompare.psm1')}'; `
      + `Test-ReportsEqual -Left '${editorReport}' -Right '${terminalReport}' -IgnoreOutput | ConvertTo-Json -Compress`], { encoding: 'utf8' });
    const verdict = JSON.parse(compare.stdout) as { equal: boolean; difference: string };
    assert.ok(verdict.equal, `the canonical reports differ: ${verdict.difference}`);

    const ids = (xml: string) => [...new Set(xml.match(/\b[0-9a-f]{32}\b/g) ?? [])].filter(id => id !== lab.labId);
    const bootstrapIds = [editorReport, terminalReport].map(f => ids(fs.readFileSync(f, 'utf8')));
    const record = {
      scenario: 'E-B10', step: 'B9.3',
      package: { sha256: process.env.BDD_VSIX_SHA256 ?? 'not run on a package', version: process.env.BDD_VSIX_VERSION },
      extensionCommit: spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      osContextCommit: spawnSync('git', ['-C', a.indexers[0].layout.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      labId: lab.labId, apiUrl: lab.apiUrl, started: started.toISOString(), finished: finished.toISOString(),
      cases: preflight, confirmation: confirmed, command: argv,
      reports: { editor: editorReport, terminal: terminalReport }, canonicalEqual: verdict.equal,
      idsInCapturedOutput: { editor: bootstrapIds[0], terminal: bootstrapIds[1] },
    };
    const out = path.join(repo, 'artifacts', `lab-acceptance-${started.toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(out, JSON.stringify(record, null, 2));
    console.log(`    E-B10 passed; recorded in ${out}`);
  });
});
