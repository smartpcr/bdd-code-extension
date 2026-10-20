// The PowerShell scenarios of docs/test-providers/design.md that the corpus
// harness (../harness/corpus.mjs --provider pester) does not cover:
//
//   E8   Invoke-Pester runs a file with one It per case and row in the NUnit3
//        report; -FullNameFilter and -TagFilter run BeforeAll and AfterAll once
//        around the selection; a failed teardown fails the container, not the
//        cases (the corpus harness checks every entry's trace)
//   E9   Pester's discovery lists each case and row by its exact name
//   E10  a guarded suite skips without the opt-in, with the reason, runs with
//        it, and no option value is in generated code
//   E12  generate.ps1 -Check fails until generate.ps1 runs; a suite that does
//        not lint stops generation with its finding
//
//   node samples/workspace/tests/powershell/scenarios.mjs [E8 E9 ...]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const wanted = process.argv.slice(2);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pester-scenarios-'));
const results = [];

function run(argv, env = {}) {
  const r = spawnSync('pwsh', ['-NoProfile', '-File', ...argv], { cwd: here, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}

const decode = t => t.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
let count = 0;
/** Invoke-Tests.ps1 on some files: each test case's name, result and reason, the fixtures, the markers, the exit code. */
function test(files, { env = {}, extra = [] } = {}) {
  const n = ++count;
  const xml = path.join(scratch, `r${n}.xml`);
  const record = path.join(scratch, `record-${n}.txt`);
  const r = run(['Invoke-Tests.ps1', '-Path', files.join(','), '-ResultsFile', xml, '-Output', 'None', ...extra], { BDD_SUITE_RECORD_PATH: record, ...env });
  const text = fs.existsSync(xml) ? fs.readFileSync(xml, 'utf8') : '';
  const attr = (tag, name) => decode(tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '');
  // A passed test is a self-closing <test-case .../>.
  const cases = [...text.matchAll(/<test-case\b([^>]*?)(\/>|>([\s\S]*?)<\/test-case>)/g)].map(m => ({
    name: attr(m[1], 'methodname'), suite: attr(m[1], 'classname'), result: attr(m[1], 'result'),
    reason: decode((m[3] ?? '').match(/<reason>\s*<message><!\[CDATA\[([\s\S]*?)\]\]><\/message>/)?.[1] ?? ''),
  }));
  const fixtures = [...text.matchAll(/<test-suite\b[^>]*type="TestFixture"[^>]*>/g)].map(m => ({ name: attr(m[0], 'name'), result: attr(m[0], 'result'), site: attr(m[0], 'site') }));
  const markers = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  return { cases, fixtures, markers, status: r.status, output: r.stdout + r.stderr };
}

const plan = config => JSON.parse(run([path.join(repo, 'runtimes', 'powershell', 'suiterun.ps1'), 'generate', '--config', path.join(here, config, 'bddsuite.tests.yaml'), '--plan']).stdout);

function scenario(id, title, body) {
  if (wanted.length && !wanted.includes(id)) return;
  const problems = [];
  const check = (ok, what) => { if (!ok) problems.push(what); };
  try {
    body(check);
  } catch (error) {
    problems.push(`threw: ${error.stack}`);
  }
  results.push({ id, title, problems });
  console.log(`${problems.length ? 'FAIL' : 'pass'}  pester ${id}  ${title}${problems.length ? '\n      ' + problems.join('\n      ') : ''}`);
}

const generated = run(['generate.ps1']);
if (generated.status !== 0) throw new Error(generated.stdout + generated.stderr);

scenario('E8', 'Invoke-Pester runs the suites; filters run the setup and teardown once around the selection', check => {
  const all = test(['shop'], { env: { BDD_SUITE_ALLOW_GUARDED: '1' } });
  const planned = plan('shop').suites.flatMap(s => s.cases.map(c => `${s.name} > ${c.name}`)).sort();
  check(JSON.stringify(all.cases.map(c => `${c.suite} > ${c.name}`).sort()) === JSON.stringify(planned), `one It per case and row: ${all.cases.length}, ${planned.length} planned`);

  const trace = path.join(scratch, 'one.trace.json');
  const one = test(['corpus/Hooks.Bdd.Tests.ps1'], { env: { BDD_SUITE_TRACE_FILE: trace }, extra: ['-FullNameFilter', 'hooks.first'] });
  check(one.cases.length === 1 && one.cases[0].name === 'first' && one.cases[0].result === 'Passed', `the name filter ran: ${JSON.stringify(one.cases)}`);
  const entries = fs.existsSync(trace) ? JSON.parse(fs.readFileSync(trace, 'utf8')) : [];
  check(entries.filter(e => e.phase === 'suite-setup').length === 1 && entries.filter(e => e.phase === 'suite-teardown').length === 1, 'setup and teardown once');
  check(!entries.some(e => e.case === 'second'), 'the unselected case is not traced');

  const tagged = test(['corpus'], { extra: ['-TagFilter', 'smoke'] });
  const plannedSmoke = plan('corpus').suites.flatMap(s => s.cases.filter(c => c.tags.includes('smoke')).map(c => c.name)).sort();
  check(JSON.stringify(tagged.cases.map(c => c.name).sort()) === JSON.stringify(plannedSmoke), `-TagFilter smoke runs the cases tagged smoke: ${tagged.cases.map(c => c.name)}; planned ${plannedSmoke}`);

  const teardown = test(['corpus/TeardownFails.Bdd.Tests.ps1']);
  check(teardown.cases.length === 1 && teardown.cases[0].result === 'Passed', `the case passed: ${JSON.stringify(teardown.cases)}`);
  check(teardown.fixtures.some(f => f.name === 'teardown-fails' && f.result === 'Failed' && f.site === 'TearDown'), `the container failed in its teardown: ${JSON.stringify(teardown.fixtures)}`);
  check(teardown.status === 1, `the run exits 1: ${teardown.status}`);
});

scenario('E9', 'discovery lists each case and row by its exact name', check => {
  for (const config of ['shop', 'corpus']) {
    const r = run(['Invoke-Tests.ps1', '-Path', config, '-SkipRun', '-Output', 'None']);
    const listed = r.stdout.split(/\r?\n/).filter(Boolean).sort();
    const planned = plan(config).suites.flatMap(s => s.cases.map(c => `${s.name}.${c.name}`)).sort();
    check(JSON.stringify(listed) === JSON.stringify(planned), `${config}: ${listed.length} listed, ${planned.length} planned; first ${listed.slice(0, 3)}`);
  }
});

scenario('E10', 'a guarded suite skips without the opt-in and runs with it', check => {
  const without = test(['shop/OrderPlacement.Bdd.Tests.ps1', 'shop/Shipping.Bdd.Tests.ps1'], { env: { BDD_SUITE_OPTION_STORE: 'outlet-7' } });
  const guarded = without.cases.filter(c => c.suite === 'order-placement');
  check(guarded.length === 3 && guarded.every(c => c.result === 'Skipped' && c.reason.includes('BDD_SUITE_ALLOW_GUARDED=1')), `guarded: ${JSON.stringify(guarded)}`);
  check(!without.markers.includes('order-placement-setup') && !without.markers.includes('order-placement-teardown'), `markers ${without.markers}`);
  const offline = without.cases.filter(c => c.suite === 'shipping');
  check(offline.length > 0 && offline.every(c => c.result === 'Passed'), `offline: ${JSON.stringify(offline)}`);
  const allowed = test(['shop/OrderPlacement.Bdd.Tests.ps1'], { env: { BDD_SUITE_ALLOW_GUARDED: '1' } });
  check(allowed.cases.length === 3 && allowed.cases.every(c => c.result === 'Passed'), `allowed: ${JSON.stringify(allowed.cases)}`);
  check(allowed.markers.filter(m => m === 'order-placement-setup').length === 1 && allowed.markers.filter(m => m === 'order-placement-teardown').length === 1, `markers ${allowed.markers}`);
  const code = ['shop', 'corpus'].flatMap(c => fs.readdirSync(path.join(here, c)).filter(f => f.endsWith('.Bdd.Tests.ps1')).map(f => fs.readFileSync(path.join(here, c, f), 'utf8'))).join('\n');
  check(!code.includes('outlet-7') && !code.includes('BDD_SUITE_OPTION'), 'an option value in generated code');
});

scenario('E12', 'generate -Check fails until generate runs; a lint error stops generation with its finding', check => {
  const suite = path.join(here, '..', 'suites', 'order-placement.yml');
  const original = fs.readFileSync(suite, 'utf8');
  const folder = path.join(here, 'shop');
  // Line ends aside: a Windows checkout with core.autocrlf holds CRLF, and a
  // file the generator wrote again holds LF, with the same text.
  const snapshot = () => [suite, ...fs.readdirSync(folder).sort().map(f => path.join(folder, f))]
    .map(f => `${f}\n${fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')}`).join('\n');
  const before = snapshot();
  const names = () => test(['shop/OrderPlacement.Bdd.Tests.ps1'], { env: { BDD_SUITE_ALLOW_GUARDED: '1' } }).cases.map(c => c.name);
  try {
    fs.writeFileSync(suite, `${original}\n  - name: a case added later\n    steps:\n      - then: it is listed\n        action: core.noop\n`);
    const stale = run(['generate.ps1', '-Check']);
    check(stale.status === 1 && /stale: OrderPlacement\.Bdd\.Tests\.ps1/.test(stale.stdout), `-Check names the stale file: ${stale.status} ${stale.stdout.slice(0, 200)}`);
    run(['generate.ps1']);
    check(run(['generate.ps1', '-Check']).status === 0, '-Check is 0 after generate');
    check(names().includes('a case added later'), 'an added case runs');
    fs.writeFileSync(suite, `${original}\n  - name: a case renamed\n    steps:\n      - then: it is listed\n        action: core.noop\n`);
    run(['generate.ps1']);
    const renamed = names();
    check(renamed.includes('a case renamed') && !renamed.includes('a case added later'), 'a renamed case replaces the old one');
    fs.writeFileSync(suite, original.replace('action: order.place', 'action: order.plaec'));
    const broken = run(['generate.ps1']);
    check(broken.status === 2 && /order-placement\.yml:\d+:\d+\s+E104/.test(broken.stdout + broken.stderr), `a lint error stops generation: ${(broken.stdout + broken.stderr).slice(0, 300)}`);
  } finally {
    fs.writeFileSync(suite, original);
    run(['generate.ps1']);
  }
  check(run(['generate.ps1', '-Check']).status === 0, 'the generated files are back');
  check(snapshot() === before, 'the suite and the generated files are byte for byte as they were');
});

fs.rmSync(scratch, { recursive: true, force: true });
const failed = results.filter(r => r.problems.length);
console.log(`\npester: ${results.length - failed.length} of ${results.length} scenarios pass.`);
process.exitCode = failed.length ? 1 : 0;
