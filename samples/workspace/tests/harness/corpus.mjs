// Runs the conformance corpus, and the sample workspace's suites, through a
// test framework's generated tests, and compares what the framework reports
// with what the suite format requires (docs/test-providers, DEC-T12, T2.10).
//
//   node samples/workspace/tests/harness/corpus.mjs --provider mstest|nunit|xunit|go|rust [--only <suite id>] [--keep]
//
// For each execute entry of conformance/run-manifest.yaml (except those pending
// for the provider's runtime) it runs that suite's generated tests alone, with
// the entry's tags and parameters in the environment, and checks:
//   * the trace the run context wrote equals the entry's expected trace;
//   * each case's framework outcome matches its expected status (passed,
//     failed or error as a failure, skipped as not executed);
//   * a failed suite teardown is reported by the framework, and no passed case
//     is reported failed because of it.
// For each sample suite it checks the framework's outcome of every case
// against the sample's own suiterun for the same runtime.
//
// Provider specifics (how to build, run one suite, read results, name the
// teardown entry) are an adapter; later providers add theirs here.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const workspace = path.join(repo, 'samples', 'workspace');
const corpus = path.join(repo, 'conformance');

const args = process.argv.slice(2);
const option = name => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const providerName = option('--provider') ?? 'mstest';
const only = option('--only');
const keep = args.includes('--keep');

function run(command, argv, { cwd = repo, env = {}, allowFailure = true } = {}) {
  const started = Date.now();
  const result = spawnSync(command, argv, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${argv.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return { ...result, seconds: (Date.now() - started) / 1000 };
}

/** The ids the generator gives each suite file, from its own plan. */
function planIds(planText) {
  const plan = JSON.parse(planText);
  return new Map(plan.suites.map(suite => [suite.file, suite]));
}

const decode = text => text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Run one generated C# class with dotnet test; its TRX rows and run-level messages. */
function dotnetSuite(project, filter, trx, env, scratch) {
  const result = run('dotnet', ['test', '--no-build', '--filter', filter,
    '--logger', `trx;LogFileName=${trx}`, '--results-directory', scratch], { cwd: project, env });
  const file = path.join(scratch, trx);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const rows = [...text.matchAll(/<UnitTestResult [^>]*?testName="([^"]*)"[^>]*?outcome="([^"]*)"/g)]
    .map(m => ({ name: decode(m[1]), outcome: m[2] }));
  const runInfos = [...text.matchAll(/<RunInfo [^>]*?outcome="([^"]*)"[^>]*>\s*<Text>([\s\S]*?)<\/Text>/g)]
    .map(m => ({ outcome: m[1], text: decode(m[2]) }));
  return { rows, runInfos, output: result.stdout + result.stderr, seconds: result.seconds };
}

// What every adapter has: its runtime (for pendingIn), its corpus and sample
// configs and the scope each one's tests live in (a namespace, a package), how
// it builds, prints a plan, runs one suite, runs the sample's own suiterun for
// reference, the name a case's test has, its outcome words, and how it shows a
// failed teardown.
const csharpShared = path.join(workspace, 'tests', 'csharp', 'shared');
const csharp = {
  runtime: 'csharp',
  corpusConfig: path.join(csharpShared, 'corpus.tests.yaml'),
  sampleConfig: path.join(csharpShared, 'bddsuite.tests.yaml'),
  corpusScope: 'Corpus.Tests',
  sampleScope: 'Shop.Suite.Tests',
  cli: path.join(repo, 'runtimes', 'csharp', 'artifacts', 'bin', 'Bdd.Suite.Cli', 'Debug', 'net10.0', 'suiterun.dll'),
  sampleCli: path.join(workspace, 'test', 'e2e', 'bindings', 'dotnet', 'artifacts', 'bin', 'Suite.Cli', 'Debug', 'net10.0', 'suiterun.dll'),
  build() {
    run('dotnet', ['build', '-v', 'q'], { cwd: this.project, allowFailure: false });
  },
  plan(config) {
    return planIds(run('dotnet', [this.cli, 'generate', '--config', config, '--plan'], { allowFailure: false }).stdout);
  },
  reference(file, schemaRoot) {
    return run('dotnet', [this.sampleCli, 'run', '--schema-root', schemaRoot, '--path', file], { cwd: workspace });
  },
  runSuite(namespace, id, env, scratch) {
    return dotnetSuite(this.project, `FullyQualifiedName~${namespace}.Suite_${id}.`, `${this.name}.${namespace}.${id}.trx`, env, scratch);
  },
  testName: name => name,
  outcomeOf: status => ({ passed: 'Passed', failed: 'Failed', error: 'Failed', skipped: 'NotExecuted' })[status],
  isTeardownRow: () => false,
};

/** Go's test name for a subtest: spaces become underscores (testing.rewrite). */
const goName = name => name.replace(/\s/g, '_');

const goModule = path.join(workspace, 'tests', 'go');
const go = {
  name: 'go',
  runtime: 'go',
  corpusConfig: path.join(goModule, 'corpus', 'bddsuite.tests.yaml'),
  sampleConfig: path.join(goModule, 'shop', 'bddsuite.tests.yaml'),
  corpusScope: 'corpus',
  sampleScope: 'shop',
  build() {
    run('go', ['test', '-count=1', '-run', '^$', './...'], { cwd: goModule, allowFailure: false });
  },
  plan(config) {
    return planIds(run('go', ['run', './cmd/suiterun', 'generate', '--config', config, '--plan'],
      { cwd: path.join(repo, 'runtimes', 'go'), allowFailure: false }).stdout);
  },
  reference(file, schemaRoot) {
    return run('go', ['run', './cmd/suiterun', 'run', '--schema-root', schemaRoot, '--path', file],
      { cwd: path.join(workspace, 'test', 'e2e', 'bindings', 'go') });
  },
  /** One TestSuite_<id> with go test -json; its subtests' results, and its own output as the run-level messages. */
  runSuite(pkg, id, env) {
    const result = run('go', ['test', '-count=1', '-json', '-run', `^TestSuite_${id}$`, `./${pkg}`], { cwd: goModule, env });
    const events = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const parent = `TestSuite_${id}`;
    const rows = events.filter(e => e.Test?.startsWith(parent + '/') && ['pass', 'fail', 'skip'].includes(e.Action))
      .map(e => ({ name: e.Test.slice(parent.length + 1), outcome: e.Action }));
    const runInfos = events.filter(e => e.Test === parent && e.Action === 'output').map(e => ({ outcome: 'output', text: e.Output }));
    return { rows, runInfos, output: result.stdout + result.stderr, seconds: result.seconds };
  },
  testName: goName,
  outcomeOf: status => ({ passed: 'pass', failed: 'fail', error: 'fail', skipped: 'skip' })[status],
  isTeardownRow: () => false,
  /** A failed teardown fails the parent test, with its message in the parent's output. */
  teardownFailed: (pkg, id, rows, runInfos) => runInfos.some(info => info.text.includes('The suite teardown of')),
};

const rustCrate = path.join(workspace, 'tests', 'rust');
/** The trial names of one harness target, from its --list. */
const rustTrials = new Map();
function rustList(target) {
  if (!rustTrials.has(target)) {
    const listed = run('cargo', ['test', '-q', '--test', target, '--', '--list'], { cwd: rustCrate, allowFailure: false });
    rustTrials.set(target, listed.stdout.split('\n').filter(line => line.endsWith(': test')).map(line => line.slice(0, -': test'.length)));
  }
  return rustTrials.get(target);
}
const rust = {
  name: 'rust',
  runtime: 'rust',
  corpusConfig: path.join(rustCrate, 'corpus', 'bddsuite.tests.yaml'),
  sampleConfig: path.join(rustCrate, 'shop', 'bddsuite.tests.yaml'),
  corpusScope: 'corpus',
  sampleScope: 'shop',
  build() {
    run('cargo', ['test', '--no-run'], { cwd: rustCrate, allowFailure: false });
  },
  plan(config) {
    return planIds(run('cargo', ['run', '-q', '--', 'generate', '--config', config, '--plan'],
      { cwd: path.join(repo, 'runtimes', 'rust'), allowFailure: false }).stdout);
  },
  reference(file, schemaRoot) {
    return run('cargo', ['run', '-q', '--', 'run', '--schema-root', schemaRoot, '--path', file],
      { cwd: path.join(workspace, 'test', 'e2e', 'bindings', 'rust') });
  },
  /**
   * One suite's trials with cargo test's JSON output: the filter <id>:: and a
   * --skip for every other suite whose trials it would also match. The rows
   * are each trial's last event, named without the suite part; stderr is the
   * run-level message, where a teardown run by the last case reports.
   */
  runSuite(target, id, env) {
    const prefix = `${id}::`;
    const others = [...new Set(rustList(target).map(name => name.slice(0, name.indexOf('::') + 2)))]
      .filter(other => other !== prefix && other.includes(prefix));
    const result = run('cargo', ['test', '-q', '--test', target, '--', '--format', 'json', prefix, ...others.flatMap(other => ['--skip', other])],
      { cwd: rustCrate, env });
    const rows = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
      .filter(event => event.type === 'test' && ['ok', 'failed', 'ignored'].includes(event.event) && event.name.startsWith(prefix))
      .map(event => ({ name: event.name.slice(prefix.length), outcome: event.event }));
    return { rows, runInfos: [{ outcome: 'stderr', text: result.stderr }], output: result.stdout + result.stderr, seconds: result.seconds };
  },
  testName: name => name,
  outcomeOf: status => ({ passed: 'ok', failed: 'failed', error: 'failed', skipped: 'ignored' })[status],
  /** Every suite has a last <id>::teardown trial (teardown_2 when a case has that name). */
  isTeardownRow: (scope, id, row) => /^teardown(_\d+)?$/.test(row.name),
  teardownFailed: (scope, id, rows, runInfos) =>
    rows.some(row => /^teardown(_\d+)?$/.test(row.name) && row.outcome === 'failed') ||
    runInfos.some(info => info.text.includes(`${id}::teardown failed`)),
};

const adapters = {
  go,
  rust,
  nunit: {
    ...csharp,
    name: 'nunit',
    project: path.join(workspace, 'tests', 'csharp', 'nunit'),
    /** NUnit 4 reports a failed one-time tear-down as a run-level error (T0). */
    teardownFailed: (namespace, id, rows, runInfos) =>
      runInfos.some(info => info.outcome === 'Error' && info.text.includes(`TearDown failed for test fixture ${namespace}.Suite_${id}`)),
  },
  xunit: {
    ...csharp,
    name: 'xunit',
    project: path.join(workspace, 'tests', 'csharp', 'xunit'),
    /** xUnit v3 reports a failed class fixture disposal as a run-level cleanup failure (T0). */
    teardownFailed: (namespace, id, rows, runInfos) =>
      runInfos.some(info => info.text.includes(`[Test Class Cleanup Failure (${namespace}.Suite_${id})]`)),
  },
  mstest: {
    ...csharp,
    name: 'mstest',
    project: path.join(workspace, 'tests', 'csharp', 'mstest'),
    /** MSTest 4 reports a failed class cleanup as its own row (T0). */
    isTeardownRow: (namespace, id, row) => row.name === `[${namespace}.Suite_${id} ClassCleanup]`,
    teardownFailed: (namespace, id, rows) => rows.some(row => row.name === `[${namespace}.Suite_${id} ClassCleanup]` && row.outcome === 'Failed'),
  },
};

const adapter = adapters[providerName];
if (!adapter) throw new Error(`no adapter for provider ${providerName}`);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `corpus-${providerName}-`));
const failures = [];
const lines = trace => (trace ?? []).map(e => [e.phase, e.case ?? '', e.step ?? '', e.action ?? '', e.status, e.reason ?? ''].join(' | '));
const sortRows = rows => rows.map(r => `${r.name} => ${r.outcome}`).sort();

/**
 * A trace in the form two runs of one suite must share whatever order a test
 * framework ran its cases in (spec/session.md, rules 1 and 7): the suite
 * setup's entries first, exactly; the teardown's last, exactly; and in between
 * each case's entries as one unbroken group, the groups in name order. Cases
 * that interleaved make a group appear twice, which never matches.
 */
function canonicalTrace(trace) {
  const all = lines(trace);
  const entries = trace ?? [];
  const setup = all.filter((_, i) => entries[i].phase === 'suite-setup');
  const teardown = all.filter((_, i) => entries[i].phase === 'suite-teardown');
  const groups = [];
  entries.forEach((entry, i) => {
    if (entry.phase === 'suite-setup' || entry.phase === 'suite-teardown') return;
    const last = groups[groups.length - 1];
    if (last && last.name === entry.case) last.lines.push(all[i]);
    else groups.push({ name: entry.case, lines: [all[i]] });
  });
  const body = groups.map(group => group.lines.join('\n')).sort();
  // Setup must come before any case and teardown after every case.
  const firstCase = entries.findIndex(e => e.phase !== 'suite-setup');
  const misplacedSetup = entries.some((e, i) => e.phase === 'suite-setup' && firstCase >= 0 && i > firstCase);
  const lastCase = entries.map(e => e.phase !== 'suite-teardown').lastIndexOf(true);
  const misplacedTeardown = entries.some((e, i) => e.phase === 'suite-teardown' && i < lastCase);
  return JSON.stringify({ setup, body, teardown, misplacedSetup, misplacedTeardown });
}

console.log(`Building the ${providerName} test project...`);
adapter.build();

// ---------------------------------------------------------------- the corpus
const manifest = parse(fs.readFileSync(path.join(corpus, 'run-manifest.yaml'), 'utf8'));
const corpusPlan = adapter.plan(adapter.corpusConfig);
let checked = 0;
for (const entry of manifest.entries.filter(e => e.kind === 'execute')) {
  if ((entry.pendingIn ?? []).includes(adapter.runtime)) {
    console.log(`  pending   ${entry.suite}`);
    continue;
  }
  const suite = corpusPlan.get(`../../../../../conformance/${entry.suite}`);
  if (!suite) {
    failures.push(`${entry.suite}: not in the generated plan`);
    continue;
  }
  if (only && suite.id !== only) continue;
  const expected = JSON.parse(fs.readFileSync(path.join(corpus, entry.expectation), 'utf8'));
  const traceFile = path.join(scratch, `${suite.id}.trace.json`);
  const env = { BDD_SUITE_TRACE_FILE: traceFile, BDD_SUITE_TAGS: entry.tags ?? '' };
  for (const [name, value] of Object.entries(entry.params ?? {})) env[`BDD_SUITE_PARAM_${name.toUpperCase()}`] = String(value);
  const { rows, runInfos, output } = adapter.runSuite(adapter.corpusScope, suite.id, env, scratch);
  const problems = [];

  const produced = fs.existsSync(traceFile) ? JSON.parse(fs.readFileSync(traceFile, 'utf8')) : null;
  if (!produced) problems.push('no trace written');
  else if (canonicalTrace(produced) !== canonicalTrace(expected.trace)) {
    problems.push(`trace differs:\n      ${lines(produced).join('\n      ')}\n    expected:\n      ${lines(expected.trace).join('\n      ')}`);
  }

  const teardownRows = rows.filter(row => adapter.isTeardownRow(adapter.corpusScope, suite.id, row));
  const caseRows = rows.filter(row => !teardownRows.includes(row));
  const wanted = expected.trace.filter(e => e.phase === 'case').map(e => ({ name: adapter.testName(e.case), outcome: adapter.outcomeOf(e.status) }));
  if (sortRows(caseRows).join('\n') !== sortRows(wanted).join('\n')) {
    problems.push(`outcomes differ:\n      ${sortRows(caseRows).join('\n      ')}\n    expected:\n      ${sortRows(wanted).join('\n      ')}`);
  }
  const teardownFailed = expected.trace.some(e => e.phase === 'suite-teardown' && e.status === 'failed');
  const reported = adapter.teardownFailed(adapter.corpusScope, suite.id, rows, runInfos);
  if (teardownFailed && !reported) problems.push('the failed teardown is not reported');
  // A provider may list a teardown row whatever happened (Rust's teardown trial); only a failed one reports a failure.
  const failedTeardownRow = teardownRows.some(row => row.outcome === adapter.outcomeOf('failed'));
  if (!teardownFailed && (reported || failedTeardownRow)) problems.push('a teardown failure is reported that did not happen');

  checked++;
  console.log(`  ${problems.length ? 'DIFFERS' : 'matches'}   ${entry.suite} (${caseRows.length} case(s)${reported ? ', teardown failure reported' : ''})`);
  if (problems.length) failures.push(`${entry.suite}:\n    ${problems.join('\n    ')}\n    output tail: ${output.slice(-800)}`);
}

// --------------------------------------------------------- the sample suites
const samplePlan = adapter.plan(adapter.sampleConfig);
const sampleSchema = path.join(workspace, 'test', 'e2e', 'schema');
let samples = 0;
for (const suite of samplePlan.values()) {
  if (only && suite.id !== only) continue;
  const file = path.join(path.dirname(adapter.sampleConfig), suite.file);
  const reference = adapter.reference(file, sampleSchema);
  const wanted = [...reference.stdout.matchAll(/^\s+\[(\w+)\s*\] (.*)$/gm)]
    .filter(m => m[2] !== 'teardown')
    .map(m => ({ name: adapter.testName(m[2].trim()), outcome: adapter.outcomeOf(m[1]) }));
  // The reference runs guarded suites (suiterun always may); so does this run.
  const { rows } = adapter.runSuite(adapter.sampleScope, suite.id, { BDD_SUITE_ALLOW_GUARDED: '1' }, scratch);
  const caseRows = rows.filter(row => !adapter.isTeardownRow(adapter.sampleScope, suite.id, row));
  const same = sortRows(caseRows).join('\n') === sortRows(wanted).join('\n');
  samples++;
  console.log(`  ${same ? 'matches' : 'DIFFERS'}   sample ${suite.file} (${caseRows.length} case(s))`);
  if (!same) failures.push(`sample ${suite.file}:\n      ${sortRows(caseRows).join('\n      ')}\n    suiterun says:\n      ${sortRows(wanted).join('\n      ')}`);
}

if (!keep) fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${providerName}: ${checked} corpus entries and ${samples} sample suites checked; ${failures.length} differ.`);
if (failures.length) {
  console.log(failures.join('\n\n'));
  process.exitCode = 1;
}
