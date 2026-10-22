// @bdd-suite/runtime/testing: suite cases as node:test, Vitest or Jest tests
// (docs/test-providers, D12). A generated <Id>.bdd.test.ts imports its
// framework's describe, it and suite-level hooks and passes them here, so one
// module serves the three frameworks:
//
//   suite({ describe, it, before, after, skip }, [extension], import.meta.url, { file, shown, schemaRoot, name, guarded, cases })
//
// The run context is this module's: one per test file in every framework's
// default isolation, or one per worker where a project shares module state
// (Vitest isolate: false), as DEC-T08 says. A case runs inside its own test:
// beforeEach, the case and afterEach through the session, so the test fails
// exactly when the case did not pass. The suite setup runs in the describe's
// before hook and the teardown in its after hook, whose failure the framework
// shows as a suite-level failure. A case the tag filter does not select, every
// case of a guarded suite without the opt-in, and every case of a dry run are
// skipped when the file loads, because Jest cannot skip at run time; their
// trace entries are written as a run of them would write them. A case that
// skips itself (spec/session.md rule 12) skips its test at run time where the
// framework can: node:test and Vitest through the test's context, Mocha
// through this.skip(). Jest cannot, so there such a test passes.
import { fileURLToPath } from 'node:url';
import { Extension } from '../extension.js';
import { loadSchema, Schema } from '../schema.js';
import { flushTrace, openLinted, RunContext, runContextFromEnv, Session } from '../session.js';

export {
  createRunContext, flushTrace, GUARDED_MESSAGE, openLinted, openSession, optionVariable, runContextFromEnv, Session, SuiteRefusedError,
} from '../session.js';
export type { RunContext, TeardownResult } from '../session.js';

/** The parts of a framework the adapter uses, as the generated file adapts them. */
export interface Framework {
  describe(name: string, body: () => void): unknown;
  /**
   * Declares a test. The body is called with the framework's test context
   * (node:test's t, Vitest's context) as its argument, or Mocha's as this, and
   * declares no parameter, so Jest and Mocha do not take it for a done callback.
   */
  it(name: string, body: (this: unknown, ...context: unknown[]) => Promise<void>): unknown;
  /** The describe's own before-all hook. */
  before(body: () => Promise<void>): unknown;
  /** The describe's own after-all hook. */
  after(body: () => Promise<void>): unknown;
  /** Declares a skipped test, with the reason where the framework shows one. */
  skip(name: string, reason: string): unknown;
}

/** One planned suite, as the generator writes it; paths are relative to the generated file. */
export interface PlannedSuite {
  file: string;
  /** The file as findings name it: relative to the config's folder. */
  shown: string;
  schemaRoot: string;
  name: string;
  guarded: boolean;
  cases: string[];
}

const contexts = new Map<string, RunContext>();
const schemas = new Map<string, Schema>();

/** This module's run context for a set of extensions, built from the environment the first time. */
export function contextFor(extensions: readonly Extension[], env: NodeJS.ProcessEnv = process.env): RunContext {
  const key = extensions.map(e => e.name).join('\n');
  let context = contexts.get(key);
  if (!context) contexts.set(key, (context = runContextFromEnv(extensions, env)));
  return context;
}

function schemaFor(root: string): Schema {
  let schema = schemas.get(root);
  if (!schema) schemas.set(root, (schema = loadSchema(root)));
  return schema;
}

/** Whatever has a skip function: node:test's and Vitest's test context, Mocha's this. */
type Skippable = { skip(reason?: string): unknown };
const skippable = (held: unknown): held is Skippable => typeof (held as Partial<Skippable> | null | undefined)?.skip === 'function';

/**
 * One case through the session, as its test: it throws exactly when the case
 * did not pass, and skips the test when the case skipped itself and the
 * framework gave it a context that can (Vitest's and Mocha's skip throw;
 * node:test's marks the test and returns).
 */
async function runOne(session: Session, index: number, contexts: unknown[]): Promise<void> {
  await session.beforeEach(index);
  let settled;
  try {
    await session.runCase(index);
  } finally {
    settled = await session.afterEach(index);
    if (settled.status === 'failed' || settled.status === 'error') throw new Error(settled.message);
  }
  if (settled.status === 'skipped') contexts.find(skippable)?.skip(settled.message);
}

/**
 * Declares one suite's tests with the framework's functions: a describe named
 * after the suite holding one test per case and row.
 */
export function suite(framework: Framework, extensions: readonly Extension[], base: string, planned: PlannedSuite, env: NodeJS.ProcessEnv = process.env): void {
  // Called as plain functions: Vitest's chainable describe and it read `this`,
  // and as methods of the framework object they declare nothing to vitest list.
  const { describe, it, before, after, skip } = framework;
  const context = contextFor(extensions, env);
  let session: Session | undefined;
  let refused: Error | undefined;
  try {
    const file = fileURLToPath(new URL(planned.file, base));
    session = openLinted(file, planned.shown, schemaFor(fileURLToPath(new URL(planned.schemaRoot, base))), context, planned.guarded);
  } catch (e) {
    refused = e as Error;
  }
  describe(planned.name, () => {
    if (!session) {
      // A suite that does not lint clean, or cannot be read: every case fails with the reason.
      for (const name of planned.cases) it(name, async () => Promise.reject(refused));
      return;
    }
    const held = session;
    const skipped = held.cases.map((_, index) => held.skipOf(index));
    if (skipped.every(Boolean)) {
      // Nothing of the suite will run, so no hook will either: the skips are
      // traced now, before any setup could be.
      held.cases.forEach((name, index) => {
        held.recordSkipped(index);
        skip(name, skipped[index]!.message);
      });
      flushTrace(context);
      return;
    }
    before(() => held.setup());
    held.cases.forEach((name, index) => {
      if (skipped[index]) skip(name, skipped[index].message);
      else it(name, function (this: unknown, ...context: unknown[]) {
        return runOne(held, index, [...context, this]);
      });
    });
    after(async () => {
      held.cases.forEach((_, index) => {
        if (skipped[index]) held.recordSkipped(index);
      });
      const teardown = await held.teardown();
      flushTrace(context);
      if (teardown.failed) throw new Error(`The suite teardown of ${planned.name} failed: ${teardown.message}`);
    });
  });
}
