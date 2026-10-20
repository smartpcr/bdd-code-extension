// The Rust scenarios of docs/test-providers/design.md that the corpus harness
// (../harness/corpus.mjs --provider rust) does not cover, run against this crate:
//
//   E6   cargo test lists one trial per case and row and a teardown trial per
//        suite; --exact runs one case with setup and teardown once around it;
//        a teardown run by the last case (its trial filtered out) prints its
//        failure and exits 101; BDD_SUITE_TAGS ignores with "tag filter";
//        --format json works on stable
//   E9   --list shows each case and row by its exact name, <suite id>::<name>
//   E10  a guarded suite is ignored without the opt-in, runs with it, and no
//        option value is in the generated code
//   E11  with --test-threads 8, ten times, no two cases of one suite overlap
//        while different suites do
//   E12  a case added, renamed and removed shows at the next build with no
//        committed file changing; a suite that does not lint stops the build
//        with its finding
//
//   node samples/workspace/tests/rust/scenarios.mjs [E6 E9 ...]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const wanted = process.argv.slice(2);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-scenarios-'));
const results = [];

function run(command, argv, env = {}, cwd = here) {
  const r = spawnSync(command, argv, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}

let count = 0;
/**
 * One cargo test run of a harness target: each trial's outcome (and, in the
 * pretty format, the reason an ignored one gives), the markers core.record
 * wrote, the exit code and stderr.
 */
function test(target, args = [], env = {}) {
  const record = path.join(scratch, `record-${++count}.txt`);
  const r = run('cargo', ['test', '-q', '--test', target, '--', ...args], { BDD_SUITE_RECORD_PATH: record, ...env });
  const trials = [...r.stdout.matchAll(/^test (.+?) \.\.\. (ok|FAILED|ignored(?: \((.*)\))?)$/gm)]
    .map(m => ({ name: m[1].trim(), outcome: m[2].startsWith('ignored') ? 'ignored' : m[2] === 'ok' ? 'ok' : 'failed', reason: m[3] ?? '' }));
  const markers = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\n').filter(Boolean) : [];
  return { trials, markers, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const list = target => run('cargo', ['test', '-q', '--test', target, '--', '--list']).stdout
  .split('\n').filter(line => line.endsWith(': test')).map(line => line.slice(0, -': test'.length));

function plan(config) {
  const r = run('cargo', ['run', '-q', '--', 'generate', '--config', path.join(here, config), '--plan'], {}, path.join(repo, 'runtimes', 'rust'));
  return JSON.parse(r.stdout);
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
  console.log(`${problems.length ? 'FAIL' : 'pass'}  rust ${id}  ${title}${problems.length ? '\n      ' + problems.join('\n      ') : ''}`);
}

const built = run('cargo', ['test', '--no-run']);
if (built.status !== 0) throw new Error(built.stdout + built.stderr);

scenario('E6', 'cargo test runs the suites through the generated harness', check => {
  const listed = list('corpus');
  const planned = plan('corpus/bddsuite.tests.yaml').suites;
  const want = planned.flatMap(s => [...s.cases.map(c => `${s.id}::${c.name}`), `${s.id}::teardown`]).sort();
  check(JSON.stringify([...listed].sort()) === JSON.stringify(want), `--list: ${listed.length} trials, ${want.length} planned`);

  const trace = path.join(scratch, 'one.trace.json');
  const one = test('corpus', ['--exact', 'Hooks::first'], { BDD_SUITE_TRACE_FILE: trace });
  check(one.trials.length === 1 && one.trials[0].name === 'Hooks::first' && one.trials[0].outcome === 'ok', `one case: ${JSON.stringify(one.trials)}`);
  const entries = fs.existsSync(trace) ? JSON.parse(fs.readFileSync(trace, 'utf8')) : [];
  check(entries.filter(e => e.phase === 'suite-setup').length === 1 && entries.filter(e => e.phase === 'suite-teardown').length === 1, 'setup and teardown once around the one case');
  check(entries.findIndex(e => e.phase === 'suite-teardown') > entries.findIndex(e => e.phase === 'case'), 'the teardown after the case');
  check(!entries.some(e => e.case === 'second'), 'the unselected case is not traced');
  check(one.status === 0, `exit ${one.status}`);

  const lastCase = test('corpus', ['--exact', 'TeardownFails::a-case-that-passes']);
  check(lastCase.trials.length === 1 && lastCase.trials[0].outcome === 'ok', `the case passed: ${JSON.stringify(lastCase.trials)}`);
  check(lastCase.status === 101 && lastCase.stderr.includes('TeardownFails::teardown failed'), `a teardown the last case ran fails the run: exit ${lastCase.status}, ${lastCase.stderr.slice(0, 300)}`);
  const own = test('corpus', ['TeardownFails::']);
  const byName = Object.fromEntries(own.trials.map(t => [t.name, t.outcome]));
  check(byName['TeardownFails::a-case-that-passes'] === 'ok' && byName['TeardownFails::teardown'] === 'failed', `the teardown trial fails, the case does not: ${JSON.stringify(own.trials)}`);

  const tagged = test('corpus', ['Tags::'], { BDD_SUITE_TAGS: 'wanted' });
  const unselected = tagged.trials.find(t => t.name === 'Tags::the-unselected-one');
  check(unselected?.outcome === 'ignored' && unselected.reason === 'tag filter', `tag filter: ${JSON.stringify(tagged.trials)}`);

  const json = run('cargo', ['test', '-q', '--test', 'corpus', '--', '--format', 'json', '--exact', 'Hooks::first']);
  const events = json.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  check(events.some(e => e.type === 'test' && e.name === 'Hooks::first' && e.event === 'ok'), 'the JSON format on stable');

  const all = test('shop', ['--test-threads', '8']);
  const planShop = plan('shop/bddsuite.tests.yaml').suites;
  check(all.trials.length === planShop.reduce((n, s) => n + s.cases.length + 1, 0), `cargo test --test-threads 8: ${all.trials.length} trials`);
});

scenario('E9', 'the list shows one trial per case and row, by its exact name', check => {
  for (const [target, config] of [['shop', 'shop/bddsuite.tests.yaml'], ['corpus', 'corpus/bddsuite.tests.yaml']]) {
    const listed = list(target).filter(name => !/::teardown$/.test(name)).sort();
    const want = plan(config).suites.flatMap(s => s.cases.map(c => `${s.id}::${c.name}`)).sort();
    check(JSON.stringify(listed) === JSON.stringify(want), `${target}: ${listed.length} listed, ${want.length} planned`);
  }
  check(list('shop').includes('OrderPlacement::rejects a bad quantity [qty=-1]'), 'a row by its exact name');
});

scenario('E10', 'a guarded suite is ignored without the opt-in and runs with it', check => {
  const without = test('shop', ['--test-threads', '8'], { BDD_SUITE_OPTION_STORE: 'outlet-7' });
  const guarded = without.trials.filter(t => t.name.startsWith('OrderPlacement::') && t.name !== 'OrderPlacement::teardown');
  check(guarded.length === 3 && guarded.every(t => t.outcome === 'ignored' && t.reason.includes('BDD_SUITE_ALLOW_GUARDED=1')), `guarded: ${JSON.stringify(guarded)}`);
  check(!without.markers.includes('order-placement-setup') && !without.markers.includes('order-placement-teardown'), `markers ${without.markers}`);
  const offline = without.trials.filter(t => t.name.startsWith('Shipping::') && t.name !== 'Shipping::teardown');
  check(offline.length > 0 && offline.every(t => t.outcome === 'ok'), `offline: ${JSON.stringify(offline)}`);
  // With the opt-in every trial runs. The Rust binding alone does not implement
  // order.place (the sample catalog says so), so the case that places an order
  // fails here as it does under the binding's own suiterun; its rows pass.
  const allowed = test('shop', ['OrderPlacement::'], { BDD_SUITE_ALLOW_GUARDED: '1' });
  const outcomes = Object.fromEntries(allowed.trials.map(t => [t.name, t.outcome]));
  check(allowed.trials.length === 4 && !allowed.trials.some(t => t.outcome === 'ignored'), `allowed: ${JSON.stringify(allowed.trials)}`);
  check(outcomes['OrderPlacement::places an order'] === 'failed' && allowed.stdout.includes('Unknown action: order.place'), 'the case the binding cannot run fails on order.place');
  check(outcomes['OrderPlacement::rejects a bad quantity [qty=0]'] === 'ok' && outcomes['OrderPlacement::rejects a bad quantity [qty=-1]'] === 'ok', 'the rows pass');
  check(allowed.markers.filter(m => m === 'order-placement-setup').length === 1 && allowed.markers.filter(m => m === 'order-placement-teardown').length === 1, `markers ${allowed.markers}`);
  const generated = fs.readdirSync(path.join(here, 'target', 'debug', 'build'))
    .filter(name => name.startsWith('shop-suite-tests-'))
    .flatMap(name => ['shop.rs', 'corpus.rs'].map(file => path.join(here, 'target', 'debug', 'build', name, 'out', file)))
    .filter(file => fs.existsSync(file));
  check(generated.length > 0, 'the generated sources were found');
  const code = generated.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  check(!code.includes('outlet-7') && !code.includes('BDD_SUITE_OPTION'), 'an option value in generated code');
});

scenario('E11', 'with --test-threads 8, no two cases of one suite overlap while suites run in parallel', check => {
  let crossSuite = 0;
  for (let round = 1; round <= 10; round++) {
    const r = test('shop', ['--test-threads', '8', 'Overlap']);
    check(r.trials.length === 12 && r.trials.every(t => t.outcome === 'ok'), `round ${round}: ${JSON.stringify(r.trials.filter(t => t.outcome !== 'ok'))}`);
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
    // Another suite's marker between one case's start and end: suites ran at once.
    for (let i = 0; i < r.markers.length; i++) {
      const start = r.markers[i].match(/^(overlap-.):(\w+):start$/);
      if (!start) continue;
      const end = r.markers.indexOf(`${start[1]}:${start[2]}:end`, i);
      if (r.markers.slice(i + 1, end).some(m => !m.startsWith(start[1] + ':'))) crossSuite++;
    }
  }
  check(crossSuite > 0, 'the suites never ran at the same time, so the run proves nothing about parallel suites');
  console.log(`      (cases whose run overlapped another suite's: ${crossSuite} over ten rounds)`);
});

scenario('E12', 'a suite edit shows at the next build; a suite that does not lint stops it', check => {
  const suite = path.join(here, '..', 'suites', 'order-placement.yml');
  const original = fs.readFileSync(suite, 'utf8');
  const committed = () => ['Cargo.toml', 'build.rs', 'src/lib.rs', 'tests/shop.rs', 'tests/corpus.rs', 'shop/bddsuite.tests.yaml', 'corpus/bddsuite.tests.yaml']
    .map(file => fs.readFileSync(path.join(here, file), 'utf8')).join('\n');
  const before = committed();
  const listed = () => list('shop').filter(name => name.startsWith('OrderPlacement::'));
  const noRun = () => run('cargo', ['test', '--no-run']);
  try {
    fs.writeFileSync(suite, original + '\n  - name: a case added later\n    steps:\n      - then: it is listed\n        action: core.noop\n');
    check(noRun().status === 0, 'the build after an added case');
    check(listed().includes('OrderPlacement::a case added later'), 'an added case is a trial');
    fs.writeFileSync(suite, original + '\n  - name: a case renamed\n    steps:\n      - then: it is listed\n        action: core.noop\n');
    noRun();
    const renamed = listed();
    check(renamed.includes('OrderPlacement::a case renamed') && !renamed.includes('OrderPlacement::a case added later'), 'a renamed case replaces the old one');
    fs.writeFileSync(suite, original);
    noRun();
    check(!listed().some(name => name.includes('a case renamed')), 'a removed case is gone');
    fs.writeFileSync(suite, original.replace('action: order.place', 'action: order.plaec'));
    const broken = noRun();
    check(broken.status !== 0 && /order-placement\.yml:\d+:\d+\s+E104/.test(broken.stdout + broken.stderr), `a lint error stops the build with its finding: ${(broken.stdout + broken.stderr).slice(-600)}`);
  } finally {
    fs.writeFileSync(suite, original);
    noRun();
  }
  check(committed() === before, 'no file of the crate changed');
  check(fs.readFileSync(suite, 'utf8') === original, 'the suite is as it was');
});

fs.rmSync(scratch, { recursive: true, force: true });
const failed = results.filter(r => r.problems.length);
console.log(`\nrust: ${results.length - failed.length} of ${results.length} scenarios pass.`);
process.exitCode = failed.length ? 1 : 0;
