// The Go scenarios of docs/test-providers/design.md that the corpus harness
// (../harness/corpus.mjs --provider go) does not cover, run against this module:
//
//   E5   go test -run selects one case with setup and teardown once around it;
//        BDD_SUITE_TAGS skips with "tag filter"; a failed teardown fails only
//        the parent test
//   E9   go test -list lists one TestSuite_<id> per suite; a -json run names
//        one subtest per case and row (Go rewrites spaces to underscores)
//   E10  a guarded suite skips without the opt-in, runs with it, and no option
//        value is in generated code
//   E11  under -parallel 8, cases of one suite never overlap (the generated
//        tests are sequential, as suiterun is; this checks that default)
//   E12  go generate follows the suites; --check fails until it runs; a suite
//        that does not lint clean stops generation with its finding
//
//   node samples/workspace/tests/go/scenarios.mjs [E5 E9 ...]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const wanted = process.argv.slice(2);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'go-scenarios-'));
const results = [];

function run(command, argv, env = {}, cwd = here) {
  const r = spawnSync(command, argv, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}

let count = 0;
/** go test -json on a package with a -run pattern; subtest results, parent results and markers. */
function test(pkg, pattern, env = {}, extra = []) {
  const record = path.join(scratch, `record-${++count}.txt`);
  const r = run('go', ['test', '-count=1', '-json', ...extra, '-run', pattern, `./${pkg}`], { BDD_SUITE_RECORD_PATH: record, ...env });
  const events = r.stdout.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  const outcome = e => ['pass', 'fail', 'skip'].includes(e.Action);
  const subtests = events.filter(e => e.Test?.includes('/') && outcome(e)).map(e => ({ name: e.Test, outcome: e.Action }));
  const parents = events.filter(e => e.Test && !e.Test.includes('/') && outcome(e)).map(e => ({ name: e.Test, outcome: e.Action }));
  const output = name => events.filter(e => e.Test === name && e.Action === 'output').map(e => e.Output).join('');
  const markers = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\n').filter(Boolean) : [];
  return { subtests, parents, output, markers, status: r.status, text: r.stdout + r.stderr };
}

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
  console.log(`${problems.length ? 'FAIL' : 'pass'}  go ${id}  ${title}${problems.length ? '\n      ' + problems.join('\n      ') : ''}`);
}

function plan(pkg) {
  const r = run('go', ['run', './cmd/suiterun', 'generate', '--config', path.join(here, pkg, 'bddsuite.tests.yaml'), '--plan'], {}, path.join(repo, 'runtimes', 'go'));
  return JSON.parse(r.stdout);
}

const generate = () => run('go', ['generate', './...']);
/** The exit code of generate --check on the shop package: 0 current, 1 stale. */
const staleness = () => run('go', ['tool', 'suiterun', 'generate', '--config', 'bddsuite.tests.yaml', '--check'], {}, path.join(here, 'shop')).status;

const vetted = run('go', ['vet', './...']);
if (vetted.status !== 0) throw new Error(vetted.stdout + vetted.stderr);

scenario('E5', 'go test runs one case, tags skip, and a failed teardown fails only the parent', check => {
  const trace = path.join(scratch, 'one.trace.json');
  const one = test('corpus', '^TestSuite_Hooks$/^first$', { BDD_SUITE_TRACE_FILE: trace });
  check(one.subtests.length === 1 && one.subtests[0].name === 'TestSuite_Hooks/first' && one.subtests[0].outcome === 'pass', `one case: ${JSON.stringify(one.subtests)}`);
  const entries = fs.existsSync(trace) ? JSON.parse(fs.readFileSync(trace, 'utf8')) : [];
  check(entries.filter(e => e.phase === 'suite-setup').length === 1 && entries.filter(e => e.phase === 'suite-teardown').length === 1, 'setup and teardown once');
  check(!entries.some(e => e.case === 'second'), 'the unselected case is not traced');

  const row = test('shop', '^TestSuite_OrderPlacement$/^rejects_a_bad_quantity_\\[qty=0\\]$', { BDD_SUITE_ALLOW_GUARDED: '1' });
  check(row.subtests.length === 1 && row.subtests[0].outcome === 'pass', `one row: ${JSON.stringify(row.subtests)}`);
  check(row.markers.filter(m => m === 'order-placement-setup').length === 1 && row.markers.filter(m => m === 'order-placement-teardown').length === 1, `markers ${row.markers}`);

  const tagged = test('corpus', '^TestSuite_Tags$', { BDD_SUITE_TAGS: 'wanted' });
  const skipped = tagged.subtests.filter(s => s.outcome === 'skip');
  check(skipped.length === 1 && skipped[0].name === 'TestSuite_Tags/the-unselected-one', `tag skip: ${JSON.stringify(tagged.subtests)}`);
  check(tagged.output('TestSuite_Tags/the-unselected-one').includes('tag filter'), 'the skip says "tag filter"');

  const teardown = test('corpus', '^TestSuite_TeardownFails$');
  check(teardown.subtests.length === 1 && teardown.subtests[0].outcome === 'pass', `the case passed: ${JSON.stringify(teardown.subtests)}`);
  check(teardown.parents.some(p => p.name === 'TestSuite_TeardownFails' && p.outcome === 'fail'), 'the parent failed');
  check(teardown.output('TestSuite_TeardownFails').includes('The suite teardown of teardown-fails failed'), 'the parent names the teardown');
});

scenario('E9', 'go test -list lists each suite; a -json run names each case and row', check => {
  for (const pkg of ['shop', 'corpus']) {
    const listed = run('go', ['test', '-list', '.', `./${pkg}`]).stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('Test'));
    const planned = plan(pkg).suites;
    const want = planned.map(s => `TestSuite_${s.id}`).sort();
    check(JSON.stringify(listed.filter(l => l !== 'TestMain').sort()) === JSON.stringify(want), `${pkg} -list: ${listed.join(', ')}`);
    const all = test(pkg, '.', { BDD_SUITE_ALLOW_GUARDED: '1' });
    const names = planned.flatMap(s => s.cases.map(c => `TestSuite_${s.id}/${c.name.replace(/\s/g, '_')}`)).sort();
    check(JSON.stringify(all.subtests.map(s => s.name).sort()) === JSON.stringify(names), `${pkg}: ${all.subtests.length} subtests, ${names.length} planned`);
  }
});

scenario('E10', 'a guarded suite skips without the opt-in and runs with it', check => {
  const without = test('shop', '^TestSuite_(OrderPlacement|Shipping)$', { BDD_SUITE_OPTION_STORE: 'outlet-7' });
  const guarded = without.subtests.filter(s => s.name.startsWith('TestSuite_OrderPlacement/'));
  check(guarded.length === 3 && guarded.every(s => s.outcome === 'skip' && without.output(s.name).includes('BDD_SUITE_ALLOW_GUARDED=1')), `guarded: ${JSON.stringify(guarded)}`);
  check(!without.markers.includes('order-placement-setup') && !without.markers.includes('order-placement-teardown'), `markers ${without.markers}`);
  const offline = without.subtests.filter(s => s.name.startsWith('TestSuite_Shipping/'));
  check(offline.length > 0 && offline.every(s => s.outcome === 'pass'), `offline: ${JSON.stringify(offline)}`);
  const allowed = test('shop', '^TestSuite_OrderPlacement$', { BDD_SUITE_ALLOW_GUARDED: '1' });
  check(allowed.subtests.length === 3 && allowed.subtests.every(s => s.outcome === 'pass'), `allowed: ${JSON.stringify(allowed.subtests)}`);
  const code = ['shop', 'corpus'].flatMap(p => fs.readdirSync(path.join(here, p)).filter(f => f.endsWith('_bdd_test.go')).map(f => fs.readFileSync(path.join(here, p, f), 'utf8'))).join('\n');
  check(!code.includes('outlet-7') && !code.includes('BDD_SUITE_OPTION'), 'an option value in generated code');
});

scenario('E11', 'under -parallel 8, no two cases of one suite overlap', check => {
  for (let round = 1; round <= 10; round++) {
    const r = test('shop', '^TestSuite_Overlap', {}, ['-parallel', '8']);
    check(r.subtests.length === 9 && r.subtests.every(s => s.outcome === 'pass'), `round ${round}: ${JSON.stringify(r.subtests.filter(s => s.outcome !== 'pass'))}`);
    for (const suite of ['a', 'b', 'c']) {
      const own = r.markers.filter(m => m.startsWith(`overlap-${suite}:`)).map(m => m.split(':').slice(1).join(':'));
      for (let i = 0; i < own.length; i += 4) {
        const [before, start, end, after] = own.slice(i, i + 4);
        const name = start?.split(':')[0];
        if (!(before === 'before' && start === `${name}:start` && end === `${name}:end` && after === 'after')) {
          check(false, `round ${round}, overlap-${suite}: ${own.join(' ')}`);
          break;
        }
      }
      check(own.length === 12, `round ${round}, overlap-${suite}: ${own.length} markers`);
    }
  }
});

scenario('E12', 'go generate follows the suites; --check fails until it runs; a lint error stops it', check => {
  const suite = path.join(here, '..', 'suites', 'order-placement.yml');
  const original = fs.readFileSync(suite, 'utf8');
  const shop = path.join(here, 'shop');
  const snapshot = () => [suite, ...fs.readdirSync(shop).sort().map(f => path.join(shop, f))]
    .map(f => `${f}\n${fs.readFileSync(f, 'utf8')}`).join('\n');
  const before = snapshot();
  const subtestNames = () => test('shop', '^TestSuite_OrderPlacement$', { BDD_SUITE_ALLOW_GUARDED: '1' }).subtests.map(s => s.name);
  try {
    fs.writeFileSync(suite, original + '\n  - name: a case added later\n    steps:\n      - then: it is listed\n        action: core.noop\n');
    check(staleness() === 1, '--check is 1 after a suite changed');
    generate();
    check(staleness() === 0, '--check is 0 after go generate');
    check(subtestNames().includes('TestSuite_OrderPlacement/a_case_added_later'), 'an added case runs');
    fs.writeFileSync(suite, original + '\n  - name: a case renamed\n    steps:\n      - then: it is listed\n        action: core.noop\n');
    generate();
    const renamed = subtestNames();
    check(renamed.includes('TestSuite_OrderPlacement/a_case_renamed') && !renamed.includes('TestSuite_OrderPlacement/a_case_added_later'), 'a renamed case replaces the old one');
    fs.writeFileSync(suite, original.replace('action: order.place', 'action: order.plaec'));
    const broken = generate();
    check(broken.status !== 0 && /order-placement\.yml:\d+:\d+\s+E104/.test(broken.stdout + broken.stderr), `a lint error stops go generate with its finding: ${(broken.stdout + broken.stderr).slice(0, 300)}`);
  } finally {
    fs.writeFileSync(suite, original);
    generate();
  }
  check(staleness() === 0, 'the generated files are back to the committed ones');
  check(snapshot() === before, 'the suite and the shop package are byte for byte as they were');
});


fs.rmSync(scratch, { recursive: true, force: true });
const failed = results.filter(r => r.problems.length);
console.log(`\ngo: ${results.length - failed.length} of ${results.length} scenarios pass.`);
process.exitCode = failed.length ? 1 : 0;
