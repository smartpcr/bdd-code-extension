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
  /** The insertion goes into the handler class's file (a C# dictionary registry's `UrpActions.`), not the registry. */
  inHandlerFile?: boolean;
}

/** What a registry plan knows besides the registry's text: the action, its stub's identifier, and the handler class's file. */
interface PlanContext {
  action: string;
  identifier: string;
  handlerText?: string;
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
  plan(text: string, sections: Map<string, string>, context: PlanContext): Insertion[] | string;
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
  /** One level of the file's indentation, as its first indented line has it (gofmt's tab, two or four spaces); four spaces when none is. */
  unit(): string {
    return /^(\t|[ ]+)(?=[^\s]|\t)/m.exec(this.text)?.[1] ?? '    ';
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
    const indent = f.indent(end) + f.unit();
    return f.before(end, [indent + entry]);
  }
  return f.before(end, [f.indent(end - 1) + alignEntry(entry, f.lines[end - 1])]);
}

function both(...parts: (Insertion | string)[]): Insertion[] | string {
  const failed = parts.find(p => typeof p === 'string');
  return failed !== undefined ? failed as string : parts as Insertion[];
}

/** The registration before the list's closing line, and the handler before line `at` (the end of the file when undefined). */
function entryAndHandler(f: Lines, open: number, close: string, s: Map<string, string>, at?: number, indent?: string): Insertion[] | string {
  return both(entryBefore(f, open, close, s.get('registration')!), handlerBefore(f, at, s.get('handler')!, indent));
}

/** Go: `{Name: "x", Handler: x},` in `var Registrations = []actions.Registration{`; the handler at the end of the file. */
function goPlan(text: string, s: Map<string, string>): Insertion[] | string {
  const f = new Lines(text);
  const open = f.find(/^var Registrations = \[\]actions\.Registration\{\s*$/);
  if (open < 0) return '`var Registrations = []actions.Registration{` was not found';
  return entryAndHandler(f, open, '}', s);
}

/** Rust: `Action::new("x", x),` in the `vec![` of `fn actions() -> Vec<Action>`; the handler above `#[cfg(test)]`. */
function rustPlan(text: string, s: Map<string, string>): Insertion[] | string {
  const f = new Lines(text);
  const open = f.find(/^(pub )?fn actions\(\)/);
  const end = open < 0 ? -1 : f.find(/^}/, open + 1);
  const list = end < 0 ? -1 : f.find(/vec!\[\s*$/, open, end);
  if (list < 0) return 'the `vec![` list in `fn actions()` was not found';
  const tests = f.find(/^#\[cfg\(test\)\]/);
  return entryAndHandler(f, list, ']', s, tests < 0 ? undefined : tests);
}

/** One entry of a C# dictionary registry, `["a.b"] = Handler,` or `["a.b"] = Class.Handler,`, as a line of its own. */
const CSHARP_ENTRY = /^\s*\["[^"]+"\]\s*=\s*(?:([A-Za-z_]\w*)\.)?[A-Za-z_]\w*\s*,\s*$/;

/**
 * The class a C# dictionary registry's handlers are qualified with: `UrpActions`
 * for `["a.b"] = UrpActions.AB,`, read from its last entry. Undefined when the
 * entries are unqualified or the file has none.
 */
export function csharpHandlerClass(text: string): string | undefined {
  const entries = new Lines(text).lines.filter(l => CSHARP_ENTRY.test(l));
  return entries.length ? CSHARP_ENTRY.exec(entries[entries.length - 1])![1] : undefined;
}

/**
 * C#: `new ActionRegistration("x", X),` in `All { get; } = [ ... ];`, or a
 * dictionary entry `["x"] = X,` after the registry's last one, qualified as that
 * entry is. The method goes before the closing brace of the class that holds the
 * handlers: the registry's own, or the qualifying class in its own file.
 */
function csharpPlan(text: string, s: Map<string, string>, context: PlanContext): Insertion[] | string {
  const f = new Lines(text);
  const open = f.find(/\bAll \{ get; \} =/);
  if (open >= 0) {
    const classEnd = f.find(/^}\s*$/, open + 1);
    if (classEnd < 0) return 'the class\'s closing brace was not found';
    return entryAndHandler(f, open, '];', s, classEnd, f.indent(open));
  }
  const last = f.lines.map(l => CSHARP_ENTRY.test(l)).lastIndexOf(true);
  if (last < 0) return '`All { get; } =` or a dictionary entry `["name"] = Handler,` was not found';
  const owner = CSHARP_ENTRY.exec(f.lines[last])![1];
  const entry = entryBefore(f, last, '};', `["${context.action}"] = ${owner ? `${owner}.` : ''}${context.identifier},`);
  if (!owner) {
    const classEnd = f.find(/^}\s*$/, last + 1);
    if (classEnd < 0) return 'the class\'s closing brace was not found';
    return both(entry, handlerBefore(f, classEnd, s.get('handler')!, f.unit()));
  }
  if (context.handlerText === undefined) return `the file of class ${owner}, which holds the handlers, was not found`;
  const g = new Lines(context.handlerText);
  const classLine = g.find(new RegExp(`\\bclass ${owner}\\b`));
  const classEnd = classLine < 0 ? -1 : g.find(/^}\s*$/, classLine + 1);
  if (classEnd < 0) return `the closing brace of class ${owner} was not found`;
  // The registry calls it from another class, so a private stub would not compile.
  const handler = s.get('handler')!.replace(/^private\b/m, 'internal');
  return both(entry, { ...handlerBefore(g, classEnd, handler, g.unit()), inHandlerFile: true });
}

/** TypeScript: `action('x', x),` in `export const registrations = [ ... ];`; the handler at the end of the file. */
function typescriptPlan(text: string, s: Map<string, string>): Insertion[] | string {
  const f = new Lines(text);
  const open = f.find(/^export const registrations\b[^=]*=\s*\[\s*$/);
  if (open < 0) return '`export const registrations = [` was not found';
  return entryAndHandler(f, open, '];', s);
}

const RH = ['registration', 'handler'];

// DEC-S11: where a workspace's actions are, per language, and the registration
// idiom of that language's extension API. PowerShell has no registry file: its
// stub is a file of its own (powershellStubFile), written by Declare action.
const TARGETS = new Map<string, StubTarget>([
  ['go', {
    file: 'test/e2e/bindings/go/actions/actions.go', template: 'go.tmpl', sections: RH,
    identifier: camelName, declares: id => new RegExp(`^func ${id}\\(`, 'm'), plan: goPlan,
  }],
  ['rust', {
    file: 'test/e2e/bindings/rust/src/actions.rs', template: 'rust.tmpl', sections: RH,
    identifier: snakeName, declares: id => new RegExp(`^\\s*(pub )?fn ${id}\\(`, 'm'), plan: rustPlan,
  }],
  ['csharp', {
    file: 'test/e2e/bindings/dotnet/Suite.Cli/Actions.cs', template: 'csharp.tmpl', sections: RH,
    identifier: pascalName, declares: id => new RegExp(`\\b${id}\\(ActionRequest `), plan: csharpPlan,
  }],
  ['typescript', {
    file: 'test/e2e/bindings/typescript/src/actions.ts', template: 'typescript.tmpl', sections: RH,
    identifier: camelName, declares: id => new RegExp(`^\\s*(export )?(async )?function ${id}\\(`, 'm'), plan: typescriptPlan,
  }],
]);

/** The registry an action goes into for a binding (the anchor table); undefined when there is no template. */
export function stubTarget(binding: string): StubTarget | undefined {
  return TARGETS.get(binding);
}

/** The PowerShell stub file for an action (B5.1), relative to the repository root. */
export const powershellStubFile = (action: string) => `scripts/e2e/actions/${pascalName(action)}.ps1`;

export interface ImplementInput {
  binding: string;
  action: string;
  /** The registry file's absolute path and current text. */
  file: string;
  text: string;
  /** The registry file as messages name it; the target's default file when absent. */
  shown?: string;
  /** The file of the class a C# dictionary registry qualifies its handlers with (csharpHandlerClass), and its text. */
  handlerFile?: { file: string; text: string };
  template: string;
  /** True when the index already holds a site of this action for this binding (B5.2 item 3). */
  hasSite: boolean;
}

/**
 * The file that holds most of a binding's own registrations: sites of actions the
 * workspace's catalog declares, not imported ones such as the core's. Ties go to
 * the first file by name. Undefined when the binding registers none of them yet.
 */
export function registryFileOf(sites: { binding: string; action: string; file: string }[], binding: string, own: (action: string) => boolean): string | undefined {
  const counts = new Map<string, number>();
  for (const s of sites) if (s.binding === binding && own(s.action)) counts.set(s.file, (counts.get(s.file) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

/** The registry edits of *Implement in binding* (B5.2-B5.4); the catalog edit is addBindingEdit(). */
export function planStub(input: ImplementInput): EditPlan {
  const target = stubTarget(input.binding);
  if (!target) return { refused: `There is no stub template for the ${input.binding} binding.` };
  if (input.hasSite) return { refused: `${input.action} is already registered in the ${input.binding} binding.` };
  const id = target.identifier(input.action);
  const shown = input.shown ?? target.file;
  if (target.declares(id).test(input.text)) return { refused: `${shown} already declares \`${id}\`.` };
  const other = input.handlerFile;
  if (other && target.declares(id).test(other.text)) return { refused: `${other.file} already declares \`${id}\`.` };
  const sections = templateSections(renderTemplate(input.template, input.action));
  const missing = target.sections.filter(k => !sections.has(k));
  if (missing.length) return { refused: `The template ${target.template} has no \`@@ ${missing.join('`, `@@ ')}\` section.` };
  const planned = target.plan(input.text, sections, { action: input.action, identifier: id, handlerText: other?.text });
  if (typeof planned === 'string') return { refused: `In ${shown}, ${planned}; the template needs updating for this layout.` };
  const edits: FileEdit[] = planned.map(i => ({ file: i.inHandlerFile ? other!.file : input.file, start: i.offset, end: i.offset, text: i.text }));
  return { edits };
}
