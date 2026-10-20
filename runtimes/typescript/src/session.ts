// The suite session (spec/session.md): one suite file run a phase at a time,
// so a test framework can call the suite setup, one case and the teardown when
// it chooses. runFile (exec.ts) is these same calls in order, so a native test
// run and a suiterun run of the same file give the same results and trace.
//
// The operations return results and never throw for a step: setup and
// beforeEach record a failure and the case reports it (rule 3). Every case
// starts from its own deep copy of the setup's bag (rule 5). One case of a
// session runs at a time: beforeEach waits on a promise chain that afterEach
// releases, so even tests a framework runs concurrently take turns (rule 7).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { coreActions } from './actions/core.js';
import { ActionError } from './actions/registry.js';
import {
  CaseResult, Context, DEFAULT_CASE_SEC, DEFAULT_CLEANUP_SEC, DEFAULT_HOOK_SEC, limitOf, runCaseBody, RunExtensions, runHook, RunOptions,
} from './exec.js';
import { compose, Extension, start } from './extension.js';
import { Diagnostic, fails, human, sorted } from './diag.js';
import { loadDocument } from './model.js';
import { diskReader } from './reader.js';
import { Schema } from './schema.js';
import { cases, caseTags, expandedCase, expandedHooks, Library, metaDefinitions, readLibraries, nameMatches, resolveParams, resolveVars, tagsMatch } from './suite.js';
import { Reason, Status, Trace } from './trace.js';
import { deepClone, isMap, Value, ValueMap } from './value.js';
import { textOf } from './walk.js';
import { validateFile } from './validate/index.js';

/** What a skipped guarded case says (rule 9). */
export const GUARDED_MESSAGE = 'guarded suite: set BDD_SUITE_ALLOW_GUARDED=1 to run it';

/**
 * What one test process shares (spec/session.md, "run context"): the
 * extensions, started once; the run's options; the trace; whether guarded
 * suites may run; and where the trace is written. In the JavaScript
 * frameworks a "process" is a test file's module state (DEC-T08).
 */
export interface RunContext {
  options: RunOptions;
  run: RunExtensions;
  trace: Trace;
  allowGuarded: boolean;
  traceFile: string;
  /** How many trace entries flushTrace has written. */
  written: number;
}

/** A context over extensions already started, which is what suiterun has; it allows guarded suites, as suiterun always has. */
export function createRunContext(run: RunExtensions, options: RunOptions, trace: Trace = new Trace()): RunContext {
  return { options, run, trace, allowGuarded: true, traceFile: '', written: 0 };
}

/** The variable-name part of an option's flag: --api-url is API_URL. */
export const optionVariable = (flag: string): string => flag.replace(/^-+/, '').toUpperCase().replace(/-/g, '_');

/**
 * A test process's context, from <prefix>OPTION_<FLAG>, TAGS, DRY_RUN,
 * ALLOW_GUARDED, TRACE_FILE and RECORD_PATH, where the prefix is the
 * extensions' environment prefix. The extensions are composed and started
 * here. Suite parameters come from <prefix>PARAM_<NAME>, as they always have.
 */
export function runContextFromEnv(extensions: readonly Extension[] = [], env: NodeJS.ProcessEnv = process.env): RunContext {
  const composite = compose(extensions, coreActions);
  const read = (name: string) => (env[`${composite.envPrefix}${name}`] ?? '').trim();
  const values = new Map<string, string>();
  for (const option of composite.options) {
    const given = read(`OPTION_${optionVariable(option.flag)}`);
    if (given) values.set(option.flag, given);
  }
  const options: RunOptions = {
    tags: read('TAGS').split(',').map(t => t.trim()).filter(Boolean), params: [], dryRun: read('DRY_RUN') === '1', recordPath: read('RECORD_PATH'), env,
  };
  return { options, run: { composite, started: start(composite, values) }, trace: new Trace(), allowGuarded: read('ALLOW_GUARDED') === '1', traceFile: read('TRACE_FILE'), written: 0 };
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Adds the entries traced since the last flush to the context's trace file.
 * Each test file of a JavaScript framework is its own run context, and several
 * may run at once (workers, processes), so the file is a list every context
 * appends to under a lock folder: one run of several test files gives one
 * trace, each flush's entries together. A caller starts from no file.
 */
export function flushTrace(context: RunContext): void {
  if (!context.traceFile || context.written === context.trace.entries.length) return;
  const file = path.resolve(context.traceFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  for (let tries = 0; ; tries++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || tries >= 2000) throw new Error(`${file} cannot be locked: ${(e as Error).message}`);
      sleep(5);
    }
  }
  try {
    const before = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[]) : [];
    const all = [...before, ...context.trace.entries.slice(context.written)];
    fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
    context.written = context.trace.entries.length;
  } finally {
    fs.rmdirSync(lock);
  }
}

/** What a suite teardown did. */
export interface TeardownResult {
  /** False when no setup ran, so neither did the teardown (rule 6). */
  ran: boolean;
  failed: boolean;
  message: string;
  durationSec: number;
}

type Kind = 'run' | 'tag' | 'guarded' | 'setup-failed' | 'dry-run';
type Stage = 'started' | 'ran' | 'settled';

interface CaseState {
  name: string;
  kind: Kind;
  stage: Stage;
  status: Status;
  reason: Reason;
  message: string;
  beforeEachFailed: boolean;
  output: string[];
  began: number;
  phases: Record<string, ValueMap[]>;
  ctx?: Context;
  caseLimit: number;
  release: () => void;
}

const SECOND = 1000;
const baseName = (file: string) => file.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');

/** One suite file run a phase at a time (spec/session.md). */
export class Session {
  /** The name the file declares, else its file name. */
  readonly name: string;
  /** The case names in file order, examples rows in row order. */
  readonly cases: string[];
  private readonly library: Library;
  private readonly definitions: Map<string, ValueMap>;
  private readonly hooks: Record<string, ValueMap[]>;
  private readonly caseModels: ValueMap[];
  private readonly selected: boolean[];
  private readonly states = new Map<number, CaseState>();
  private scope: ValueMap = new Map<string, Value>([['capture', new Map()], ['var', new Map()]]);
  private setupRun?: Promise<void>;
  private setupError = '';
  private tornDown = false;
  private lock: Promise<void> = Promise.resolve();

  constructor(readonly file: string, private readonly suite: ValueMap, private readonly schema: Schema, readonly context: RunContext,
    readonly guarded = false) {
    this.name = textOf(suite, 'suite') || baseName(file);
    this.library = readLibraries(suite, file, context.options.reader ?? diskReader);
    this.definitions = metaDefinitions(suite, this.library);
    this.hooks = expandedHooks(suite, this.definitions);
    this.caseModels = cases(suite);
    this.cases = this.caseModels.map(c => textOf(c, 'name'));
    this.selected = this.caseModels.map(c => tagsMatch(caseTags(suite, c), context.options.tags) && nameMatches(textOf(c, 'name'), context.options.names ?? []));
  }

  /** The run context's trace. */
  get trace(): Trace {
    return this.context.trace;
  }

  /** A case's position by its exact name, or -1. */
  indexOf(caseName: string): number {
    return this.cases.indexOf(caseName);
  }

  /** Whether the run context's tag filter selects a case. */
  isSelected(index: number): boolean {
    return this.selected[index] ?? false;
  }

  private get refusedAsGuarded(): boolean {
    return this.guarded && !this.context.allowGuarded;
  }

  /**
   * Why a case is skipped before anything of it runs (the tag filter, a
   * guarded suite without the opt-in, a dry run), or undefined when it runs.
   */
  skipOf(index: number): { kind: Kind; message: string; reason: Reason } | undefined {
    if (!this.selected[index]) return { kind: 'tag', message: 'tag filter', reason: 'tag' };
    if (this.refusedAsGuarded) return { kind: 'guarded', message: GUARDED_MESSAGE, reason: 'guard' };
    if (this.context.options.dryRun) return { kind: 'dry-run', message: 'Validated only; live execution pending.', reason: '' };
    return undefined;
  }

  private newContext(scope: ValueMap): Context {
    const { recordPath, signal } = this.context.options;
    return { scope, recordPath, run: this.context.run, ...(signal ? { signal } : {}) };
  }

  /**
   * Runs the suite setup, once (rule 2): only when a case is selected, the run
   * is not a dry run and the suite is not a guarded one the context refuses.
   * A failure is recorded, never thrown (rule 3).
   */
  setup(): Promise<void> {
    if (this.context.options.dryRun || !this.selected.some(Boolean) || this.refusedAsGuarded) return Promise.resolve();
    this.setupRun ??= (async () => {
      const ctx = this.newContext(deepClone(this.scope) as ValueMap);
      try {
        await runHook(this.hooks.setup!, ctx, this.schema, limitOf(this.suite, 'setupTimeoutSec', DEFAULT_HOOK_SEC), 'suite setup', 'suite-setup', '', this.trace);
      } catch (e) {
        this.setupError = (e as Error).message;
      }
      this.scope = ctx.scope;
    })();
    return this.setupRun;
  }

  private state(index: number, operation: string): CaseState {
    const state = this.states.get(index);
    if (!state || state.stage === 'settled') throw new Error(`${operation} for ${JSON.stringify(this.cases[index])} needs beforeEach first`);
    return state;
  }

  /**
   * Starts one case: waits for the case before it to be settled, runs the
   * setup if it has not run, builds the case's scope from a deep copy of the
   * setup's bag and runs beforeEach. A failure is recorded for runCase to
   * report. It throws only for a case the session does not have, or one whose
   * steps or variables cannot be expanded.
   */
  async beforeEach(index: number): Promise<void> {
    if (index < 0 || index >= this.cases.length) throw new Error(`${this.name} has no case number ${index}`);
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise(resolve => (release = resolve));
    await previous;
    const state: CaseState = {
      name: this.cases[index]!, kind: 'run', stage: 'started', status: 'passed', reason: '', message: '', beforeEachFailed: false, output: [], began: 0,
      phases: {}, caseLimit: DEFAULT_CASE_SEC, release,
    };
    this.states.set(index, state);
    try {
      const skip = this.skipOf(index);
      if (skip) {
        Object.assign(state, { kind: skip.kind, status: 'skipped', message: skip.message, reason: skip.reason });
        return;
      }
      await this.setup();
      if (this.setupError) {
        Object.assign(state, { kind: 'setup-failed', status: 'error', reason: 'suite-setup', message: `Suite setup failed: ${this.setupError}` });
        return;
      }
      this.prepare(index, state);
      try {
        await runHook(this.hooks.beforeEach!, state.ctx!, this.schema, limitOf(this.suite, 'beforeEachTimeoutSec', DEFAULT_HOOK_SEC), 'beforeEach', 'before-each',
          state.name, this.trace);
      } catch (e) {
        this.fail(state, e);
        state.beforeEachFailed = true;
      }
    } catch (e) {
      this.states.delete(index);
      release();
      throw e;
    }
  }

  private prepare(index: number, state: CaseState): void {
    const c = this.caseModels[index]!;
    const { run, options } = this.context;
    state.began = Date.now();
    state.phases = expandedCase(c, this.definitions);
    const scope = deepClone(this.scope) as ValueMap;
    scope.set('param', resolveParams(this.library, this.suite, c, options.params, options.env, run.composite.envPrefix));
    if (c.has('__row')) scope.set('row', c.get('__row')!);
    const defaults = new Map(this.library.defaults);
    const declared = this.suite.get('defaults');
    if (isMap(declared)) for (const [k, v] of declared) defaults.set(k, v);
    for (const [k, v] of defaults) scope.set(k, v);
    scope.set('defaults', defaults);
    scope.set('timeoutSec', BigInt(limitOf(c, 'timeoutSec', DEFAULT_CASE_SEC)));
    // The extensions' context keys: a value given for this run wins over the
    // suite's defaults; a key with neither reads as ''.
    for (const [k, v] of run.started.context) scope.set(k, v);
    for (const k of run.composite.contextKeys) if (!scope.has(k)) scope.set(k, '');
    resolveVars(this.library, this.suite, c, scope, run.composite.roots);
    state.ctx = this.newContext(scope);
    state.caseLimit = run.composite.caseLimitSec(this.suite, limitOf(c, 'timeoutSec', DEFAULT_CASE_SEC));
  }

  private fail(state: CaseState, e: unknown): void {
    state.status = 'failed';
    state.message = (e as Error).message;
    state.reason = e instanceof ActionError ? e.reason : 'action';
  }

  private result(state: CaseState, afterEachFailed: boolean): CaseResult {
    return {
      name: state.name, status: state.status, reason: state.reason, message: state.kind === 'run' ? state.message.trim() : state.message,
      output: state.output.map(l => `${l}\n`).join(''), durationSec: state.began ? (Date.now() - state.began) / SECOND : 0, afterEachFailed,
    };
  }

  /**
   * Runs the case itself: its setup, steps and case-level asserts, then its
   * cleanup, which runs even after a failure. A recorded setup or beforeEach
   * failure is reported here as the case's result. The result is final only
   * after afterEach.
   */
  async runCase(index: number): Promise<CaseResult> {
    const state = this.state(index, 'runCase');
    if (state.stage !== 'started') throw new Error(`runCase for ${JSON.stringify(state.name)} was called twice; call beforeEach again to run it again`);
    state.stage = 'ran';
    if (state.kind === 'run') {
      if (!state.beforeEachFailed) {
        try {
          await runCaseBody(this.caseModels[index]!, state.phases, state.ctx!, this.schema, state.name, state.caseLimit, this.trace, state.output);
        } catch (e) {
          this.fail(state, e);
        }
      }
      await this.cleanup(index, state);
    }
    return this.result(state, false);
  }

  /** The case's cleanup, in its own window even after the case timed out. */
  private async cleanup(index: number, state: CaseState): Promise<void> {
    if (!state.phases.cleanup!.length) return;
    try {
      await runHook(state.phases.cleanup!, state.ctx!, this.schema, limitOf(this.caseModels[index]!, 'cleanupTimeoutSec', DEFAULT_CLEANUP_SEC), 'cleanup',
        'case-cleanup', state.name, this.trace);
    } catch (e) {
      state.status = 'failed';
      state.reason = 'cleanup';
      state.message = `${state.message} Cleanup failed: ${(e as Error).message}`;
    }
  }

  /**
   * Finishes one case: runs afterEach, settles the result (an afterEach
   * failure makes it failed with reason hook), writes its case trace entry and
   * lets the next case start (rule 4). afterEachFailed says whether the
   * framework's per-test cleanup should fail.
   */
  async afterEach(index: number): Promise<CaseResult> {
    const state = this.state(index, 'afterEach');
    try {
      if (state.kind === 'run' && state.stage === 'started') {
        // The framework ran beforeEach but never the case. Its cleanup is
        // still owed, and the case did not pass.
        Object.assign(state, { status: 'failed', reason: 'hook', message: 'The test framework ran this case\'s beforeEach but not the case itself.' });
        await this.cleanup(index, state);
      }
      let afterEachFailed = false;
      if (state.kind === 'run') {
        try {
          await runHook(this.hooks.afterEach!, state.ctx!, this.schema, limitOf(this.suite, 'afterEachTimeoutSec', DEFAULT_HOOK_SEC), 'afterEach', 'after-each',
            state.name, this.trace);
        } catch (e) {
          state.status = 'failed';
          state.reason = 'hook';
          state.message = `${state.message} afterEach failed: ${(e as Error).message}`;
          afterEachFailed = true;
        }
      }
      // A dry run validates and runs nothing, so it traces nothing either.
      if (state.kind !== 'dry-run') this.trace.add('case', state.name, '', '', state.status, state.reason);
      state.stage = 'settled';
      return this.result(state, afterEachFailed);
    } finally {
      state.release();
    }
  }

  /**
   * Settles a case a framework skipped when the test file loaded, because the
   * tag filter does not select it, the suite is guarded or the run is a dry
   * run (Jest has no skip at run time): the same result and trace entry beforeEach and afterEach
   * would give it, without waiting. A case that would run is refused.
   */
  recordSkipped(index: number): CaseResult {
    const skip = this.skipOf(index);
    if (!skip) throw new Error(`${JSON.stringify(this.cases[index])} is not skipped; run it through beforeEach`);
    const name = this.cases[index]!;
    // A dry run validates and runs nothing, so it traces nothing either.
    if (skip.kind !== 'dry-run') this.trace.add('case', name, '', '', 'skipped', skip.reason);
    return { name, status: 'skipped', reason: skip.reason, message: skip.message, output: '', durationSec: 0, afterEachFailed: false };
  }

  /**
   * Runs the suite teardown, once, on the setup's bag, if the setup ran
   * (rule 6), after any case in progress is settled. Its failure is in the
   * result, never thrown.
   */
  async teardown(): Promise<TeardownResult> {
    await this.lock;
    if (this.tornDown || !this.setupRun) return { ran: false, failed: false, message: '', durationSec: 0 };
    this.tornDown = true;
    const began = Date.now();
    try {
      await runHook(this.hooks.teardown!, this.newContext(this.scope), this.schema, limitOf(this.suite, 'teardownTimeoutSec', DEFAULT_HOOK_SEC), 'suite teardown',
        'suite-teardown', '', this.trace);
      return { ran: true, failed: false, message: '', durationSec: (Date.now() - began) / SECOND };
    } catch (e) {
      return { ran: true, failed: true, message: (e as Error).message, durationSec: (Date.now() - began) / SECOND };
    }
  }
}

/**
 * Opens a parsed suite. Nothing runs and nothing is linted: this is what
 * runFile uses, which has always run a file as it finds it.
 */
export const openSession = (file: string, suite: ValueMap, schema: Schema, context: RunContext, guarded = false): Session =>
  new Session(file, suite, schema, context, guarded);

/** Why a test process refuses a suite file: its findings, as file:line:column lines. */
export class SuiteRefusedError extends Error {
  constructor(readonly findings: Diagnostic[], shown: string) {
    super(`${shown} does not lint clean, so none of its cases ran:\n${findings.map(human).join('\n')}`);
  }
}

/**
 * Reads, lints and opens a suite file, as a test process does: a file that
 * does not lint clean is refused with its findings and nothing runs. shown is
 * the path the findings name.
 */
export function openLinted(file: string, shown: string, schema: Schema, context: RunContext, guarded = false): Session {
  const reader = context.options.reader ?? diskReader;
  const settings = { binding: 'typescript', bindingCheck: false, params: [], extensions: context.run.composite };
  const findings = sorted(validateFile(file, shown, schema, settings, reader));
  if (fails(findings, false)) throw new SuiteRefusedError(findings, shown);
  return new Session(file, loadDocument(reader.read(file)!).value as ValueMap, schema, context, guarded);
}
