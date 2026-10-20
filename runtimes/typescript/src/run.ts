// The four verbs. Each returns a Report: what to print and the exit code. The
// command line in cli.ts maps it to the process; the library does not.
import type { Options } from './cli.js';
import { Diagnostic, fails, human, relativePath, sorted, toJsonArray } from './diag.js';
import { repositoryRoot, resolveGlob, schemaRoot as defaultSchemaRoot } from './paths.js';
import { diskReader, Reader } from './reader.js';
import { loadSchema } from './schema.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { allNames, anyFailed, runFile, SuiteResult } from './exec.js';
import { coreActions } from './actions/core.js';
import { compose, Composite, start } from './extension.js';
import { loadDocument } from './model.js';
import { caseTags, cases, nameMatches, tagsMatch } from './suite.js';
import { ProgressPrinter } from './progress.js';
import { junit, nunit3 } from './report.js';
import { Trace } from './trace.js';
import { isMap, ValueMap } from './value.js';
import { textOf } from './walk.js';
import { validateFile } from './validate/index.js';
import { loadConfig } from './generate/config.js';
import { buildPlan, Plan, planJson } from './generate/plan.js';
import { detectProvider, render, TYPESCRIPT_PROVIDERS, TypeScriptProvider, write as writeGenerated } from './generate/template.js';

export interface Report {
  /** 0 passed, 1 a case failed, 2 refused. */
  code: number;
  /** Printed to stdout with one write. */
  out: string;
  /** Printed to stderr after "suiterun: ". */
  errors: string;
}

const refused = (errors: string): Report => ({ code: 2, out: '', errors });

/**
 * The workspace root (found from the working directory) and the schema root.
 * With --schema-root no walk is needed: findings are then relative to the
 * workspace root when there is one, else to the working directory.
 */
export function roots(options: Options, cwd = process.cwd()): { root: string; schemaRoot: string } {
  const root = repositoryRoot(cwd);
  if (options.schemaRoot) return { root: root ?? path.resolve(cwd), schemaRoot: path.resolve(cwd, options.schemaRoot) };
  if (!root) throw new Error('the workspace root cannot be found from this directory (no test/e2e/schema above it); pass --schema-root.');
  return { root, schemaRoot: defaultSchemaRoot(root) };
}

const coreOnly = (): Composite => compose([], coreActions);

export async function lintVerb(options: Options, cwd = process.cwd(), reader: Reader = diskReader, composite: Composite = coreOnly()): Promise<Report> {
  let found: Diagnostic[] = [];
  let files: string[];
  try {
    const { root, schemaRoot } = roots(options, cwd);
    const schema = loadSchema(schemaRoot, reader);
    files = resolveGlob(options.path, cwd);
    const settings = { binding: options.binding, bindingCheck: options.bindingCheck, params: options.params, extensions: composite };
    for (const file of files) found.push(...validateFile(file, relativePath(file, root), schema, settings, reader));
  } catch (e) {
    return refused((e as Error).message);
  }
  found = sorted(found);
  const failed = fails(found, options.strict);
  const out = options.json
    ? toJsonArray(found)
    : [...found.map(human), `Lint ${failed ? 'failed' : 'clean'}: ${files.length} suite file(s), ${found.length} finding(s).`].join('\n');
  return { code: failed ? 2 : 0, out, errors: '' };
}

/** A suite file as a mapping, or why it cannot be run. */
function loadSuite(file: string, reader: Reader): ValueMap {
  const text = reader.read(file);
  if (text === undefined) throw new Error(`${file} cannot be read.`);
  let value;
  try {
    value = loadDocument(text).value;
  } catch (e) {
    throw new Error(`${file} is not valid YAML: ${(e as Error).message}`);
  }
  if (!isMap(value)) throw new Error(`${file} does not hold a YAML mapping.`);
  return value;
}

/** Writes a file, creating its directory. */
function write(file: string, content: string): void {
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o600 });
  } catch (e) {
    throw new Error(`${file} cannot be written: ${(e as Error).message}`);
  }
}

export interface RunExtras {
  cwd?: string;
  reader?: Reader;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  composite?: Composite;
}

export async function runVerb(options: Options, extras: RunExtras = {}): Promise<Report> {
  const composite = extras.composite ?? coreOnly();
  const cwd = extras.cwd ?? process.cwd();
  const reader = extras.reader ?? diskReader;
  const env = extras.env ?? process.env;
  const trace = new Trace();
  const suites: SuiteResult[] = [];
  const lines: string[] = [];
  try {
    const { schemaRoot } = roots(options, cwd);
    const schema = loadSchema(schemaRoot, reader);
    const files = resolveGlob(options.path, cwd);
    // Live lines while the run goes, for runs that take hours (spec/progress.md).
    const progress = options.progress ? new ProgressPrinter() : undefined;
    const settings = {
      tags: options.tags, names: options.names, ...(progress ? { observer: progress } : {}), params: options.params, dryRun: options.dryRun, recordPath: env[`${composite.envPrefix}RECORD_PATH`] ?? '', env, reader,
      ...(extras.signal ? { signal: extras.signal } : {}),
    };
    // Once per run, shared by every file, so an extension's state persists across files.
    const run = { composite, started: start(composite, options.extensionOptions) };
    for (const file of files) {
      const result = await runFile(file, loadSuite(file, reader), schema, settings, trace, run);
      lines.push(`=== Suite: ${path.basename(file)} ===`, ...result.cases.map(c => `  [${c.status.padEnd(5)}] ${c.name}`));
      suites.push(result);
    }
    progress?.summary();
    if (options.traceFile) {
      write(options.traceFile, trace.toJson());
      lines.push(`Trace written to ${options.traceFile}`);
    }
    if (options.results) {
      // Every text a report carries passes through the extensions' redaction (TS-3).
      const redact = (t: string) => run.started.redact(t);
      write(options.results, options.format === 'junit' ? junit(suites, redact) : nunit3(suites, redact));
      lines.push(`Results written to ${options.results}`);
    }
  } catch (e) {
    return refused((e as Error).message);
  }
  const failedRun = anyFailed(suites);
  lines.push(failedRun ? 'One or more tests failed.' : options.dryRun ? 'Suite validation passed; live tests were not run.' : 'All selected tests passed.');
  return { code: failedRun ? 1 : 0, out: lines.join('\n'), errors: '' };
}

/** The cases a run would select, one line each: `file  case`. */
export async function listVerb(options: Options, cwd = process.cwd(), reader: Reader = diskReader): Promise<Report> {
  const lines: string[] = [];
  try {
    for (const file of resolveGlob(options.path, cwd)) {
      const suite = loadSuite(file, reader);
      for (const c of cases(suite)) {
        if (tagsMatch(caseTags(suite, c), options.tags) && nameMatches(textOf(c, 'name'), options.names)) lines.push(`${path.basename(file)}  ${textOf(c, 'name')}`);
      }
    }
  } catch (e) {
    return refused((e as Error).message);
  }
  return { code: 0, out: lines.join('\n'), errors: '' };
}

/** The actions this runtime registers: the core ones, wait, and every extension's. */
export async function actionsVerb(options: Options, composite: Composite = coreOnly()): Promise<Report> {
  const names = allNames(composite);
  return { code: 0, out: options.json ? JSON.stringify(names, null, 2) : names.join('\n'), errors: '' };
}

/**
 * generate: builds each config's test plan and writes the TypeScript tests
 * (spec/test-plan.md). With --plan it prints the one config's plan; with
 * --check it writes nothing and exits 1 naming each stale file. A suite that
 * does not lint clean refuses the whole run (exit 2), writing nothing.
 */
export async function generateVerb(options: Options, cwd = process.cwd()): Promise<Report> {
  const plans: Plan[] = [];
  const findings: string[] = [];
  try {
    for (const file of options.configs) {
      const built = buildPlan(loadConfig(path.resolve(cwd, file)));
      if (built.plan) plans.push(built.plan);
      else findings.push(...built.findings.map(human));
    }
  } catch (e) {
    return refused((e as Error).message);
  }
  if (findings.length) return refused([...findings, 'Nothing was generated: every suite has to lint clean first.'].join('\n'));
  if (options.plan) {
    if (plans.length !== 1) return refused('--plan prints one config\'s plan; give one --config.');
    return { code: 0, out: planJson(plans[0]!), errors: '' };
  }
  const first = plans[0]!.config;
  const folder = path.resolve(cwd, options.out || path.resolve(first.folder, first.output.folder ?? '.'));
  // The plan is the same whatever the provider; the code is not.
  const provider = options.provider || first.provider || detectProvider(folder);
  if (!(TYPESCRIPT_PROVIDERS as readonly string[]).includes(provider)) {
    return refused(`${provider} is not a TypeScript provider; the TypeScript runtime generates for ${TYPESCRIPT_PROVIDERS.join(', ')}.`);
  }
  let outcome;
  let files;
  try {
    files = render(plans, folder, provider as TypeScriptProvider);
    outcome = writeGenerated(folder, files, options.check);
  } catch (e) {
    return refused((e as Error).message);
  }
  if (options.check) {
    if (!outcome.stale.length) return { code: 0, out: `${files.length} generated file(s) are up to date.`, errors: '' };
    return { code: 1, out: [...outcome.stale.map(n => `stale: ${n}`), 'Run suiterun generate to write them again.'].join('\n'), errors: '' };
  }
  const tests = plans.reduce((n, p) => n + p.suites.reduce((m, s) => m + s.cases.length, 0), 0);
  const suites = plans.reduce((n, p) => n + p.suites.length, 0);
  return {
    code: 0, errors: '',
    out: [...outcome.written.map(n => `wrote ${n}`), ...outcome.removed.map(n => `removed ${n}`), `${provider}: ${suites} suite(s), ${tests} test(s) in ${folder}`].join('\n'),
  };
}

export async function execute(options: Options, composite: Composite = coreOnly()): Promise<Report> {
  switch (options.verb) {
    case 'generate': return generateVerb(options);
    case 'lint': return lintVerb(options, process.cwd(), diskReader, composite);
    case 'run': return runVerb(options, { composite });
    case 'list': return listVerb(options);
    default: return actionsVerb(options, composite);
  }
}
