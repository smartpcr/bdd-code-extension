// Binding support per action (plan B2.3) and the binding table with its drift (plan B4).

export interface BadgeBinding {
  name: string;
  abbreviation?: string;
  label?: string;
}

/**
 * The abbreviations of the bindings that implement an action, in the catalog's
 * top-level order, then any binding the catalog does not list.
 */
export function renderBindingBadge(order: string[], actionBindings: string[], known: BadgeBinding[]): string {
  const rank = (b: string) => (order.includes(b) ? order.indexOf(b) : order.length);
  return [...actionBindings].sort((a, b) => rank(a) - rank(b))
    .map(b => known.find(k => k.name === b)?.abbreviation || b).join(' ');
}

export function bindingTooltip(actionBindings: string[], known: BadgeBinding[], target: string): string {
  const label = (b: string) => known.find(k => k.name === b)?.label || b;
  const lines = [`Implemented by: ${actionBindings.length ? actionBindings.map(label).join(', ') : 'no binding'}`];
  if (!actionBindings.includes(target)) lines.push(`Not implemented by ${label(target)}`);
  return lines.join('\n');
}

/**
 * The bindings with no registration of an action (from the code, not the
 * catalog), in the order given, split by whether a stub can be generated for
 * them: what the step's CodeLens offers to implement, and what it can only name.
 */
export function missingImplementations(registeredIn: string[], bindings: BadgeBinding[], canGenerate: (binding: string) => boolean):
  { missing: BadgeBinding[]; generate: BadgeBinding[] } {
  const missing = bindings.filter(b => !registeredIn.includes(b.name));
  return { missing, generate: missing.filter(b => canGenerate(b.name)) };
}

/**
 * The binding names the workspace implements actions in: its catalog's own
 * top-level `bindings`, or, when it lists none, those with the imported ones.
 */
export function expectedBindings(catalog: { bindings: string[]; ownBindings?: string[] }): string[] {
  return catalog.ownBindings?.length ? catalog.ownBindings : catalog.bindings;
}

/**
 * The bindings an action of the workspace's catalog is expected in: the ones
 * its own top-level `bindings` lists, in that order, or every configured
 * binding when it lists none. An imported catalog's bindings do not widen it.
 */
export function workspaceBindings<B extends { name: string }>(own: string[] | undefined, configured: B[]): B[] {
  if (!own?.length) return [...configured];
  return own.flatMap(name => configured.filter(b => b.name === name));
}

/** Completion sort key: actions the target binding implements first, then by name (B3.1-2). */
export function actionSortKey(name: string, actionBindings: string[], target: string): string {
  return `${actionBindings.includes(target) ? '0' : '1'}${name}`;
}

// ---- The binding table and drift (plan B4.1, B4.3) ----

export interface CoverageBinding {
  name: string;
  label: string;
  sources: string[];
}

/** What a binding's program says it implements, compared with the catalog and the source (B4.3). */
export type ProgramCheck =
  | { ok: true; names: string[]; programOnly: string[]; programMissing: string[]; notInSource: string[]; sourceOnly: string[] }
  | { ok: false; failure: string };

export interface CoverageRow {
  binding: string;
  label: string;
  /** The common directory of the binding's source globs. */
  source: string;
  /** Actions whose catalog entry lists this binding. */
  declared: string[];
  /** Distinct action names registered in the binding's source. */
  found: string[];
  declaredNotFound: string[];
  foundNotDeclared: string[];
  /** Names with more than one site from the same recognizer. */
  duplicates: string[];
  program?: ProgramCheck;
}

export const driftCount = (r: CoverageRow): number =>
  r.declaredNotFound.length + r.foundNotDeclared.length + r.duplicates.length;

/** The directory part of a glob before its first wildcard segment, with a trailing slash. */
export function globDirectory(glob: string): string {
  const parts = glob.split('/');
  const fixed: string[] = [];
  for (const p of parts.slice(0, -1)) {
    if (/[*?[{]/.test(p)) break;
    fixed.push(p);
  }
  return fixed.length ? `${fixed.join('/')}/` : '';
}

/** The longest directory prefix shared by every source glob. */
export function commonSource(sources: string[]): string {
  const dirs = sources.map(globDirectory);
  if (!dirs.length) return '';
  let prefix = dirs[0];
  for (const d of dirs.slice(1)) {
    while (!d.startsWith(prefix)) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf('/') + 1);
  }
  return prefix;
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

/**
 * One row per binding the catalog lists, in its order (B4.1): its own list
 * when it has one, not the bindings an import adds. Sites of other bindings
 * are ignored. An action from an imported catalog (`file` set: the
 * core, DEC-S10) is registered by the runtime, outside the workspace's
 * sources, so it is not part of any row.
 */
export function computeCoverage(catalog: { bindings: string[]; ownBindings?: string[]; actions: Map<string, { bindings: string[]; file?: string }> },
  sites: { binding: string; action: string; recognizer: number }[], bindings: CoverageBinding[]): CoverageRow[] {
  return expectedBindings(catalog).map(name => {
    const declared = new Set([...catalog.actions].filter(([, a]) => !a.file && a.bindings.includes(name)).map(([n]) => n));
    const mine = sites.filter(s => s.binding === name);
    const found = new Set(mine.map(s => s.action));
    const perRecognizer = new Map<string, number>();
    for (const s of mine) perRecognizer.set(`${s.recognizer}|${s.action}`, (perRecognizer.get(`${s.recognizer}|${s.action}`) ?? 0) + 1);
    const duplicates = new Set([...perRecognizer].filter(([, n]) => n > 1).map(([k]) => k.slice(k.indexOf('|') + 1)));
    const b = bindings.find(x => x.name === name);
    return {
      binding: name,
      label: b?.label ?? name,
      source: commonSource(b?.sources ?? []),
      declared: sorted(declared),
      found: sorted(found),
      declaredNotFound: sorted([...declared].filter(n => !found.has(n))),
      foundNotDeclared: sorted([...found].filter(n => !declared.has(n))),
      duplicates: sorted(duplicates),
    };
  });
}

/** Compare a program's `actions --json` with the row's catalog and source sets (B4.3). */
export function compareProgramSet(row: CoverageRow, names: string[]): ProgramCheck {
  const program = new Set(names);
  const declared = new Set(row.declared);
  const found = new Set(row.found);
  return {
    ok: true,
    names: sorted(program),
    programOnly: sorted(names.filter(n => !declared.has(n))),
    programMissing: row.declared.filter(n => !program.has(n)),
    notInSource: sorted(names.filter(n => !found.has(n))),
    sourceOnly: row.found.filter(n => !program.has(n)),
  };
}

export function programAgrees(check: ProgramCheck | undefined): boolean | undefined {
  if (!check) return undefined;
  return check.ok && !check.programOnly.length && !check.programMissing.length && !check.notInSource.length && !check.sourceOnly.length;
}

/** The binding table as Markdown (B4.1's command). */
export function toMarkdownTable(rows: CoverageRow[]): string {
  const withProgram = rows.some(r => r.program);
  const head = ['Binding', 'Source', 'Declared', 'Found', 'Drift', ...(withProgram ? ['Program'] : [])];
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const r of rows) {
    const cells = [r.label, r.source ? `\`${r.source}\`` : '', String(r.declared.length), String(r.found.length), String(driftCount(r))];
    if (withProgram) {
      cells.push(!r.program ? '' : r.program.ok ? (programAgrees(r.program) ? `agrees (${r.program.names.length})` : 'differs') : `failed: ${r.program.failure}`);
    }
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}
