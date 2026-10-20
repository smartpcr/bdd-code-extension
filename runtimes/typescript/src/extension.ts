// The extension API (DEC-S03): how code outside this runtime adds to it
// without editing it. An extension may add any of five things:
//
//   actions      name to handler, each handler seeing its extension's per-run state
//   context keys names readable in ${...} and known to dataflow lint
//   options      command-line flags the extension declares and reads
//   rules        extra lint rules, and a limit a case may not exceed at run time
//   env prefix   the prefix of the parameter and record variables
//
// A consumer builds its own suiterun from the runtime and its extensions:
//
//   import { main } from '@bdd-suite/runtime/cli';
//   process.exitCode = await main(process.argv.slice(2), undefined, [myExtension]);
//
// Several extensions compose; a name two of them define, or one that clashes
// with the core, is refused when they are composed, before anything runs.
import type { Diagnostic } from './diag.js';
import type { Document } from './model.js';
import type { Handler, Registration } from './actions/registry.js';
import type { Library } from './validate/semantics.js';
import type { Value, ValueMap } from './value.js';

/** A command-line flag an extension takes, always with a value: `--api-url <value>`. */
export interface ExtensionOption {
  /** With the leading dashes, e.g. `--api-url`. */
  flag: string;
  /** One line for the usage text. */
  description: string;
}

/** What a lint rule sees: one parsed suite file and what its imports declare. */
export interface RuleInput {
  doc: Document;
  /** Relative to the workspace root, as findings report it. */
  file: string;
  suite: ValueMap;
  library: Library;
}

export interface Rules {
  /** Findings beyond the core's, positioned like every other (diagnostics.md). */
  lint?(input: RuleInput): Diagnostic[];
  /** The limit a case runs under, given the one the suite declares; the smaller of the two applies. */
  caseLimitSec?(suite: ValueMap, declaredSec: number): number;
}

/** What one run of an extension provides, from the values of its options. */
export interface RunState {
  /** A value for each context key, as ${key} reads it; a declared key with no value reads as ''. */
  context?: Record<string, Value>;
  /** Applied to every text a report carries, e.g. to hide secrets. */
  redact?(text: string): string;
  /** Handed to this extension's actions as request.state. */
  state?: unknown;
}

export interface Extension {
  /** Shown in errors about this extension. */
  name: string;
  actions?: Registration[];
  contextKeys?: string[];
  options?: ExtensionOption[];
  rules?: Rules;
  /** The prefix of PARAM_<NAME> and RECORD_PATH; BDD_SUITE_ when no extension sets one. */
  envPrefix?: string;
  /** Called once per run, with the values given for this extension's options (flag to value). */
  start?(options: Map<string, string>): RunState;
}

export const DEFAULT_ENV_PREFIX = 'BDD_SUITE_';

/** The roots every expression may start at, before any extension adds context keys. */
export const CORE_ROOTS: readonly string[] = ['capture', 'param', 'var', 'row', 'timeoutSec', 'defaults'];

/** The core's own flags; an extension may not take one. */
const CORE_FLAGS = ['--path', '--tags', '--name', '--progress', '--results', '--trace-file', '--schema-root', '--binding', '--format', '--param', '--json', '--strict',
  '--dry-run', '--binding-check'];

export class ExtensionError extends Error {}

/** Every extension of one runtime, merged and checked. */
export interface Composite {
  extensions: readonly Extension[];
  /** Action name to its handler and the extension that registered it. */
  actions: Map<string, { handler: Handler; owner: Extension }>;
  /** CORE_ROOTS and every extension's context keys. */
  roots: readonly string[];
  contextKeys: readonly string[];
  options: readonly ExtensionOption[];
  envPrefix: string;
  lint(input: RuleInput): Diagnostic[];
  caseLimitSec(suite: ValueMap, declaredSec: number): number;
}

/** Merges extensions, refusing any name defined twice or taken from the core. */
export function compose(extensions: readonly Extension[] = [], coreActions: readonly Registration[] = []): Composite {
  const actions = new Map<string, { handler: Handler; owner: Extension }>();
  const core: Extension = { name: 'the core' };
  for (const r of coreActions) actions.set(r.name, { handler: r.handler, owner: core });
  const keys = new Map<string, string>(CORE_ROOTS.map(k => [k, 'the core']));
  const flags = new Map<string, string>(CORE_FLAGS.map(f => [f, 'the core']));
  let envPrefix: { value: string; owner: string } | undefined;
  for (const e of extensions) {
    for (const r of e.actions ?? []) {
      const held = actions.get(r.name);
      if (held) throw new ExtensionError(`Action ${r.name} is defined by both ${held.owner.name} and ${e.name}.`);
      actions.set(r.name, { handler: r.handler, owner: e });
    }
    for (const k of e.contextKeys ?? []) {
      const held = keys.get(k);
      if (held) throw new ExtensionError(`Context key ${k} is defined by both ${held} and ${e.name}.`);
      keys.set(k, e.name);
    }
    for (const o of e.options ?? []) {
      if (!/^--[a-z][a-z0-9-]*$/.test(o.flag)) throw new ExtensionError(`${e.name} declares the option ${o.flag}; an option is --lower-case-words.`);
      const held = flags.get(o.flag);
      if (held) throw new ExtensionError(`Option ${o.flag} is defined by both ${held} and ${e.name}.`);
      flags.set(o.flag, e.name);
    }
    if (e.envPrefix !== undefined) {
      if (envPrefix && envPrefix.value !== e.envPrefix) {
        throw new ExtensionError(`${envPrefix.owner} sets the environment prefix ${envPrefix.value} and ${e.name} sets ${e.envPrefix}.`);
      }
      envPrefix = { value: e.envPrefix, owner: e.name };
    }
  }
  const contextKeys = [...keys].filter(([, owner]) => owner !== 'the core').map(([k]) => k);
  return {
    extensions,
    actions,
    roots: [...CORE_ROOTS, ...contextKeys],
    contextKeys,
    options: extensions.flatMap(e => e.options ?? []),
    envPrefix: envPrefix?.value ?? DEFAULT_ENV_PREFIX,
    lint: input => extensions.flatMap(e => e.rules?.lint?.(input) ?? []),
    caseLimitSec: (suite, declared) => extensions.reduce((limit, e) => Math.min(limit, e.rules?.caseLimitSec?.(suite, declared) ?? limit), declared),
  };
}

/** One run's started extensions: each one's state, the context values, and one redaction over all of them. */
export interface Started {
  states: Map<Extension, unknown>;
  context: Map<string, Value>;
  redact(text: string): string;
}

/** Starts every extension with its own options' values, once per run. */
export function start(composite: Composite, values: Map<string, string>): Started {
  const states = new Map<Extension, unknown>();
  // Only the values given: a declared key with none reads as '' unless the suite's defaults name it (exec.ts).
  const context = new Map<string, Value>();
  const redactors: ((t: string) => string)[] = [];
  for (const e of composite.extensions) {
    const own = new Map([...values].filter(([flag]) => (e.options ?? []).some(o => o.flag === flag)));
    const run = e.start?.(own) ?? {};
    states.set(e, run.state);
    for (const [k, v] of Object.entries(run.context ?? {})) if ((e.contextKeys ?? []).includes(k)) context.set(k, v);
    if (run.redact) redactors.push(run.redact);
  }
  return { states, context, redact: text => redactors.reduce((t, r) => r(t), text) };
}
