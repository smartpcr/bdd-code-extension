// The TypeScript scenarios of docs/test-providers/design.md that the corpus
// harness (../harness/corpus.mjs --provider node|vitest|jest|mocha) does not cover,
// for one framework:
//
//   E7   a name filter runs setup and teardown once around the one case; the
//        whole corpus at the framework's default workers loses and repeats no
//        trace entry (every test file appends its own to the one trace file)
//   E9   the framework's list (vitest list --json; jest --json with a filter
//        that matches nothing; node:test, which has none, a dry run's JUnit)
//        names every case and row exactly
//   E10  a guarded suite skips without the opt-in, runs with it, and no option
//        value is in generated code
//   E11  in the framework's most parallel setting, ten times, no two cases of
//        one suite overlap
//   E12  generate --check fails until generate runs; a suite that does not
//        lint stops generation with its finding
//
//   node samples/workspace/tests/typescript/scenarios.mjs --provider node|vitest|jest|mocha [E7 E9 ...]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const args = process.argv.slice(2);
const provider = args[args.indexOf('--provider') + 1];
if (!['node', 'vitest', 'jest', 'mocha'].includes(provider)) throw new Error('--provider node|vitest|jest|mocha');
const wanted = args.filter((a, i) => /^E\d+$/.test(a) && args[i - 1] !== '--provider');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `ts-scenarios-${provider}-`));
const results = [];

function run(command, argv, env = {}, cwd = here) {
  const r = spawnSync(command, argv, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}

const decode = t => t.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function junitRows(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return [...text.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)].map(m => {
    const attr = name => decode(m[1].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '');
    const body = m[3] ?? '';
    const reason = decode(body.match(/<skipped message="([^"]*)"/)?.[1] ?? '');
    return { name: attr('name'), classname: attr('classname'), outcome: /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed', reason };
  });
}

let count = 0;
/**
 * The framework on some generated files: each test's case name and outcome
 * (Vitest's "<describe> > <test>" cut to the test), the markers core.record
 * wrote, the exit code and the output.
 */
function test(files, { env = {}, filter, extra = [] } = {}) {
  const n = ++count;
  const junit = path.join(scratch, `junit-${n}.xml`);
  const record = path.join(scratch, `record-${n}.txt`);
  const environment = { BDD_SUITE_RECORD_PATH: record, JUNIT_FILE: junit, ...env };
  const r = provider === 'node'
    ? run('node', ['--test', '--test-reporter=@bdd-suite/runtime/testing/node-reporter', `--test-reporter-destination=${junit}`, ...(filter ? [`--test-name-pattern=${filter}`] : []), ...extra, ...files], environment)
    : provider === 'vitest'
      ? run('node', ['node_modules/vitest/vitest.mjs', 'run', ...(filter ? ['-t', filter] : []), ...extra, ...files], environment)
      : provider === 'mocha'
        ? run('node', ['node_modules/mocha/bin/mocha.js', ...(filter ? ['--grep', filter] : []), ...extra, ...files, '--reporter', 'xunit', '--reporter-option', `output=${junit}`], environment)
        : run('node', ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', ...(filter ? ['-t', filter] : []), ...extra, ...files], environment);
  const rows = junitRows(junit).map(row => ({ ...row, name: provider === 'vitest' && row.name.includes(' > ') ? row.name.slice(row.name.indexOf(' > ') + 3) : row.name }));
  const markers = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\n').filter(Boolean) : [];
  return { rows, markers, status: r.status, output: r.stdout + r.stderr };
}

const file = (config, id) => `${provider}/${config}/${id}.bdd.test.ts`;
/** Every generated file of a config: node --test and Mocha take a glob, the others a folder. */
const every = config => (['node', 'mocha'].includes(provider) ? `${provider}/${config}/*.bdd.test.ts` : `${provider}/${config}`);
const plan = config => JSON.parse(run('node', [path.join(repo, 'runtimes', 'typescript', 'dist', 'cli.js'), 'generate', '--config', path.join(here, 'shared', `${config}.tests.yaml`), '--plan']).stdout);

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
  console.log(`${problems.length ? 'FAIL' : 'pass'}  ${provider} ${id}  ${title}${problems.length ? '\n      ' + problems.join('\n      ') : ''}`);
}

const generated = run('node', ['generate.mjs']);
if (generated.status !== 0) throw new Error(generated.stdout + generated.stderr);

scenario('E7', 'a name filter runs setup and teardown once around it; the whole corpus at default workers keeps every trace entry', check => {
  const trace = path.join(scratch, 'one.trace.json');
  const one = test([file('corpus', 'Hooks')], { env: { BDD_SUITE_TRACE_FILE: trace }, filter: 'first' });
  const ran = one.rows.filter(r => r.outcome === 'passed');
  check(ran.length === 1 && ran[0].name === 'first', `the filter ran: ${JSON.stringify(one.rows)}`);
  const entries = fs.existsSync(trace) ? JSON.parse(fs.readFileSync(trace, 'utf8')) : [];
  check(entries.filter(e => e.phase === 'suite-setup').length === 1 && entries.filter(e => e.phase === 'suite-teardown').length === 1, 'setup and teardown once');
  check(!entries.some(e => e.case === 'second'), 'the unselected case is not traced');
  check(one.markers.includes('suite-setup') && one.markers.includes('suite-teardown') && !one.markers.includes('second-step'), `markers ${one.markers}`);

  const all = path.join(scratch, 'all.trace.json');
  const corpus = test([every('corpus')], { env: { BDD_SUITE_TRACE_FILE: all } });
  const planned = plan('corpus').suites.flatMap(s => s.cases.map(c => c.name)).sort();
  const traced = (fs.existsSync(all) ? JSON.parse(fs.readFileSync(all, 'utf8')) : []).filter(e => e.phase === 'case').map(e => e.case).sort();
  check(JSON.stringify(traced) === JSON.stringify(planned), `every case once in the one trace: ${traced.length} traced, ${planned.length} planned`);
  check(corpus.rows.filter(r => !r.teardown).length >= planned.length, `${corpus.rows.length} rows`);
});

scenario('E9', 'the list names every case and row exactly', check => {
  for (const config of ['shop', 'corpus']) {
    const planned = plan(config).suites.flatMap(s => s.cases.map(c => `${s.name} > ${c.name}`)).sort();
    let listed;
    if (provider === 'vitest') {
      // --json takes the file to write. Vitest 5 lists by parsing the source,
      // which cannot see tests a function declares; --staticParse=false runs
      // each file to collect them (the package's list:vitest script). It also
      // leaves out tests declared skipped, which a guarded suite's are without
      // the opt-in, so the list is made with it.
      const out = path.join(scratch, `vitest-${config}.json`);
      run('node', ['node_modules/vitest/vitest.mjs', 'list', '--staticParse=false', `--json=${out}`, `vitest/${config}`], { BDD_SUITE_ALLOW_GUARDED: '1' });
      listed = JSON.parse(fs.readFileSync(out, 'utf8')).map(t => t.name);
    } else if (provider === 'jest') {
      const out = path.join(scratch, `jest-${config}.json`);
      run('node', ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--json', `--outputFile=${out}`, '-t', 'a filter that matches nothing', `jest/${config}`]);
      listed = JSON.parse(fs.readFileSync(out, 'utf8')).testResults.flatMap(f => f.assertionResults.map(a => [...a.ancestorTitles, a.title].join(' > ')));
    } else if (provider === 'mocha') {
      // Mocha's --dry-run reports every test without running a hook or a test.
      listed = test([every(config)], { extra: ['--dry-run'] }).rows.map(r => `${r.classname} > ${r.name}`);
    } else {
      // node:test lists nothing; a dry run reports every test without running one.
      listed = test([every(config)], { env: { BDD_SUITE_DRY_RUN: '1' } }).rows.filter(r => r.classname).map(r => `${r.classname} > ${r.name}`);
    }
    check(JSON.stringify(listed.sort()) === JSON.stringify(planned), `${config}: ${listed.length} listed, ${planned.length} planned`);
  }
});

scenario('E10', 'a guarded suite skips without the opt-in and runs with it', check => {
  const without = test([file('shop', 'OrderPlacement'), file('shop', 'Shipping')], { env: { BDD_SUITE_OPTION_STORE: 'outlet-7' } });
  const guarded = without.rows.filter(r => ['places an order', 'rejects a bad quantity [qty=0]', 'rejects a bad quantity [qty=-1]'].includes(r.name));
  check(guarded.length === 3 && guarded.every(r => r.outcome === 'skipped'), `guarded: ${JSON.stringify(guarded)}`);
  if (provider === 'node') check(guarded.every(r => r.reason.includes('BDD_SUITE_ALLOW_GUARDED=1')), 'node:test shows the reason');
  check(!without.markers.includes('order-placement-setup') && !without.markers.includes('order-placement-teardown'), `markers ${without.markers}`);
  const offline = without.rows.filter(r => !guarded.includes(r) && !r.teardown && r.classname !== '');
  check(offline.length > 0 && offline.every(r => r.outcome === 'passed'), `offline: ${JSON.stringify(offline)}`);
  const allowed = test([file('shop', 'OrderPlacement')], { env: { BDD_SUITE_ALLOW_GUARDED: '1' } });
  check(allowed.rows.filter(r => r.outcome === 'passed').length === 3, `allowed: ${JSON.stringify(allowed.rows)}`);
  check(allowed.markers.filter(m => m === 'order-placement-setup').length === 1 && allowed.markers.filter(m => m === 'order-placement-teardown').length === 1, `markers ${allowed.markers}`);
  const code = ['shop', 'corpus'].flatMap(c => fs.readdirSync(path.join(here, provider, c)).map(f => fs.readFileSync(path.join(here, provider, c, f), 'utf8'))).join('\n');
  check(!code.includes('outlet-7') && !code.includes('BDD_SUITE_OPTION'), 'an option value in generated code');
});

scenario('E11', 'in the most parallel setting, ten times, no two cases of one suite overlap', check => {
  // node:test runs each file in its own process at once; Vitest also runs a
  // file's tests concurrently with --sequence.concurrent; Jest uses its
  // default workers.
  const extra = provider === 'vitest' ? ['--sequence.concurrent'] : provider === 'mocha' ? ['--parallel'] : [];
  let crossSuite = 0;
  for (let round = 1; round <= 10; round++) {
    const r = test(['a', 'b', 'c'].map(s => file('shop', `Overlap${s.toUpperCase()}`)), { extra });
    check(r.rows.filter(x => x.outcome === 'passed').length === 9, `round ${round}: ${JSON.stringify(r.rows.filter(x => x.outcome !== 'passed'))}`);
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
    for (let i = 0; i < r.markers.length; i++) {
      const start = r.markers[i].match(/^(overlap-.):(\w+):start$/);
      if (!start) continue;
      const end = r.markers.indexOf(`${start[1]}:${start[2]}:end`, i);
      if (r.markers.slice(i + 1, end).some(m => !m.startsWith(`${start[1]}:`))) crossSuite++;
    }
  }
  console.log(`      (cases whose run overlapped another suite's: ${crossSuite} over ten rounds)`);
});

scenario('E12', 'generate --check fails until generate runs; a lint error stops generation with its finding', check => {
  const suite = path.join(here, '..', 'suites', 'order-placement.yml');
  const original = fs.readFileSync(suite, 'utf8');
  const folder = path.join(here, provider, 'shop');
  const snapshot = () => [suite, ...fs.readdirSync(folder).sort().map(f => path.join(folder, f))].map(f => `${f}\n${fs.readFileSync(f, 'utf8')}`).join('\n');
  const before = snapshot();
  const names = () => test([file('shop', 'OrderPlacement')], { env: { BDD_SUITE_ALLOW_GUARDED: '1' } }).rows.map(r => r.name);
  const checkRun = () => run('node', ['generate.mjs', '--check']);
  try {
    fs.writeFileSync(suite, `${original}\n  - name: a case added later\n    steps:\n      - then: it is listed\n        action: core.noop\n`);
    const stale = checkRun();
    check(stale.status === 1 && /stale: OrderPlacement\.bdd\.test\.ts/.test(stale.stdout), `--check names the stale file: ${stale.status} ${stale.stdout.slice(0, 200)}`);
    run('node', ['generate.mjs']);
    check(checkRun().status === 0, '--check is 0 after generate');
    check(names().includes('a case added later'), 'an added case runs');
    fs.writeFileSync(suite, `${original}\n  - name: a case renamed\n    steps:\n      - then: it is listed\n        action: core.noop\n`);
    run('node', ['generate.mjs']);
    const renamed = names();
    check(renamed.includes('a case renamed') && !renamed.includes('a case added later'), 'a renamed case replaces the old one');
    fs.writeFileSync(suite, original.replace('action: order.place', 'action: order.plaec'));
    const broken = run('node', ['generate.mjs']);
    check(broken.status === 2 && /order-placement\.yml:\d+:\d+\s+E104/.test(broken.stdout + broken.stderr), `a lint error stops generation: ${(broken.stdout + broken.stderr).slice(0, 300)}`);
  } finally {
    fs.writeFileSync(suite, original);
    run('node', ['generate.mjs']);
  }
  check(checkRun().status === 0, 'the generated files are back');
  check(snapshot() === before, 'the suite and the generated files are byte for byte as they were');
});

fs.rmSync(scratch, { recursive: true, force: true });
const failed = results.filter(r => r.problems.length);
console.log(`\n${provider}: ${results.length - failed.length} of ${results.length} scenarios pass.`);
process.exitCode = failed.length ? 1 : 0;
