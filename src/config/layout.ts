// The workspace layout: where the repository root, the catalog, the suites and
// each binding's sources are, resolved once from the settings (plan B1.1).
// No vscode import, so it is unit-tested in Node.
import * as path from 'path';
import { fileKey } from '../core/paths';
import { BindingSettings, DEFAULT_BINDINGS, DEFAULT_SETTINGS, Settings } from './defaults';

/** Nearest ancestor of `start` (inclusive) holding test/e2e/schema, the rule every suiterun uses. */
export function findRepositoryRoot(start: string, exists: (p: string) => boolean): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (exists(path.join(dir, 'test', 'e2e', 'schema'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export { fileKey };

export interface SettingsResult {
  settings: Settings;
  messages: string[];
}

type Getter = (key: string) => unknown;

const kindOf = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const isObject = (v: unknown): v is Record<string, unknown> => kindOf(v) === 'object';

function bad(messages: string[], key: string, expected: string, value: unknown): void {
  messages.push(`BDD010 bddSuite.${key}: expected ${expected}, got ${kindOf(value)}; using the default.`);
}

/** A binding no default or setting describes: a name, and nothing to find or run. */
const emptyBinding = (name: string): BindingSettings => ({
  label: name, abbreviation: name, sources: [], exclude: [], recognizers: [], tool: [],
});

/** One binding's settings over its default (or over an empty binding for a new name). */
function readBinding(name: string, value: unknown, messages: string[]): BindingSettings | undefined {
  const key = `bindings.${name}`;
  if (!isObject(value)) {
    bad(messages, key, 'object', value);
    return DEFAULT_BINDINGS[name];
  }
  const base: BindingSettings = DEFAULT_BINDINGS[name] ?? emptyBinding(name);
  const out: BindingSettings = { ...base };
  const strings: (keyof BindingSettings)[] = ['label', 'abbreviation', 'library'];
  for (const f of strings) {
    if (value[f] === undefined) continue;
    if (typeof value[f] === 'string') (out as unknown as Record<string, unknown>)[f] = value[f];
    else bad(messages, `${key}.${f}`, 'string', value[f]);
  }
  if (value.selectsOneCase !== undefined) {
    if (typeof value.selectsOneCase === 'boolean') out.selectsOneCase = value.selectsOneCase;
    else bad(messages, `${key}.selectsOneCase`, 'boolean', value.selectsOneCase);
  }
  for (const f of ['sources', 'exclude', 'tool'] as const) {
    if (value[f] === undefined) continue;
    if (isStringArray(value[f])) out[f] = value[f] as string[];
    else bad(messages, `${key}.${f}`, 'string[]', value[f]);
  }
  if (value.recognizers !== undefined) {
    const r = value.recognizers;
    if (Array.isArray(r) && r.every(x => isObject(x) && typeof x.pattern === 'string'
      && (x.flags === undefined || typeof x.flags === 'string')
      && (x.prefix === undefined || typeof x.prefix === 'string'))) {
      out.recognizers = r as BindingSettings['recognizers'];
    } else bad(messages, `${key}.recognizers`, '{ pattern, flags?, prefix? }[]', r);
  }
  if (value.build !== undefined) {
    const b = value.build;
    if (isObject(b) && typeof b.command === 'string' && typeof b.cwd === 'string'
      && (b.shell === undefined || typeof b.shell === 'boolean')) {
      out.build = b as unknown as BindingSettings['build'];
    } else bad(messages, `${key}.build`, '{ command, cwd, shell? }', b);
  }
  return out;
}

/** Settings with wrong-typed values replaced by defaults, one BDD010 message each (B1.1-4). */
export function readSettings(get: Getter): SettingsResult {
  const messages: string[] = [];
  const s: Settings = { ...DEFAULT_SETTINGS };
  const strings = ['catalogPath', 'exclude', 'lintTool', 'targetBinding', 'templatesDir',
    'lab.apiUrl', 'lab.labId', 'lab.connectionFile'] as const;
  for (const k of strings) {
    const v = get(k);
    if (v === undefined) continue;
    if (typeof v === 'string') s[k] = v;
    else bad(messages, k, 'string', v);
  }
  for (const k of ['suiteGlobs', 'schemaGenerator', 'offlineActions', 'contextKeys'] as const) {
    const v = get(k);
    if (v === undefined) continue;
    if (isStringArray(v)) s[k] = v;
    else bad(messages, k, 'string[]', v);
  }
  for (const k of ['inlayHints.bindings', 'codeLens.implement'] as const) {
    const v = get(k);
    if (v === undefined) continue;
    if (typeof v === 'boolean') s[k] = v;
    else bad(messages, k, 'boolean', v);
  }
  const bindings = get('bindings');
  if (bindings !== undefined) {
    if (isObject(bindings)) {
      const merged: Record<string, BindingSettings> = { ...DEFAULT_BINDINGS };
      for (const [name, value] of Object.entries(bindings)) {
        const b = readBinding(name, value, messages);
        if (b) merged[name] = b;
      }
      s.bindings = merged;
    } else bad(messages, 'bindings', 'object', bindings);
  }
  return { settings: s, messages };
}

export interface ResolvedBinding extends BindingSettings {
  name: string;
}

/**
 * The catalog's `bindingSources` as globs relative to the workspace folder, with
 * forward slashes: each glob is relative to the catalog file, as its imports are.
 * A glob that is absolute or reaches outside the folder is left out and named in
 * `skipped`, since the index only reads files inside the folder.
 */
export function catalogSourceGlobs(folder: string, catalogPath: string, sources: Record<string, string[]>):
  { globs: Record<string, string[]>; skipped: string[] } {
  const globs: Record<string, string[]> = {};
  const skipped: string[] = [];
  for (const [binding, list] of Object.entries(sources)) {
    const kept = list.flatMap(g => {
      const rel = path.isAbsolute(g) ? undefined : path.relative(folder, path.resolve(path.dirname(catalogPath), g));
      if (rel === undefined || rel.startsWith('..') || path.isAbsolute(rel)) {
        skipped.push(`${binding}: ${g}`);
        return [];
      }
      return [rel.split(path.sep).join('/')];
    });
    if (kept.length) globs[binding] = kept;
  }
  return { globs, skipped };
}

/** The settings resolved against one workspace folder. */
export class WorkspaceLayout {
  private constructor(
    readonly folder: string,
    readonly root: string,
    readonly catalogPath: string,
    readonly suiteGlobs: string[],
    readonly exclude: string,
    readonly bindings: ResolvedBinding[],
    readonly settings: Settings,
    /** The catalog's `bindingSources` this layout applied, as the catalog wrote them; a change means a rebuild. */
    readonly catalogSources?: Record<string, string[]>,
  ) {}

  /**
   * undefined when the folder has no catalog at the configured path, or no root
   * above it. `catalogSources` (the `bindingSources` of the catalog and its imports, merged and relative to the catalog) replaces the
   * `sources` of each binding it names, and adds a binding it names that the
   * settings do not have.
   */
  static create(folder: string, settings: Settings, storagePath: string,
    exists: (p: string) => boolean, catalogSources?: Record<string, string[]>): WorkspaceLayout | undefined {
    const catalogPath = fileKey(path.resolve(folder, settings.catalogPath));
    if (!exists(catalogPath)) return undefined;
    const root = findRepositoryRoot(path.dirname(catalogPath), exists);
    if (!root) return undefined;
    const expand = (s: string) => s.split('${storage}').join(storagePath);
    // A build command is a shell string, so a storage path with spaces is quoted there.
    const quoted = /\s/.test(storagePath) ? `"${storagePath}"` : storagePath;
    const fromCatalog = catalogSources ? catalogSourceGlobs(fileKey(folder), catalogPath, catalogSources).globs : {};
    const configured: Record<string, BindingSettings> = { ...settings.bindings };
    for (const name of Object.keys(fromCatalog)) configured[name] ??= emptyBinding(name);
    const bindings = Object.entries(configured).map(([name, b]): ResolvedBinding => ({
      ...b,
      name,
      sources: fromCatalog[name] ?? b.sources,
      tool: b.tool.map(expand),
      build: b.build && { ...b.build, command: b.build.command.split('${storage}').join(quoted) },
    }));
    return new WorkspaceLayout(fileKey(folder), fileKey(root), catalogPath, settings.suiteGlobs,
      settings.exclude, bindings, settings, catalogSources);
  }
}
