// The C# scenarios of docs/test-providers/design.md that the corpus harness
// (../harness/corpus.mjs) does not cover, run against one provider's sample
// project (mstest/, nunit/, xunit/; their suites and configs are in shared/):
//
//   E4   filters run only what they select, with setup and teardown once each
//   E9   dotnet test --list-tests lists one test per case and row, by its name
//   E10  a guarded suite skips without the opt-in, runs with it, and no option
//        value is ever in generated code
//   E11  in the provider's most parallel setting, cases of one suite never overlap
//   E12  generated tests follow the suites at the next build; a suite that
//        does not lint clean stops the build with its finding
//
//   node samples/workspace/tests/csharp/scenarios.mjs [--provider mstest|nunit|xunit] [E4 E9 ...]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const shared = path.join(here, 'shared');
const cli = path.join(repo, 'runtimes', 'csharp', 'artifacts', 'bin', 'Bdd.Suite.Cli', 'Debug', 'net10.0', 'suiterun.dll');

// How each provider selects one test, a tag and a suite, and its most
// parallel setting (T0: NUnit's Name filter breaks on a space, so one test is
// its method; xUnit's tag trait is Category=; MSTest's Name= needs escaping).
const escapeMsTest = text => text.replace(/[\\()=!~&|]/g, m => '\\' + m);
const providers = {
  mstest: {
    assembly: 'Shop.Suite.MsTest',
    one: (ns, id, method, name) => `FullyQualifiedName~${ns}.Suite_${id}.&Name=${escapeMsTest(name)}`,
    tag: tag => `TestCategory=${tag}`,
    parallel: () => ['--settings', path.join(here, 'mstest', 'parallel.runsettings')],
  },
  nunit: {
    assembly: 'Shop.Suite.NUnit',
    one: (ns, id, method) => `FullyQualifiedName=${ns}.Suite_${id}.${method}`,
    tag: tag => `TestCategory=${tag}`,
    parallel: () => [], // nunit/Parallel.cs: fixtures and children in parallel, always
  },
  xunit: {
    assembly: 'Shop.Suite.XUnit',
    one: (ns, id, method) => `FullyQualifiedName=${ns}.Suite_${id}.${method}`,
    tag: tag => `Category=${tag}`,
    parallel: () => [], // test classes run in parallel by default; a class's tests never do
  },
};

const args = process.argv.slice(2);
const providerAt = args.indexOf('--provider');
const providerName = providerAt >= 0 ? args[providerAt + 1] : 'mstest';
const P = providers[providerName];
if (!P) throw new Error(`no provider ${providerName}`);
const wanted = args.filter((a, i) => /^E\d+$/.test(a) && i !== providerAt + 1);
const project = path.join(here, providerName);
const generated = path.join(here, 'artifacts', 'obj', P.assembly, 'Debug', 'net10.0', 'BddSuite');
const suiteFilter = (ns, id) => `FullyQualifiedName~${ns}.Suite_${id}.`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `${providerName}-scenarios-`));
const results = [];

function run(command, argv, env = {}) {
  const r = spawnSync(command, argv, { cwd: project, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}

let trxCount = 0;
/** dotnet test with a filter; the TRX rows and the markers core.record wrote. */
function test(filter, env = {}, extra = []) {
  const name = `run-${++trxCount}.trx`;
  const record = path.join(scratch, `record-${trxCount}.txt`);
  const r = run('dotnet', ['test', '--no-build', ...(filter ? ['--filter', filter] : []), '--logger', `trx;LogFileName=${name}`,
    '--results-directory', scratch, ...extra], { BDD_SUITE_RECORD_PATH: record, ...env });
  const text = fs.existsSync(path.join(scratch, name)) ? fs.readFileSync(path.join(scratch, name), 'utf8') : '';
  const decode = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  // Each result's own tag, and its body only when the tag is not self-closing:
  // a body never reaches into the next result.
  const rows = [...text.matchAll(/<UnitTestResult\b([^>]*?)(\/?)>/g)].map(m => {
    const attribute = key => decode(m[1].match(new RegExp(`\\b${key}="([^"]*)"`))?.[1] ?? '');
    const start = m.index + m[0].length;
    const body = m[2] ? '' : text.slice(start, text.indexOf('</UnitTestResult>', start));
    return { name: attribute('testName'), outcome: attribute('outcome'), body: decode(body) };
  });
  const markers = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\n').filter(Boolean) : [];
  return { rows, markers, output: r.stdout + r.stderr, status: r.status };
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
  console.log(`${problems.length ? 'FAIL' : 'pass'}  ${providerName} ${id}  ${title}${problems.length ? '\n      ' + problems.join('\n      ') : ''}`);
}

function plan(config) {
  const r = spawnSync('dotnet', [cli, 'generate', '--config', path.join(shared, config), '--plan'], { encoding: 'utf8' });
  return JSON.parse(r.stdout);
}

const build = run('dotnet', ['build', '-v', 'q']);
if (build.status !== 0) throw new Error(build.stdout + build.stderr);

scenario('E4', 'filters select what they name, and setup and teardown run once around it', check => {
  // One case of a suite: hooks' setup and teardown once, only that case traced.
  const trace = path.join(scratch, 'one-case.trace.json');
  const one = test(P.one('Corpus.Tests', 'Hooks', 'First', 'first'), { BDD_SUITE_TRACE_FILE: trace });
  check(one.rows.length === 1 && one.rows[0].name === 'first' && one.rows[0].outcome === 'Passed', `one case: ${JSON.stringify(one.rows.map(r => r.name + ':' + r.outcome))}`);
  const entries = fs.existsSync(trace) ? JSON.parse(fs.readFileSync(trace, 'utf8')) : [];
  check(entries.filter(e => e.phase === 'suite-setup').length === 1, 'suite setup once');
  check(entries.filter(e => e.phase === 'suite-teardown').length === 1, 'suite teardown once');
  check(!entries.some(e => e.case === 'second'), 'the unselected case is not traced');

  // One examples row.
  const row = test(P.one('Shop.Suite.Tests', 'OrderPlacement', 'RejectsABadQuantityQty0', 'rejects a bad quantity [qty=0]'), { BDD_SUITE_ALLOW_GUARDED: '1' });
  check(row.rows.length === 1 && row.rows[0].name === 'rejects a bad quantity [qty=0]' && row.rows[0].outcome === 'Passed',
    `one row: ${JSON.stringify(row.rows.map(r => r.name + ':' + r.outcome))}`);
  check(row.markers.filter(m => m === 'order-placement-setup').length === 1 && row.markers.filter(m => m === 'order-placement-teardown').length === 1,
    `setup and teardown once around one row: ${row.markers.join(',')}`);

  // A tag: every case carrying it, and nothing else.
  const tagged = plan('bddsuite.tests.yaml').suites.flatMap(s => s.cases.filter(c => c.tags.includes('smoke')).map(c => c.name)).sort();
  const smoke = test(P.tag('smoke'), { BDD_SUITE_ALLOW_GUARDED: '1' });
  check(JSON.stringify(smoke.rows.map(r => r.name).sort()) === JSON.stringify(tagged), `tag smoke: ${smoke.rows.map(r => r.name).join(', ')} vs ${tagged.join(', ')}`);

  // A suite setup that fails: every case reports it.
  const failed = test(suiteFilter('Corpus.Tests', 'SetupFails'));
  check(failed.rows.length === 2 && failed.rows.every(r => r.outcome === 'Failed' && r.body.includes('Suite setup failed')), 'setup failure on each case');
});

scenario('E9', 'the list shows one test per case and row, by its exact name', check => {
  const listed = run('dotnet', ['test', '--no-build', '--list-tests']).stdout.split('\n').map(l => l.trim());
  const names = ['bddsuite.tests.yaml', 'corpus.tests.yaml'].flatMap(c => plan(c).suites.flatMap(s => s.cases.map(x => x.name)));
  const missing = names.filter(n => !listed.includes(n));
  check(missing.length === 0, `not listed: ${missing.join(', ')}`);
  const testsListed = listed.slice(listed.findIndex(l => l.startsWith('The following Tests are available')) + 1).filter(Boolean);
  check(testsListed.length === names.length, `${testsListed.length} listed, ${names.length} planned`);
});

scenario('E10', 'a guarded suite skips without the opt-in and runs with it', check => {
  const without = test(`${suiteFilter('Shop.Suite.Tests', 'OrderPlacement')}|${suiteFilter('Shop.Suite.Tests', 'Shipping')}`, { BDD_SUITE_OPTION_STORE: 'outlet-7' });
  const guarded = without.rows.filter(r => ['places an order', 'rejects a bad quantity [qty=0]', 'rejects a bad quantity [qty=-1]'].includes(r.name));
  check(guarded.length === 3 && guarded.every(r => r.outcome === 'NotExecuted' && r.body.includes('BDD_SUITE_ALLOW_GUARDED=1')), `guarded: ${JSON.stringify(guarded.map(r => r.outcome))}`);
  check(!without.markers.includes('order-placement-setup') && !without.markers.includes('order-placement-teardown'), `no setup or teardown: ${without.markers.join(',')}`);
  const offline = without.rows.filter(r => !guarded.includes(r));
  check(offline.length > 0 && offline.every(r => r.outcome === 'Passed'), `offline suite: ${JSON.stringify(offline.map(r => r.name + ':' + r.outcome))}`);
  const allowed = test(suiteFilter('Shop.Suite.Tests', 'OrderPlacement'), { BDD_SUITE_ALLOW_GUARDED: '1' });
  check(allowed.rows.length === 3 && allowed.rows.every(r => r.outcome === 'Passed'), `with the opt-in: ${JSON.stringify(allowed.rows.map(r => r.outcome))}`);
  const code = fs.readdirSync(generated).map(f => fs.readFileSync(path.join(generated, f), 'utf8')).join('\n');
  check(!code.includes('outlet-7') && !code.includes('BDD_SUITE_OPTION'), 'an option value in generated code');
});

scenario('E11', 'in the most parallel setting, no two cases of one suite overlap', check => {
  for (let round = 1; round <= 10; round++) {
    const r = test(P.tag('overlap'), {}, P.parallel());
    check(r.rows.length === 9 && r.rows.every(x => x.outcome === 'Passed'), `round ${round}: ${r.rows.length} rows ${JSON.stringify(r.rows.filter(x => x.outcome !== 'Passed').map(x => x.name))}`);
    for (const suite of ['a', 'b', 'c']) {
      const own = r.markers.filter(m => m.startsWith(`overlap-${suite}:`)).map(m => m.split(':').slice(1).join(':'));
      // before, <case>:start, <case>:end, after, for each case, never interleaved.
      for (let i = 0; i < own.length; i += 4) {
        const [before, start, end, after] = own.slice(i, i + 4);
        const name = start?.split(':')[0];
        const ok = before === 'before' && start === `${name}:start` && end === `${name}:end` && after === 'after';
        if (!ok) { check(false, `round ${round}, overlap-${suite}: ${own.join(' ')}`); break; }
      }
      check(own.length === 12, `round ${round}, overlap-${suite}: ${own.length} markers`);
    }
  }
});

scenario('E12', 'generated tests follow the suites; a suite that does not lint stops the build', check => {
  const suite = path.join(here, '..', 'suites', 'order-placement.yml');
  const original = fs.readFileSync(suite, 'utf8');
  const listedNames = () => run('dotnet', ['test', '--list-tests']).stdout.split('\n').map(l => l.trim());
  try {
    fs.writeFileSync(suite, original + '\n  - name: a case added later\n    steps:\n      - then: it is listed\n        action: core.noop\n');
    check(listedNames().includes('a case added later'), 'an added case appears at the next build');
    fs.writeFileSync(suite, original + '\n  - name: a case renamed\n    steps:\n      - then: it is listed\n        action: core.noop\n');
    const renamed = listedNames();
    check(renamed.includes('a case renamed') && !renamed.includes('a case added later'), 'a renamed case replaces the old one');
    fs.writeFileSync(suite, original);
    check(!listedNames().includes('a case renamed'), 'a removed case disappears');
    fs.writeFileSync(suite, original.replace('action: order.place', 'action: order.plaec'));
    const broken = run('dotnet', ['build', '-v', 'q']);
    check(broken.status !== 0 && /order-placement\.yml\(\d+,\d+\): error E104/.test(broken.stdout + broken.stderr), 'a lint error stops the build with its finding');
  } finally {
    fs.writeFileSync(suite, original);
    run('dotnet', ['build', '-v', 'q']);
  }
  const status = spawnSync('git', ['status', '--porcelain', '--', suite], { cwd: here, encoding: 'utf8' }).stdout;
  check(!status.includes(' M '), `the suite is as it was: ${status}`);
});

fs.rmSync(scratch, { recursive: true, force: true });
const failed = results.filter(r => r.problems.length);
console.log(`\n${providerName}: ${results.length - failed.length} of ${results.length} scenarios pass.`);
process.exitCode = failed.length ? 1 : 0;
