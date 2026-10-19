// Runs the conformance corpus, and the sample workspace's suites, through a
// test framework's generated tests, and compares what the framework reports
// with what the suite format requires (docs/test-providers, DEC-T12, T2.10).
//
//   node samples/workspace/tests/harness/corpus.mjs --provider mstest [--only <suite id>] [--keep]
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

const adapters = {
  mstest: {
    runtime: 'csharp',
    project: path.join(workspace, 'tests', 'csharp', 'mstest'),
    cli: path.join(repo, 'runtimes', 'csharp', 'artifacts', 'bin', 'Bdd.Suite.Cli', 'Debug', 'net10.0', 'suiterun.dll'),
    sampleCli: path.join(workspace, 'test', 'e2e', 'bindings', 'dotnet', 'artifacts', 'bin', 'Suite.Cli', 'Debug', 'net10.0', 'suiterun.dll'),
    build() {
      run('dotnet', ['build', '-v', 'q'], { cwd: this.project, allowFailure: false });
    },
    plan(config) {
      return planIds(run('dotnet', [this.cli, 'generate', '--config', path.join(this.project, config), '--plan'], { allowFailure: false }).stdout);
    },
    /** Run one generated class; the framework's rows as { name, outcome }. */
    runSuite(namespace, id, env, scratch) {
      const trx = `${namespace}.${id}.trx`;
      const result = run('dotnet', ['test', '--no-build', '--filter', `FullyQualifiedName~${namespace}.Suite_${id}.`,
        '--logger', `trx;LogFileName=${trx}`, '--results-directory', scratch], { cwd: this.project, env });
      const file = path.join(scratch, trx);
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const rows = [...text.matchAll(/<UnitTestResult [^>]*?testName="([^"]*)"[^>]*?outcome="([^"]*)"/g)]
        .map(m => ({ name: decode(m[1]), outcome: m[2] }));
      return { rows, output: result.stdout + result.stderr, seconds: result.seconds };
    },
    outcomeOf: status => ({ passed: 'Passed', failed: 'Failed', error: 'Failed', skipped: 'NotExecuted' })[status],
    /** MSTest 4 reports a failed class cleanup as its own row (T0). */
    isTeardownRow: (namespace, id, row) => row.name === `[${namespace}.Suite_${id} ClassCleanup]`,
  },
};

const adapter = adapters[providerName];
if (!adapter) throw new Error(`no adapter for provider ${providerName}`);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `corpus-${providerName}-`));
const failures = [];
const lines = trace => (trace ?? []).map(e => [e.phase, e.case ?? '', e.step ?? '', e.action ?? '', e.status, e.reason ?? ''].join(' | '));
const sortRows = rows => rows.map(r => `${r.name} => ${r.outcome}`).sort();

console.log(`Building the ${providerName} test project...`);
adapter.build();

// ---------------------------------------------------------------- the corpus
const manifest = parse(fs.readFileSync(path.join(corpus, 'run-manifest.yaml'), 'utf8'));
const corpusPlan = adapter.plan('corpus.tests.yaml');
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
  const { rows, output } = adapter.runSuite('Corpus.Tests', suite.id, env, scratch);
  const problems = [];

  const produced = fs.existsSync(traceFile) ? JSON.parse(fs.readFileSync(traceFile, 'utf8')) : null;
  if (!produced) problems.push('no trace written');
  else if (lines(produced).join('\n') !== lines(expected.trace).join('\n')) {
    problems.push(`trace differs:\n      ${lines(produced).join('\n      ')}\n    expected:\n      ${lines(expected.trace).join('\n      ')}`);
  }

  const teardownRows = rows.filter(row => adapter.isTeardownRow('Corpus.Tests', suite.id, row));
  const caseRows = rows.filter(row => !teardownRows.includes(row));
  const wanted = expected.trace.filter(e => e.phase === 'case').map(e => ({ name: e.case, outcome: adapter.outcomeOf(e.status) }));
  if (sortRows(caseRows).join('\n') !== sortRows(wanted).join('\n')) {
    problems.push(`outcomes differ:\n      ${sortRows(caseRows).join('\n      ')}\n    expected:\n      ${sortRows(wanted).join('\n      ')}`);
  }
  const teardownFailed = expected.trace.some(e => e.phase === 'suite-teardown' && e.status === 'failed');
  if (teardownFailed && !teardownRows.some(row => row.outcome === 'Failed')) problems.push('the failed teardown is not reported');
  if (!teardownFailed && teardownRows.length > 0) problems.push(`an unexpected teardown row: ${sortRows(teardownRows).join(', ')}`);

  checked++;
  console.log(`  ${problems.length ? 'DIFFERS' : 'matches'}   ${entry.suite} (${caseRows.length} case(s)${teardownRows.length ? ', teardown row' : ''})`);
  if (problems.length) failures.push(`${entry.suite}:\n    ${problems.join('\n    ')}\n    output tail: ${output.slice(-800)}`);
}

// --------------------------------------------------------- the sample suites
const samplePlan = adapter.plan('bddsuite.tests.yaml');
const sampleSchema = path.join(workspace, 'test', 'e2e', 'schema');
let samples = 0;
for (const suite of samplePlan.values()) {
  if (only && suite.id !== only) continue;
  const file = path.join(adapter.project, suite.file);
  const reference = run('dotnet', [adapter.sampleCli, 'run', '--schema-root', sampleSchema, '--path', file], { cwd: workspace });
  const wanted = [...reference.stdout.matchAll(/^\s+\[(\w+)\s*\] (.*)$/gm)]
    .filter(m => m[2] !== 'teardown')
    .map(m => ({ name: m[2].trim(), outcome: adapter.outcomeOf(m[1]) }));
  // The reference runs guarded suites (suiterun always may); so does this run.
  const { rows } = adapter.runSuite('Shop.Suite.Tests', suite.id, { BDD_SUITE_ALLOW_GUARDED: '1' }, scratch);
  const caseRows = rows.filter(row => !adapter.isTeardownRow('Shop.Suite.Tests', suite.id, row));
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
