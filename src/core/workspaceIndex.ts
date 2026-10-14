// The single owner of positions (plan B1.2-B1.6). Providers query it; nothing
// else parses. Joins are rebuilt lazily, once, on the first query after updates.
import { META_DEPTH_LIMIT } from '../limits';
import { fileKey } from './paths';
import { Pos, Range } from './text';
import { Catalog, CatalogAction, MetaStepDef, RegistrationSite, StepInfo, SuiteFile } from './types';

export const contains = (r: Range, p: Pos): boolean =>
  (p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character))
  && (p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character));

const size = (r: Range): number => (r.end.line - r.start.line) * 1e6 + (r.end.character - r.start.character);

export interface MetaTarget {
  file: string;
  def: MetaStepDef;
}

interface Joins {
  libraries: Set<string>;
  stepsByAction: Map<string, StepInfo[]>;
  sitesByAction: Map<string, RegistrationSite[]>;
}

export class WorkspaceIndex {
  catalog?: Catalog;
  catalogStale = false;
  private readonly suites = new Map<string, SuiteFile>();
  private readonly staleSuites = new Set<string>();
  private readonly sites = new Map<string, RegistrationSite[]>();
  private joins?: Joins;
  private readonly listeners = new Set<() => void>();
  /** How many times the joins were rebuilt (B1.7-3). */
  rebuildCount = 0;

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private changed(): void {
    this.joins = undefined;
    for (const l of this.listeners) l();
  }

  /** A catalog that failed to parse keeps the previous one, marked stale. */
  updateCatalog(c: Catalog): void {
    const fatal = c.errors.some(e => e.code === 'BDD022');
    if (fatal && this.catalog) {
      this.catalogStale = true;
      this.catalog = { ...this.catalog, errors: c.errors };
    } else {
      this.catalog = c;
      this.catalogStale = false;
    }
    this.changed();
  }

  /** A suite that failed to parse keeps its previous content, marked stale (B1.3-4). */
  updateSuite(s: SuiteFile): void {
    const key = fileKey(s.file);
    const previous = this.suites.get(key);
    if (s.parseError && previous) {
      this.suites.set(key, { ...previous, parseError: s.parseError });
      this.staleSuites.add(key);
    } else {
      this.suites.set(key, s);
      this.staleSuites.delete(key);
    }
    this.changed();
  }

  removeSuite(file: string): void {
    const key = fileKey(file);
    this.suites.delete(key);
    this.staleSuites.delete(key);
    this.changed();
  }

  updateSources(file: string, sites: RegistrationSite[]): void {
    this.sites.set(fileKey(file), sites);
    this.changed();
  }

  removeSources(file: string): void {
    this.sites.delete(fileKey(file));
    this.changed();
  }

  isStale(file: string): boolean {
    return this.staleSuites.has(fileKey(file));
  }

  private get j(): Joins {
    if (this.joins) return this.joins;
    this.rebuildCount++;
    const libraries = new Set<string>();
    for (const s of this.suites.values()) for (const i of s.imports) libraries.add(fileKey(i.resolved));
    const stepsByAction = new Map<string, StepInfo[]>();
    for (const [key, s] of this.suites) {
      if (!s.hasSuiteKey && !libraries.has(key)) continue;
      for (const step of s.steps) {
        if (step.action === undefined) continue;
        const list = stepsByAction.get(step.action) ?? [];
        list.push(step);
        stepsByAction.set(step.action, list);
      }
    }
    const order = this.catalog?.bindings ?? [];
    const rank = (b: string) => (order.includes(b) ? order.indexOf(b) : order.length);
    const sitesByAction = new Map<string, RegistrationSite[]>();
    for (const list of this.sites.values()) {
      for (const site of list) {
        const all = sitesByAction.get(site.action) ?? [];
        all.push(site);
        sitesByAction.set(site.action, all);
      }
    }
    for (const list of sitesByAction.values()) {
      list.sort((a, b) => rank(a.binding) - rank(b.binding) || a.file.localeCompare(b.file)
        || a.range.start.line - b.range.start.line);
    }
    this.joins = { libraries, stepsByAction, sitesByAction };
    return this.joins;
  }

  /** A file the index treats as a suite or a library (DEC-B13). */
  isSuiteOrLibrary(file: string): boolean {
    const key = fileKey(file);
    const s = this.suites.get(key);
    return !!s && (s.hasSuiteKey || this.j.libraries.has(key));
  }

  /**
   * A file lint should see: a suite or library, or a file that cannot be one
   * because it does not parse or its root is not a mapping (lint says E100).
   */
  isLintCandidate(file: string): boolean {
    const s = this.suites.get(fileKey(file));
    return !!s && (this.isSuiteOrLibrary(file) || !!s.parseError || !!s.notAMapping);
  }

  suiteFiles(): SuiteFile[] {
    return [...this.suites.values()].filter(s => this.isSuiteOrLibrary(s.file));
  }

  suite(file: string): SuiteFile | undefined {
    return this.suites.get(fileKey(file));
  }

  allSites(): RegistrationSite[] {
    return [...this.sites.values()].flat();
  }

  sitesIn(file: string): RegistrationSite[] {
    return this.sites.get(fileKey(file)) ?? [];
  }

  /** The smallest step containing `pos`. */
  stepAt(file: string, pos: Pos): StepInfo | undefined {
    if (!this.isSuiteOrLibrary(file)) return undefined;
    let best: StepInfo | undefined;
    for (const step of this.suites.get(fileKey(file))!.steps) {
      if (contains(step.range, pos) && (!best || size(step.range) < size(best.range))) best = step;
    }
    return best;
  }

  catalogActionAt(file: string, pos: Pos): CatalogAction | undefined {
    if (!this.catalog || fileKey(file) !== fileKey(this.catalog.file)) return undefined;
    for (const a of this.catalog.actions.values()) if (contains(a.nameRange, pos)) return a;
    return undefined;
  }

  siteAt(file: string, pos: Pos): RegistrationSite | undefined {
    return this.sitesIn(file).find(s => contains(s.range, pos));
  }

  /** The action named at `pos`: a step's action value, a catalog entry name, or a registration site. */
  actionNameAt(file: string, pos: Pos): string | undefined {
    const step = this.stepAt(file, pos);
    if (step?.action !== undefined && step.actionRange && contains(step.actionRange, pos)) return step.action;
    return this.catalogActionAt(file, pos)?.name ?? this.siteAt(file, pos)?.action;
  }

  stepsUsing(action: string): StepInfo[] {
    return this.j.stepsByAction.get(action) ?? [];
  }

  sitesFor(action: string): RegistrationSite[] {
    return this.j.sitesByAction.get(action) ?? [];
  }

  /**
   * Meta steps visible from `file` (DEC-Y17): imports depth-first in listed
   * order, then the file's own; a later definition replaces an earlier one.
   */
  visibleMetaSteps(file: string): Map<string, MetaTarget> {
    const out = new Map<string, MetaTarget>();
    const visiting = new Set<string>();
    const visit = (f: string, depth: number) => {
      const key = fileKey(f);
      const s = this.suites.get(key);
      if (!s || visiting.has(key) || depth > META_DEPTH_LIMIT) return;
      visiting.add(key);
      for (const i of s.imports) visit(i.resolved, depth + 1);
      for (const def of s.metaSteps) out.set(def.name, { file: s.file, def });
      visiting.delete(key);
    };
    visit(file, 0);
    return out;
  }

  /** Meta steps visible from a file, for completion: one per name, the visible one (B3.5-1). */
  metaCompletions(file: string): MetaTarget[] {
    return [...this.visibleMetaSteps(file).values()].sort((x, y) => x.def.name.localeCompare(y.def.name));
  }

  /** The meta step definition a step's `meta:` value resolves to. */
  metaTargetOf(step: StepInfo): MetaTarget | undefined {
    return step.meta === undefined ? undefined : this.visibleMetaSteps(step.file).get(step.meta);
  }

  /** The definition whose name is at `pos`. */
  metaDefinitionAt(file: string, pos: Pos): MetaTarget | undefined {
    const s = this.suites.get(fileKey(file));
    const def = s?.metaSteps.find(d => contains(d.nameRange, pos));
    return def && { file: s!.file, def };
  }

  /** Every step whose `meta:` resolves to this definition. */
  metaUses(target: MetaTarget): StepInfo[] {
    const out: StepInfo[] = [];
    for (const s of this.suiteFiles()) {
      for (const step of s.steps) {
        const t = this.metaTargetOf(step);
        if (t && t.def.name === target.def.name && fileKey(t.file) === fileKey(target.file)) out.push(step);
      }
    }
    return out;
  }
}
