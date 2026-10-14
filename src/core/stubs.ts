// Stub registrations and handlers (plan B5.1-B5.4): which registry an action
// goes into, the anchors found by exact text, and the template text. Pure: the
// caller reads the registry file and applies the edits. An anchor that is not
// found refuses; the command never guesses (DEC-B10).
import { EditPlan, eolOf, FileEdit } from './catalogEdit';

const words = (action: string) => action.split('.').flatMap(s => s.split(/(?=[A-Z])/)).filter(Boolean);
const cap = (w: string) => w[0].toUpperCase() + w.slice(1);

/** `demo.echo` -> `DemoEcho`: C# methods and PowerShell file names. */
export function pascalName(action: string): string {
  return words(action).map(cap).join('');
}

/** `demo.echo` -> `demoEcho`: Go and TypeScript functions. */
export function camelName(action: string): string {
  const p = pascalName(action);
  return p[0].toLowerCase() + p.slice(1);
}

/** `demo.echo` -> `demo_echo`: Rust functions. */
export function snakeName(action: string): string {
  return words(action).map(w => w.toLowerCase()).join('_');
}

export function renderTemplate(template: string, action: string): string {
  const vars: Record<string, string> = {
    action, goName: camelName(action), tsName: camelName(action), rustName: snakeName(action), pascalName: pascalName(action),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (all, key: string) => vars[key] ?? all);
}

/** A template's `@@ <name>` sections, each without its trailing line breaks. */
export function templateSections(template: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (name !== undefined) out.set(name, body.join('\n').replace(/\n+$/, ''));
  };
  for (const line of template.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^@@ (\w+)\s*$/.exec(line);
    if (m) {
      flush();
      name = m[1];
      body = [];
    } else body.push(line);
  }
  flush();
  return out;
}

interface Insertion {
  offset: number;
  text: string;
}

export interface StubTarget {
  /** The registry file, relative to the repository root. */
  file: string;
  /** The template's file name in `templates/` (or `bddSuite.templatesDir`). */
  template: string;
  /** The `@@` sections the template must have. */
  sections: string[];
  /** The stub's identifier, and the declaration it must not collide with. */
  identifier: (action: string) => string;
  declares: (identifier: string) => RegExp;
  /** Insertions into the registry, or why an anchor was not found. */
  plan(text: string, sections: Map<string, string>, action: string): Insertion[] | string;
}

/** A file's lines (without line breaks) and each line's start offset. */
class Lines {
  readonly lines: string[];
  readonly starts: number[] = [];
  readonly eol: string;
  constructor(readonly text: string) {
    this.eol = eolOf(text);
    const raw = text.split('\n');
    this.lines = raw.map(l => l.replace(/\r$/, ''));
    for (let i = 0, at = 0; i < raw.length; at += raw[i].length + 1, i++) this.starts.push(at);
  }
  find(re: RegExp, from = 0, to = this.lines.length): number {
    for (let i = from; i < to; i++) if (re.test(this.lines[i])) return i;
    return -1;
  }
  indent(i: number): string {
    return /^\s*/.exec(this.lines[i])![0];
  }
  /** Whole lines inserted before line `i`. */
  before(i: number, body: string[]): Insertion {
    return { offset: this.starts[i], text: body.map(l => l + this.eol).join('') };
  }
  /** Whole lines after a blank line at the end of the file. */
  append(body: string[]): Insertion {
    const end = this.text.endsWith('\n') ? '' : this.eol;
    return { offset: this.text.length, text: end + ['', ...body].map(l => l + this.eol).join('') };
  }
  /** The first line after `open` that is exactly `close` once its indentation is removed. */
  closing(open: number, close: string): number {
    for (let i = open + 1; i < this.lines.length; i++) if (this.lines[i].trim() === close) return i;
    return -1;
  }
}

const indentAll = (text: string, indent: string) => text.split('\n').map(l => (l ? indent + l : l));

/**
 * A handler as its own paragraph before line `i`, or at the end of the file
 * when `i` is undefined. Before a closing brace no blank line follows it.
 */
function handlerBefore(f: Lines, i: number | undefined, handler: string, indent = ''): Insertion {
  const body = indentAll(handler, indent);
  if (i === undefined) return f.append(body);
  const blankAbove = f.lines[i - 1]?.trim() ? [''] : [];
  return f.before(i, [...blankAbove, ...body, ...(f.lines[i].trim() === '}' ? [] : [''])]);
}

/** `"name": value` with the value at the column of the line above, as gofmt aligns it, when it fits. */
export function alignEntry(entry: string, above: string): string {
  const m = /^("[^"]*":)\s+(.*)$/.exec(entry);
  const col = /^\s*("[^"]*":)(\s+)/.exec(above);
  if (!m || !col) return entry;
  const width = col[1].length + col[2].length;
  return m[1] + ' '.repeat(Math.max(1, width - m[1].length)) + m[2];
}

/** One registration line before line `close`, indented as the entry above it. */
function entryBefore(f: Lines, open: number, close: string, entry: string): Insertion | string {
  const end = f.closing(open, close);
  if (end < 0) return `the closing \`${close}\` was not found`;
  if (/[{[(]\s*$/.test(f.lines[end - 1])) {
    const indent = f.indent(end) + (f.indent(end).includes('\t') ? '\t' : '    ');
    return f.before(end, [indent + entry]);
  }
  return f.before(end, [f.indent(end - 1) + alignEntry(entry, f.lines[end - 1])]);
}

function both(...parts: (Insertion | string)[]): Insertion[] | string {
  const failed = parts.find(p => typeof p === 'string');
  return failed !== undefined ? failed as string : parts as Insertion[];
}

function goPlan(anchor: RegExp, what: string) {
  return (text: string, s: Map<string, string>): Insertion[] | string => {
    const f = new Lines(text);
    const open = f.find(anchor);
    if (open < 0) return `${what} was not found`;
    return both(entryBefore(f, open, '}', s.get('registration')!), handlerBefore(f, undefined, s.get('handler')!));
  };
}

function rustCfgTest(f: Lines): number | undefined {
  const i = f.find(/^#\[cfg\(test\)\]/);
  return i < 0 ? undefined : i;
}

function rustCorePlan(text: string, s: Map<string, string>): Insertion[] | string {
  const f = new Lines(text);
  const open = f.find(/^(pub )?fn registry\(/);
  if (open < 0) return '`fn registry(` was not found';
  const end = f.find(/^}/, open + 1);
  let last = -1;
  for (let i = open + 1; i < end; i++) if (/^\s*map\.insert\(/.test(f.lines[i])) last = i;
  if (last < 0) return 'no `map.insert(` line was found in `registry()`';
  return [f.before(last + 1, [f.indent(last) + s.get('registration')!]), handlerBefore(f, rustCfgTest(f), s.get('handler')!)];
}

function rustLifecyclePlan(text: string, s: Map<string, string>, action: string): Insertion[] | string {
  const f = new Lines(text);
  const names = f.find(/^(pub )?fn names\(/);
  const vec = names < 0 ? -1 : f.find(/vec!\[\s*$/, names);
  const vecEnd = vec < 0 ? -1 : f.closing(vec, ']');
  if (vecEnd < 0) return 'the `vec![` list in `names()` was not found';
  let at = vecEnd;
  for (let i = vec + 1; i < vecEnd; i++) {
    const m = /^\s*"([^"]+)"/.exec(f.lines[i]);
    if (m && m[1] > action) {
      at = i;
      break;
    }
  }
  const nameIndent = vec + 1 < vecEnd ? f.indent(vec + 1) : f.indent(vec) + '    ';
  const dispatch = f.find(/^(pub )?fn dispatch\(/);
  const match = dispatch < 0 ? -1 : f.find(/^\s*match name \{\s*$/, dispatch);
  const matchEnd = match < 0 ? -1 : f.closing(match, '}');
  if (matchEnd < 0) return 'the `match name {` in `dispatch()` was not found';
  const catchAll = f.find(/^\s*(_|[a-z_][a-z0-9_]*)\s*=>/, match + 1, matchEnd);
  const armAt = catchAll < 0 ? matchEnd : catchAll;
  const armIndent = catchAll < 0 ? f.indent(match) + '    ' : f.indent(catchAll);
  return [
    f.before(at, [nameIndent + s.get('name')!]),
    f.before(armAt, [armIndent + s.get('registration')!]),
    handlerBefore(f, rustCfgTest(f), s.get('handler')!),
  ];
}

function csharpPlan(registry: RegExp, cls: RegExp, what: string) {
  return (text: string, s: Map<string, string>): Insertion[] | string => {
    const f = new Lines(text);
    const open = f.find(registry);
    if (open < 0) return `${what} was not found`;
    const clsLine = f.find(cls);
    const clsEnd = clsLine < 0 ? -1 : f.find(/^}\s*$/, clsLine + 1);
    if (clsEnd < 0) return 'the class\'s closing brace was not found';
    return both(entryBefore(f, open, '};', s.get('registration')!), handlerBefore(f, clsEnd, s.get('handler')!, f.indent(open)));
  };
}

const RH = ['registration', 'handler'];
const GO = 'test/e2e/bindings/go/internal/';
const RUST = 'test/e2e/bindings/rust/src/';
const CSHARP = 'test/e2e/bindings/dotnet/Hci.E2E.Suite/Actions/';
const goDeclares = (id: string) => new RegExp(`^func ${id}\\(`, 'm');
const rustDeclares = (id: string) => new RegExp(`^\\s*(pub )?fn ${id}\\(`, 'm');
const csharpDeclares = (id: string) => new RegExp(`\\b${id}\\(ActionRequest `);

/** The registry an action goes into for a binding (the anchor table); undefined when there is no template. */
export function stubTarget(binding: string, action: string): StubTarget | undefined {
  const life = action.startsWith('lifecycle.');
  switch (binding) {
    case 'go':
      return {
        file: `${GO}${life ? 'lifecycle' : 'actions'}/actions.go`, template: `go.${life ? 'lifecycle' : 'core'}.tmpl`, sections: RH,
        identifier: camelName, declares: goDeclares,
        plan: life
          ? goPlan(/^var handlers = map\[string\]handler\{\s*$/, '`var handlers = map[string]handler{`')
          : goPlan(/^\s*return map\[string\]Handler\{\s*$/, '`return map[string]Handler{`'),
      };
    case 'rust':
      return life
        ? { file: `${RUST}lifecycle/actions.rs`, template: 'rust.lifecycle.tmpl', sections: ['name', ...RH], identifier: snakeName, declares: rustDeclares, plan: rustLifecyclePlan }
        : { file: `${RUST}actions.rs`, template: 'rust.core.tmpl', sections: RH, identifier: snakeName, declares: rustDeclares, plan: rustCorePlan };
    case 'csharp':
      return {
        file: `${CSHARP}${life ? 'Lifecycle/LifecycleActions.cs' : 'CoreActions.cs'}`, template: `csharp.${life ? 'lifecycle' : 'core'}.tmpl`, sections: RH,
        identifier: pascalName, declares: csharpDeclares,
        plan: life
          ? csharpPlan(/private static readonly Dictionary<string, Handler> Handlers\b/, /\bpartial class LifecycleContext\b/, '`Handlers`')
          : csharpPlan(/\bRegistry \{ get; \} =\s*$/, /\bstatic class CoreActions\b/, '`Registry { get; } =`'),
      };
    default:
      return undefined;
  }
}

/** The PowerShell stub file for an action (B5.1), relative to the repository root. */
export const powershellStubFile = (action: string) => `scripts/e2e/actions/${pascalName(action)}.ps1`;

export interface ImplementInput {
  binding: string;
  action: string;
  /** The registry file's absolute path and current text. */
  file: string;
  text: string;
  template: string;
  /** True when the index already holds a site of this action for this binding (B5.2 item 3). */
  hasSite: boolean;
}

/** The registry edits of *Implement in binding* (B5.2-B5.4); the catalog edit is addBindingEdit(). */
export function planStub(input: ImplementInput): EditPlan {
  const target = stubTarget(input.binding, input.action);
  if (!target) return { refused: `There is no stub template for the ${input.binding} binding.` };
  if (input.hasSite) return { refused: `${input.action} is already registered in the ${input.binding} binding.` };
  const id = target.identifier(input.action);
  if (target.declares(id).test(input.text)) return { refused: `${target.file} already declares \`${id}\`.` };
  const sections = templateSections(renderTemplate(input.template, input.action));
  const missing = target.sections.filter(k => !sections.has(k));
  if (missing.length) return { refused: `The template ${target.template} has no \`@@ ${missing.join('`, `@@ ')}\` section.` };
  const planned = target.plan(input.text, sections, input.action);
  if (typeof planned === 'string') return { refused: `In ${target.file}, ${planned}; the template needs updating for this layout.` };
  const edits: FileEdit[] = planned.map(i => ({ file: input.file, start: i.offset, end: i.offset, text: i.text }));
  return { edits };
}
