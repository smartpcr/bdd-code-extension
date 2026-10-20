// The test-generation config, bddsuite.tests.yaml (spec/test-plan.md;
// docs/test-providers, D16): its findings while it is typed, checked against
// spec/tests.config.schema.json; completion of its keys and providers; and the
// offline actions a suite takes from the nearest config, so the editor's run
// decides "lab suite" as the generated tests decide "guarded". Findings carry
// the extension's own codes (BDD070 a key the config does not have, BDD071 any
// other refusal), never an E/W code (INV-2).
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import * as path from 'path';
import { isMap, isScalar, isSeq } from 'yaml';
import { checkAgainstSchema } from './schemaCheck';
import { TESTS_CONFIG_SCHEMA } from './testsConfigSchema';
import { Range } from './text';
import { parseYaml, stringItems, valueOf } from './yamlPositions';

/** The file name spec/test-plan.md gives the config. */
export const TESTS_CONFIG_FILE = 'bddsuite.tests.yaml';
export const CONFIG_KEYS: readonly string[] = Object.keys(TESTS_CONFIG_SCHEMA.properties);
export const OUTPUT_KEYS: readonly string[] = Object.keys(TESTS_CONFIG_SCHEMA.properties.output.properties);
export const PROVIDERS: readonly string[] = TESTS_CONFIG_SCHEMA.properties.provider.enum;

/** A config by its name: bddsuite.tests.yaml, or another <name>.tests.yaml (a project with two). */
export function isTestsConfigFile(file: string): boolean {
  const name = path.basename(file).toLowerCase();
  return name === TESTS_CONFIG_FILE || name.endsWith('.tests.yaml');
}

export interface ConfigFinding {
  code: 'BDD070' | 'BDD071';
  range: Range;
  message: string;
}

let compiled: ValidateFunction | undefined;
const validator = (): ValidateFunction => (compiled ??= new Ajv2020({ allErrors: true, strict: false, verbose: true }).compile(TESTS_CONFIG_SCHEMA));

/** Edit distance, for the nearest spelling of a misspelled key. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/** The known key nearest a misspelled one, when one is near enough to be meant. */
export function nearestKey(name: string, known: readonly string[]): string | undefined {
  const scored = known.map(k => ({ k, d: distance(name.toLowerCase(), k.toLowerCase()) })).sort((x, y) => x.d - y.d);
  const best = scored[0];
  return best && best.d <= Math.max(2, Math.floor(best.k.length / 3)) ? best.k : undefined;
}

/** The config's findings, each at the key or value it concerns. */
export function checkTestsConfig(text: string): ConfigFinding[] {
  return checkAgainstSchema(text, validator()).map(f => {
    const unknown = /^Property "(.+)" is not allowed here\.$/.exec(f.message);
    if (!unknown) return { code: 'BDD071', ...f };
    const near = nearestKey(unknown[1]!, [...CONFIG_KEYS, ...OUTPUT_KEYS]);
    return { code: 'BDD070', range: f.range, message: `${unknown[1]} is not a config key (spec/tests.config.schema.json).${near ? ` Did you mean ${near}?` : ''}` };
  });
}

export interface ConfigCompletion {
  kind: 'key' | 'value';
  items: string[];
}

/** The key the indented line at `lineStart` sits under, if its parent is a `key:` line. */
function parentKey(text: string, lineStart: number, indent: number): string | undefined {
  const lines = text.slice(0, lineStart).split('\n').reverse();
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const own = line.length - line.trimStart().length;
    if (own >= indent) continue;
    return /^\s*([A-Za-z]+):\s*(#.*)?$/.exec(line)?.[1];
  }
  return undefined;
}

/** The top-level keys a config already has. */
function presentKeys(text: string): Set<string> {
  const top = parseYaml(text).doc.contents;
  return new Set(isMap(top) ? top.items.filter(p => isScalar(p.key)).map(p => String((p.key as { value: unknown }).value)) : []);
}

/**
 * What completion offers at an offset: the providers after `provider:`, the
 * config's keys it does not have yet at the start of a top-level line, and the
 * output keys inside `output:`.
 */
export function testsConfigCompletion(text: string, offset: number): ConfigCompletion | undefined {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const before = text.slice(lineStart, offset);
  if (/^\s*provider:\s*[A-Za-z]*$/.test(before)) return { kind: 'value', items: [...PROVIDERS] };
  if (/^[A-Za-z]*$/.test(before)) {
    const present = presentKeys(text);
    return { kind: 'key', items: CONFIG_KEYS.filter(k => !present.has(k)) };
  }
  const indented = /^(\s+)[A-Za-z]*$/.exec(before);
  if (indented && parentKey(text, lineStart, indented[1]!.length) === 'output') return { kind: 'key', items: [...OUTPUT_KEYS] };
  return undefined;
}

const slashes = (p: string) => p.replace(/\\/g, '/');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A config glob as a pattern over full paths with forward slashes
 * (spec/test-plan.md, Building the plan, step 1): ** any number of folders, *
 * any text inside one name, ? one character, .. before the first wildcard.
 * ignoreCase for a file system that ignores case (Windows).
 */
export function globPattern(folder: string, glob: string, ignoreCase: boolean): RegExp {
  const segments = glob.split('/');
  let fixed = 0;
  while (fixed < segments.length - 1 && !/[*?]/.test(segments[fixed]!)) fixed++;
  const start = slashes(path.resolve(folder, ...segments.slice(0, fixed))).replace(/\/$/, '');
  const rest = segments.slice(fixed).join('/');
  let built = `^${escape(start)}/`;
  for (let i = 0; i < rest.length; i++) {
    const one = rest[i]!;
    if (one === '*' && rest[i + 1] === '*') {
      const folders = rest[i + 2] === '/';
      built += folders ? '(?:.*/)?' : '.*';
      i += folders ? 2 : 1;
    } else built += one === '*' ? '[^/]*' : one === '?' ? '[^/]' : escape(one);
  }
  return new RegExp(`${built}$`, ignoreCase ? 'i' : '');
}

/** Whether a config in `folder` selects `file`: an include matches it and no exclude does. */
export function configSelects(folder: string, includes: string[], excludes: string[], file: string, ignoreCase: boolean): boolean {
  const full = slashes(path.resolve(file));
  return includes.some(g => globPattern(folder, g, ignoreCase).test(full)) && !excludes.some(g => globPattern(folder, g, ignoreCase).test(full));
}

export interface OfflineSource {
  config: string;
  offlineActions: string[];
}

/**
 * The offline actions a suite takes from the nearest bddsuite.tests.yaml: the
 * one in the suite's folder or the closest folder above it, up to `root`, when
 * that config selects the suite and lists offlineActions. Undefined otherwise,
 * and the bddSuite.offlineActions setting applies.
 */
export function offlineActionsFor(suite: string, root: string, read: (file: string) => string | undefined, ignoreCase: boolean): OfflineSource | undefined {
  const file = path.resolve(suite);
  const top = path.resolve(root);
  const from = (dir: string): OfflineSource | undefined => {
    const config = path.join(dir, TESTS_CONFIG_FILE);
    const text = read(config);
    if (text !== undefined) {
      const contents = parseYaml(text).doc.contents;
      const offline = valueOf(contents, 'offlineActions');
      if (!isSeq(offline) || !configSelects(dir, stringItems(valueOf(contents, 'suites')), stringItems(valueOf(contents, 'exclude')), file, ignoreCase)) return undefined;
      return { config, offlineActions: stringItems(offline) };
    }
    // Up to the root and no further; a folder on another drive than the root is outside it.
    const inside = path.relative(top, dir);
    return !inside || inside.startsWith('..') || path.isAbsolute(inside) ? undefined : from(path.dirname(dir));
  };
  return from(path.dirname(file));
}
