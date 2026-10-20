// The test plan (spec/test-plan.md): the suites a config selects, each with
// its cases and rows, the identifiers generated code names them by, and
// whether the suite is guarded. Every runtime builds the same plan from the
// same config (conformance/generate/).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { coreActions } from '../actions/core.js';
import { Diagnostic, fails, sorted } from '../diag.js';
import { compose } from '../extension.js';
import { loadDocument } from '../model.js';
import { loadSchema } from '../schema.js';
import { caseTags, cases as allCases, expandedCase, expandedHooks, expandOutline, metaDefinitions, readLibraries } from '../suite.js';
import { isList, isMap, toPlain, Value, ValueMap } from '../value.js';
import { textOf } from '../walk.js';
import { validateFile } from '../validate/index.js';
import { select } from './globs.js';
import { TestsConfig } from './config.js';

/** The case identifiers generated code declares members with, taken before any case of a suite is named. */
export const RESERVED_IN_SUITE = ['Setup', 'Teardown', 'BeforeEach', 'AfterEach', 'TestContext', 'Session'];

/** The identifier a name gives before collisions: its ASCII letters and digits, each word capitalised; the fallback for none; N before a digit. */
export function identifierOf(name: string, fallback: string): string {
  let built = '';
  let startOfWord = true;
  for (const one of name) {
    if (!/^[A-Za-z0-9]$/.test(one)) {
      startOfWord = true;
      continue;
    }
    built += startOfWord ? one.toUpperCase() : one;
    startOfWord = false;
  }
  built ||= fallback;
  return /^[0-9]/.test(built) ? `N${built}` : built;
}

/** Gives names their identifiers, _2, _3, ... on a collision compared ignoring ASCII case. */
export class Identifiers {
  private readonly taken: Set<string>;

  constructor(reserved: readonly string[] = []) {
    this.taken = new Set(reserved.map(r => r.toLowerCase()));
  }

  take(name: string, fallback: string): string {
    const wanted = identifierOf(name, fallback);
    let candidate = wanted;
    for (let n = 2; this.taken.has(candidate.toLowerCase()); n++) candidate = `${wanted}_${n}`;
    this.taken.add(candidate.toLowerCase());
    return candidate;
  }
}

/** Whether an offlineActions pattern covers an action: the name itself, or prefix.* and a name under the prefix. */
export const covers = (pattern: string, action: string): boolean => (pattern.endsWith('*') ? action.startsWith(pattern.slice(0, -1)) : pattern === action);

/** Every action a suite can run: its hooks and every case's phases, meta steps expanded (imported ones too), and the step each wait polls. */
export function actionsOf(suite: ValueMap, file: string): string[] {
  const definitions = metaDefinitions(suite, readLibraries(suite, file));
  const lists = [...Object.values(expandedHooks(suite, definitions)), ...allCases(suite).flatMap(c => Object.values(expandedCase(c, definitions)))];
  const out: string[] = [];
  for (const step of lists.flat()) {
    for (let current: ValueMap | undefined = step; current; current = isMap(current.get('forStep')) ? (current.get('forStep') as ValueMap) : undefined) {
      const name = textOf(current, 'action');
      if (name) out.push(name);
    }
  }
  return out;
}

export interface PlannedCase {
  name: string;
  id: string;
  tags: string[];
  /** The outline's own name, for a row of an examples table. */
  outline?: string;
  row?: ValueMap;
}

export interface PlannedSuite {
  /** Relative to the config's folder, with forward slashes. */
  file: string;
  fullPath: string;
  name: string;
  id: string;
  tags: string[];
  guarded: boolean;
  guardedBy: string[];
  cases: PlannedCase[];
}

export interface Plan {
  config: TestsConfig;
  suites: PlannedSuite[];
}

const distinct = (values: string[]) => [...new Set(values)];

/**
 * A config's plan, or the findings of every suite that does not lint clean:
 * nothing is generated from a partial plan. Throws for a harness error.
 */
export function buildPlan(config: TestsConfig): { plan?: Plan; findings: Diagnostic[] } {
  const schema = loadSchema(config.schemaRoot);
  // The suites lint before any extension is loaded, so the context keys the
  // extensions add come from the config.
  const extensions = compose([{ name: "the config's context keys", contextKeys: config.contextKeys }], coreActions);
  const settings = { binding: 'typescript', bindingCheck: false, params: [] as [string, string][], extensions };
  const loaded: { relative: string; full: string; suite: ValueMap }[] = [];
  const findings: Diagnostic[] = [];
  for (const relative of select(config.folder, config.suites, config.exclude)) {
    const full = path.join(config.folder, relative);
    const value = loadDocument(fs.readFileSync(full, 'utf8')).value;
    // A library declares and never runs: only a file with a suite key is a suite.
    if (!isMap(value) || !value.has('suite')) continue;
    findings.push(...validateFile(full, relative, schema, settings));
    loaded.push({ relative, full, suite: value });
  }
  const found = sorted(findings);
  if (fails(found, false)) return { findings: found };

  const suiteIds = new Identifiers();
  const suites = loaded.map(({ relative, full, suite }): PlannedSuite => {
    const name = textOf(suite, 'suite');
    const caseIds = new Identifiers(RESERVED_IN_SUITE);
    const cases: PlannedCase[] = [];
    for (const entry of (suite.get('tests') as Value[] | undefined ?? []).filter(isMap)) {
      const rows = entry.get('examples');
      const outline = isList(rows) && rows.length ? textOf(entry, 'name') : undefined;
      for (const expanded of expandOutline(entry)) {
        const caseName = textOf(expanded, 'name');
        cases.push({
          name: caseName, id: caseIds.take(caseName, 'Case'), tags: distinct(caseTags(suite, expanded)),
          ...(outline !== undefined ? { outline, row: expanded.get('__row') as ValueMap } : {}),
        });
      }
    }
    const guardedBy = config.offlineActions
      ? distinct(actionsOf(suite, full)).filter(a => !config.offlineActions!.some(p => covers(p, a))).sort()
      : [];
    const tags = suite.get('tags');
    return {
      file: relative, fullPath: full, name, id: suiteIds.take(name, 'Suite'), tags: distinct(isList(tags) ? tags.filter((t): t is string => typeof t === 'string') : []),
      guarded: guardedBy.length > 0, guardedBy, cases,
    };
  });
  return { plan: { config, suites }, findings: found };
}

/** The plan as spec/test-plan.schema.json describes it: indented UTF-8 with non-ASCII characters as themselves. */
export function planJson(plan: Plan): string {
  return JSON.stringify({
    planVersion: 1,
    suites: plan.suites.map(s => ({
      file: s.file, name: s.name, id: s.id, tags: s.tags, guarded: s.guarded, guardedBy: s.guardedBy,
      cases: s.cases.map(c => ({ name: c.name, id: c.id, ...(c.outline !== undefined ? { outline: c.outline, row: toPlain(c.row) } : {}), tags: c.tags })),
    })),
  }, null, 2);
}
