// Declaring an action (plan B5.1): the catalog entry, where it goes, and the
// catalog half of implementing one (its `bindings:` list). Pure: the caller
// reads the files and applies the edits as one WorkspaceEdit.
import { CatalogAction, Pos } from './types';

/** A replacement in one file by offsets; `create` makes a new file holding `text`. */
export interface FileEdit {
  file: string;
  start: number;
  end: number;
  text: string;
  create?: boolean;
}

export type EditPlan = { edits: FileEdit[] } | { refused: string };

/** Dotted segments, each a letter then letters or digits: the names the catalog holds. */
export const ACTION_NAME = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/;

export function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function offsetOf(text: string, pos: Pos): number {
  let offset = 0;
  for (let line = 0; line < pos.line; line++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return Math.min(offset + pos.character, text.length);
}

/** The catalog type a step's YAML value suggests; `todo` when the value cannot say. */
export function inferType(value: unknown): { type: string; todo: boolean } {
  if (typeof value === 'string') return { type: 'string', todo: value.includes('${') };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number', todo: false };
  if (typeof value === 'boolean') return { type: 'boolean', todo: false };
  if (Array.isArray(value)) return { type: 'array', todo: false };
  if (value !== null && typeof value === 'object') return { type: 'object', todo: false };
  return { type: 'any', todo: true };
}

/** The keys every step may carry, from the generated `suite.schema.json` or `suite.base.json` (B5.1-4); undefined when the file does not say. */
export function commonStepKeys(baseSchemaText: string): string[] | undefined {
  try {
    const props = JSON.parse(baseSchemaText)?.$defs?.stepEnvelope?.properties;
    return props && typeof props === 'object' ? Object.keys(props) : undefined;
  } catch {
    return undefined;
  }
}

const plainKey = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function renderCatalogEntry(name: string, params: { name: string; value: unknown }[], eol = '\n', bindings: string[] = []): string {
  const lines = [
    `  - name: ${name}`,
    `    summary: TODO describe ${name}.`,
    `    bindings: [${bindings.join(', ')}]`,
    '    interruptible: true',
  ];
  if (params.length) {
    lines.push('    params:');
    for (const p of params) lines.push(`      ${paramItem(p.name, p.value)}`);
  }
  lines.push('    captures: { type: object, additionalProperties: true }');
  return lines.map(l => l + eol).join('');
}

const familyOf = (name: string) => name.split('.')[0];

/**
 * Where a new entry goes (the anchor table): after the last entry of the same
 * family, else after the last entry, else right under `actions:`. `prefix` is
 * the text that goes before the entry: the blank line between entries, and a
 * line break when the file does not end with one.
 */
export function findCatalogInsertOffset(text: string, name: string): { offset: number; prefix: string } | { refused: string } {
  const eol = eolOf(text);
  const lines = text.split('\n');
  const actionsLine = lines.findIndex(l => /^actions:\s*(#.*)?\r?$/.test(l));
  if (actionsLine < 0) return { refused: 'The catalog has no top-level `actions:` key.' };
  const entries: { name: string; last: number }[] = [];
  for (let i = actionsLine + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (/^[^\s#]/.test(line)) break;
    const m = /^ {2}- name:\s*(\S+)/.exec(line);
    if (m) entries.push({ name: m[1], last: i });
    else if (entries.length && line.trim() && !line.trim().startsWith('#')) entries[entries.length - 1].last = i;
  }
  const lineEnd = (i: number) => lines.slice(0, i + 1).reduce((n, l) => n + l.length + 1, 0);
  const noFinalBreak = (i: number) => (i === lines.length - 1 ? eol : '');
  if (!entries.length) return { offset: Math.min(lineEnd(actionsLine), text.length), prefix: noFinalBreak(actionsLine) };
  const same = entries.filter(e => familyOf(e.name) === familyOf(name));
  const pool = same.length ? same : entries;
  const after = pool[pool.length - 1];
  return { offset: Math.min(lineEnd(after.last), text.length), prefix: noFinalBreak(after.last) + eol };
}

export interface DeclareInput {
  catalogFile: string;
  catalogText: string;
  declared: (name: string) => boolean;
  name: string;
  /** The step's keys and values, before the common keys are removed. */
  stepParams: { name: string; value: unknown }[];
  /** From commonStepKeys(); undefined refuses (B5.1-4 cannot be kept). */
  commonKeys: string[] | undefined;
  /**
   * The binding the action gets its stub in (the workspace's target binding),
   * listed in the entry's `bindings:`; undefined lists none, for a target with no
   * stub template, and `stub` is then empty.
   */
  binding?: string;
  /** That binding's stub: a new PowerShell file, or a registry entry and its handler (planStub). */
  stub: FileEdit[];
}

/** The edits of *Declare action*: the catalog entry and the stub in the target binding (B5.1). */
export function planDeclare(input: DeclareInput): EditPlan {
  const { name } = input;
  if (!ACTION_NAME.test(name)) return { refused: `\`${name}\` is not an action name the catalog can hold.` };
  if (input.declared(name)) return { refused: `${name} is already in the catalog.` };
  if (!input.commonKeys) return { refused: 'suite.schema.json (or suite.base.json) does not list `$defs.stepEnvelope.properties`, so the common step keys are unknown.' };
  const at = findCatalogInsertOffset(input.catalogText, name);
  if ('refused' in at) return at;
  const common = new Set(input.commonKeys);
  const params = input.stepParams.filter(p => !common.has(p.name));
  const entry = renderCatalogEntry(name, params, eolOf(input.catalogText), input.binding ? [input.binding] : []);
  return { edits: [{ file: input.catalogFile, start: at.offset, end: at.offset, text: at.prefix + entry }, ...input.stub] };
}

/** A parameter item as *Declare action* writes one: the type the step's value suggests, with a TODO when it cannot say. */
function paramItem(name: string, value: unknown): string {
  const { type, todo } = inferType(value);
  const key = plainKey.test(name) ? name : JSON.stringify(name);
  return `- { name: ${key}, type: ${type} }${todo ? '  # TODO type' : ''}`;
}

/**
 * The catalog edit of *Add parameter* (the quick fix on E105, a step key its
 * action does not take): one item for it at the end of the entry's `params:`
 * list, at the indentation of the items there. An entry with no `params:` gets
 * one before its `captures:` (or at its end); `params: []` becomes a list. A
 * flow list (`params: [ ... ]` with items) is refused: rewriting it would lose
 * its layout.
 */
export function addParamEdit(file: string, text: string, action: CatalogAction, param: { name: string; value: unknown }): FileEdit | { refused: string } {
  if (action.file) return { refused: `${action.name} is declared in ${action.file}, not in this catalog.` };
  if (action.params.some(p => p.name === param.name)) return { refused: `${action.name} already takes ${param.name}.` };
  const eol = eolOf(text);
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const lineStart = (i: number) => offsetOf(text, { line: i, character: 0 });
  const lineEnd = (i: number) => lineStart(i) + lines[i].length;
  const first = action.entryRange.start.line;
  // The entry's keys sit where its first key does: `  - name:` puts them at column 4.
  const keyIndent = /^\s*-\s+/.exec(lines[first])![0].length;
  const indentOf = (l: string) => /^ */.exec(l)![0].length;
  const blank = (l: string) => !l.trim() || l.trim().startsWith('#');
  // The entry's range ends after its last value: at the start of the next line, or at the end of the file.
  let last = Math.min(action.entryRange.end.line, lines.length - 1);
  if (action.entryRange.end.character === 0 && last > first) last--;
  const item = (indent: number) => ' '.repeat(indent) + paramItem(param.name, param.value);
  const key = (name: string) => new RegExp(`^ {${keyIndent}}${name}:\\s*(.*?)\\s*(#.*)?$`);
  const at = lines.slice(first, last + 1).findIndex(l => key('params').test(l));
  if (at < 0) {
    const captures = lines.slice(first + 1, last + 1).findIndex(l => key('captures').test(l));
    const block = `${' '.repeat(keyIndent)}params:${eol}${item(keyIndent + 2)}${eol}`;
    if (captures >= 0) {
      const offset = lineStart(first + 1 + captures);
      return { file, start: offset, end: offset, text: block };
    }
    return { file, start: lineEnd(last), end: lineEnd(last), text: eol + block.slice(0, -eol.length) };
  }
  const paramsLine = first + at;
  const rest = key('params').exec(lines[paramsLine])![1];
  if (rest === '[]') {
    return { file, start: lineStart(paramsLine), end: lineEnd(paramsLine), text: `${' '.repeat(keyIndent)}params:${eol}${item(keyIndent + 2)}` };
  }
  if (rest) return { refused: `${action.name}'s params are a flow list; add ${param.name} to it by hand.` };
  // The list's lines: deeper than the key, or a `- ` at its own column, as YAML allows.
  let end = paramsLine;
  let itemIndent: number | undefined;
  for (let i = paramsLine + 1; i <= last; i++) {
    const l = lines[i];
    if (blank(l)) continue;
    const indent = indentOf(l);
    if (indent < keyIndent || (indent === keyIndent && !l.trimStart().startsWith('- '))) break;
    if (itemIndent === undefined && l.trimStart().startsWith('- ')) itemIndent = indent;
    end = i;
  }
  return { file, start: lineEnd(end), end: lineEnd(end), text: eol + item(itemIndent ?? keyIndent + 2) };
}

/**
 * The catalog edit of *Implement in binding*: the entry's `bindings:` with the
 * binding added, in the catalog's top-level order. Undefined when it is listed.
 */
export function addBindingEdit(file: string, text: string, action: CatalogAction, binding: string, order: string[]): FileEdit | { refused: string } | undefined {
  if (action.bindings.includes(binding)) return undefined;
  if (!action.bindingsRange) return { refused: `${action.name} has no \`bindings:\` list to add ${binding} to.` };
  const rank = (b: string) => (order.includes(b) ? order.indexOf(b) : order.length);
  const list = [...action.bindings, binding].map((b, i) => ({ b, i }))
    .sort((x, y) => rank(x.b) - rank(y.b) || x.i - y.i).map(x => x.b);
  return { file, start: offsetOf(text, action.bindingsRange.start), end: offsetOf(text, action.bindingsRange.end), text: `[${list.join(', ')}]` };
}
