// Running one suite file (yml_suite_design.md 5.2): suite setup once, then
// per case beforeEach, case setup, steps (each with its own asserts), the
// case's asserts, cleanup and afterEach; suite teardown once. A failure is
// attributed to the phase it happened in, and cleanup still runs.
//
// Every action call gets AbortSignal.any([run, AbortSignal.timeout(limit)])
// (TS-4). When the limit passes the step is "cancelled", or "abandoned" when
// the catalog says the action cannot be interrupted; either way the executor
// stops waiting, because a JavaScript promise cannot be killed.
import { compare, describe } from './assertion.js';
import { coreActions } from './actions/core.js';
import { ActionError, assertionFailed, failed, timedOut } from './actions/registry.js';
import { compose, Composite, start, Started } from './extension.js';
import { expand, field, newScope } from './expr.js';
import { Schema } from './schema.js';
import {
  cases, caseTags, expandedCase, expandedHooks, Library, metaDefinitions, readLibraries, resolveParams, resolveVars, stepLabel,
  stepLimit, tagsMatch,
} from './suite.js';
import { diskReader, Reader } from './reader.js';
import { Phase, Status, Trace } from './trace.js';
import { isList, isMap, toJson, Value, ValueMap } from './value.js';
import { listOf, textOf } from './walk.js';

export const DEFAULT_CASE_SEC = 600;
export const DEFAULT_HOOK_SEC = 300;
export const DEFAULT_CLEANUP_SEC = 120;

/** The extensions of one run, composed, and started with the run's option values. */
export interface RunExtensions {
  composite: Composite;
  started: Started;
}

/** The core alone: no extension, nothing started. */
export const coreOnly = (): RunExtensions => {
  const composite = compose([], coreActions);
  return { composite, started: start(composite, new Map()) };
};

export interface RunOptions {
  tags: string[];
  params: [string, string][];
  dryRun: boolean;
  recordPath: string;
  /** Aborts every running action, for a cancelled run. */
  signal?: AbortSignal;
  /** <prefix>PARAM_<NAME> values; the process environment by default. */
  env?: NodeJS.ProcessEnv;
  reader?: Reader;
}

export interface CaseResult {
  name: string;
  status: Status;
  message: string;
  /** Each step's result as a JSON line, for the report's output. */
  output: string;
  durationSec: number;
}

export interface SuiteResult {
  name: string;
  cases: CaseResult[];
}

/** Every action this runtime runs: the core ones, wait, and every extension's. */
export function allNames(composite: Composite = compose([], coreActions)): string[] {
  return [...composite.actions.keys()].sort();
}

interface Context {
  scope: ValueMap;
  recordPath: string;
  run: RunExtensions;
  signal?: AbortSignal;
}

/** Every scope starts with a capture bag (runFile), so a capture always has one to go into. */
function capture(ctx: Context, name: string, produced: Value): void {
  (ctx.scope.get('capture') as ValueMap).set(name, produced);
}

/** Whether a capture (or a path into one) exists, for ifCapture. */
function has(ctx: Context, name: string): boolean {
  const bag = ctx.scope.get('capture');
  if (!isMap(bag)) return false;
  if (bag.has(name)) return true;
  let current: Value = bag;
  for (const part of name.split('.')) {
    if (!part || !isMap(current) || !current.has(part)) return false;
    current = current.get(part)!;
  }
  return true;
}

/** The value an assertion's var names, and whether it is there at all. */
function actualValue(pathText: string, ctx: Context): { found: Value; present: boolean } {
  if (!ctx.scope.has('capture')) return { found: null, present: false };
  let current: Value = ctx.scope.get('capture')!;
  for (const segment of pathText.split('.')) {
    if (current === null) return { found: null, present: false };
    if (isList(current) && /^[0-9]+/.test(segment)) {
      const index = parseInt(segment, 10);
      if (index >= current.length) return { found: null, present: false };
      current = current[index]!;
      continue;
    }
    const f = field(current, segment);
    if (!f.found) return { found: null, present: false };
    current = f.value;
  }
  return { found: current, present: true };
}

function checkAssertion(raw: Value, ctx: Context): void {
  let expanded: Value;
  try {
    expanded = expand(raw, newScope(ctx.scope, ctx.run.composite.roots));
  } catch (e) {
    throw failed((e as Error).message);
  }
  if (!isMap(expanded)) return;
  const variable = textOf(expanded, 'var');
  const { found, present } = variable ? actualValue(variable, ctx) : { found: null, present: false };
  for (const [op, expected] of expanded) {
    if (op === 'var') continue;
    if (op === 'script') throw assertionFailed('a script assertion is implemented by the PowerShell binding only');
    let holds: boolean;
    try {
      holds = compare(op, found, expected, present);
    } catch (e) {
      throw assertionFailed((e as Error).message);
    }
    if (!holds) throw assertionFailed(describe(variable || '(value)', op, expected, found, present));
  }
}

/** One action call inside its limit. */
async function bounded(name: string, step: ValueMap, ctx: Context, limitSec: number, description: string, interruptible: boolean): Promise<Value> {
  if (limitSec <= 0) throw timedOut(`${description} had no time left to run in: the deadline had already passed.`);
  const registered = ctx.run.composite.actions.get(name);
  if (!registered) throw failed(`Unknown action: ${name}. No extension of this runtime registers it.`);
  const limit = AbortSignal.timeout(limitSec * 1000);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, limit]) : limit;
  const wording = interruptible ? 'cancelled' : 'abandoned: it holds a remote session this runner cannot interrupt, so the work on the far side continues';
  const work = registered.handler({
    action: name, step, signal, recordPath: ctx.recordPath, deadline: Date.now() + limitSec * 1000, state: ctx.run.started.states.get(registered.owner),
  });
  const stopped = new Promise<never>((_, reject) => {
    const stop = () => reject(timedOut(`${description} exceeded its ${limitSec}s limit and was ${wording}.`));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
  // Whichever settles second is never waited for; it must not be an unhandled rejection.
  work.catch(() => undefined);
  stopped.catch(() => undefined);
  return Promise.race([work, stopped]);
}

const SECOND = 1000;

/** Runs one expanded step and records it; throws an ActionError naming the step when it fails. */
async function runStep(step: ValueMap, ctx: Context, schema: Schema, deadline: number, phase: Phase, caseName: string, trace: Trace,
  collected: Map<string, Value[]>): Promise<Value> {
  const label = stepLabel(step);
  const name = textOf(step, 'action');
  const guard = textOf(step, 'ifCapture');
  if (guard && !has(ctx, guard)) {
    trace.add(phase, caseName, label, name, 'skipped', 'guard');
    return null;
  }
  if (step.has('__row')) ctx.scope.set('row', step.get('__row')!);
  let expanded: ValueMap;
  try {
    expanded = expand(step, newScope(ctx.scope, ctx.run.composite.roots)) as ValueMap;
  } catch (e) {
    trace.add(phase, caseName, label, name, 'failed', 'action');
    throw failed(`${label}: ${(e as Error).message}`);
  }
  if (!name) {
    trace.add(phase, caseName, label, '', 'failed', 'action');
    throw failed(`${label}: a step names no action`);
  }
  const remaining = Math.max(0, Math.trunc((deadline - Date.now()) / SECOND));
  const own = expanded.get('timeoutSec');
  const limit = stepLimit(typeof own === 'bigint' ? Number(own) : 0, remaining);
  const interruptible = schema.actions.get(name)?.interruptible ?? true;
  let produced: Value;
  try {
    produced = name === 'wait'
      ? await ctx.run.composite.actions.get('wait')!.handler({
        action: name, step: expanded, signal: ctx.signal ?? new AbortController().signal, recordPath: ctx.recordPath, deadline,
        runNested: async nested => {
          try {
            const until = Math.min(deadline, Date.now() + (typeof expanded.get('timeoutSec') === 'bigint' ? Number(expanded.get('timeoutSec')) : 300) * SECOND);
            await runStep(nested, ctx, schema, until, phase, caseName, trace, new Map());
            return true;
          } catch {
            // runStep has recorded the failure; for wait it only means "not yet".
            return false;
          }
        },
        holds: assertions => {
          try {
            checkAssertion(assertions, ctx);
            return true;
          } catch {
            return false;
          }
        },
      })
      : await bounded(name, expanded, ctx, limit, label, interruptible);
  } catch (e) {
    const reason = e instanceof ActionError ? e.reason : 'action';
    trace.add(phase, caseName, label, name, 'failed', reason);
    const message = (e as Error).message;
    throw new ActionError(message.startsWith(label) ? message : `${label}: ${message}`, reason);
  }
  const captureAs = textOf(expanded, 'captureAs');
  if (captureAs) capture(ctx, captureAs, produced);
  for (const one of listOf(step, 'asserts') ?? []) {
    if (one === null) continue;
    try {
      checkAssertion(one, ctx);
    } catch (e) {
      const reason = (e as ActionError).reason;
      trace.add(phase, caseName, label, name, 'failed', reason);
      throw new ActionError(`${label}: ${(e as Error).message}`, reason);
    }
  }
  // A table step captures the list of every row's result so far.
  if (captureAs && step.has('__rowCount')) {
    const list = [...(collected.get(captureAs) ?? []), produced];
    collected.set(captureAs, list);
    capture(ctx, captureAs, [...list]);
  }
  trace.add(phase, caseName, label, name, 'passed', '');
  return produced;
}

/** A hook's steps inside the hook's own window; a failure is the hook's. */
async function runHook(steps: ValueMap[], ctx: Context, schema: Schema, limitSec: number, label: string, phase: Phase, caseName: string, trace: Trace): Promise<void> {
  if (!steps.length) return;
  const deadline = Date.now() + Math.max(1, limitSec) * SECOND;
  const collected = new Map<string, Value[]>();
  for (const step of steps) {
    try {
      await runStep(step, ctx, schema, deadline, phase, caseName, trace, collected);
    } catch (e) {
      throw new ActionError(`${label} ${(e as Error).message}`, 'hook');
    }
  }
}

const limitOf = (m: ValueMap, key: string, fallback: number) => {
  const v = m.get(key);
  return typeof v === 'bigint' ? Number(v) : fallback;
};

function cloneScope(scope: ValueMap): ValueMap {
  const copy = new Map(scope);
  for (const bag of ['capture', 'var']) {
    const held = scope.get(bag);
    if (isMap(held)) copy.set(bag, new Map(held));
  }
  return copy;
}

async function runCase(c: ValueMap, phases: Record<string, ValueMap[]>, hooks: Record<string, ValueMap[]>, ctx: Context, schema: Schema, suite: ValueMap,
  caseName: string, caseLimit: number, trace: Trace, output: string[]): Promise<void> {
  await runHook(hooks.beforeEach!, ctx, schema, limitOf(suite, 'beforeEachTimeoutSec', DEFAULT_HOOK_SEC), 'beforeEach', 'before-each', caseName, trace);
  await runHook(phases.setup!, ctx, schema, limitOf(c, 'setupTimeoutSec', DEFAULT_HOOK_SEC), 'case setup', 'case-setup', caseName, trace);
  const deadline = Date.now() + Math.max(1, caseLimit) * SECOND;
  const collected = new Map<string, Value[]>();
  for (const step of phases.steps!) {
    const produced = await runStep(step, ctx, schema, deadline, 'step', caseName, trace, collected);
    if (produced !== null) output.push(toJson(produced));
  }
  for (const one of listOf(c, 'asserts') ?? []) if (one !== null) checkAssertion(one, ctx);
}

const baseName = (file: string) => file.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');

/** Runs one suite file and records every step and case in the trace. */
export async function runFile(file: string, suite: ValueMap, schema: Schema, options: RunOptions, trace: Trace, run: RunExtensions = coreOnly()): Promise<SuiteResult> {
  const name = textOf(suite, 'suite') || baseName(file);
  const library: Library = readLibraries(suite, file, options.reader ?? diskReader);
  const definitions = metaDefinitions(suite, library);
  const hooks = expandedHooks(suite, definitions);
  const result: SuiteResult = { name, cases: [] };
  const all = cases(suite);
  const selected = all.filter(c => tagsMatch(caseTags(suite, c), options.tags)).length;
  const live = !options.dryRun && selected > 0;
  let suiteScope: ValueMap = new Map<string, Value>([['capture', new Map()], ['var', new Map()]]);
  let suiteSetupError = '';
  if (live && hooks.setup!.length) {
    const ctx: Context = { scope: cloneScope(suiteScope), recordPath: options.recordPath, run, signal: options.signal };
    try {
      await runHook(hooks.setup!, ctx, schema, limitOf(suite, 'setupTimeoutSec', DEFAULT_HOOK_SEC), 'suite setup', 'suite-setup', '', trace);
    } catch (e) {
      suiteSetupError = (e as Error).message;
    }
    suiteScope = ctx.scope;
  }
  for (const c of all) {
    const caseName = textOf(c, 'name');
    if (!tagsMatch(caseTags(suite, c), options.tags)) {
      trace.add('case', caseName, '', '', 'skipped', 'tag');
      result.cases.push({ name: caseName, status: 'skipped', message: 'tag filter', output: '', durationSec: 0 });
      continue;
    }
    if (suiteSetupError) {
      trace.add('case', caseName, '', '', 'error', 'suite-setup');
      result.cases.push({ name: caseName, status: 'error', message: `Suite setup failed: ${suiteSetupError}`, output: '', durationSec: 0 });
      continue;
    }
    if (options.dryRun) {
      result.cases.push({ name: caseName, status: 'skipped', message: 'Validated only; live execution pending.', output: '', durationSec: 0 });
      continue;
    }
    const started = Date.now();
    const phases = expandedCase(c, definitions);
    const scope = cloneScope(suiteScope);
    scope.set('param', resolveParams(library, suite, c, options.params, options.env, run.composite.envPrefix));
    if (c.has('__row')) scope.set('row', c.get('__row')!);
    const defaults = new Map(library.defaults);
    const declared = suite.get('defaults');
    if (isMap(declared)) for (const [k, v] of declared) defaults.set(k, v);
    for (const [k, v] of defaults) scope.set(k, v);
    scope.set('defaults', defaults);
    scope.set('timeoutSec', BigInt(limitOf(c, 'timeoutSec', DEFAULT_CASE_SEC)));
    // The extensions' context keys: a value given for this run wins over the suite's defaults;
    // a key with neither reads as ''.
    for (const [k, v] of run.started.context) scope.set(k, v);
    for (const k of run.composite.contextKeys) if (!scope.has(k)) scope.set(k, '');
    resolveVars(library, suite, c, scope, run.composite.roots);
    const ctx: Context = { scope, recordPath: options.recordPath, run, signal: options.signal };
    let status: Status = 'passed';
    let message = '';
    let reason: '' | ActionError['reason'] = '';
    const output: string[] = [];
    const caseLimit = run.composite.caseLimitSec(suite, limitOf(c, 'timeoutSec', DEFAULT_CASE_SEC));
    try {
      await runCase(c, phases, hooks, ctx, schema, suite, caseName, caseLimit, trace, output);
    } catch (e) {
      status = 'failed';
      message = (e as Error).message;
      reason = e instanceof ActionError ? e.reason : 'action';
    }
    if (phases.cleanup!.length) {
      try {
        await runHook(phases.cleanup!, ctx, schema, limitOf(c, 'cleanupTimeoutSec', DEFAULT_CLEANUP_SEC), 'cleanup', 'case-cleanup', caseName, trace);
      } catch (e) {
        status = 'failed';
        reason = 'cleanup';
        message = `${message} Cleanup failed: ${(e as Error).message}`;
      }
    }
    try {
      await runHook(hooks.afterEach!, ctx, schema, limitOf(suite, 'afterEachTimeoutSec', DEFAULT_HOOK_SEC), 'afterEach', 'after-each', caseName, trace);
    } catch (e) {
      status = 'failed';
      reason = 'hook';
      message = `${message} afterEach failed: ${(e as Error).message}`;
    }
    trace.add('case', caseName, '', '', status, reason);
    result.cases.push({ name: caseName, status, message: message.trim(), output: output.map(l => `${l}\n`).join(''), durationSec: (Date.now() - started) / SECOND });
  }
  if (live && hooks.teardown!.length) {
    const ctx: Context = { scope: suiteScope, recordPath: options.recordPath, run, signal: options.signal };
    const started = Date.now();
    try {
      await runHook(hooks.teardown!, ctx, schema, limitOf(suite, 'teardownTimeoutSec', DEFAULT_HOOK_SEC), 'suite teardown', 'suite-teardown', '', trace);
    } catch (e) {
      result.cases.push({ name: 'teardown', status: 'failed', message: (e as Error).message, output: '', durationSec: (Date.now() - started) / SECOND });
    }
  }
  return result;
}

/** Whether any case failed or errored. */
export const anyFailed = (suites: SuiteResult[]): boolean => suites.some(s => s.cases.some(c => c.status === 'failed' || c.status === 'error'));
