// Semantic highlighting of a suite file (the BDD Suite language mode): what a
// grammar cannot know, because it needs the catalog and the code. An action is
// coloured by where it is implemented, a step's keys by whether the schema or
// the action declares them, a meta step's `with:` keys by its definition, an
// assertion's subject by what is captured, and every other value by its type.
// Pure: the caller says what each action, meta step and capture is.
import { isMap, isScalar, isSeq, Pair, Scalar, YAMLMap } from 'yaml';
import { parseYaml } from './yamlPositions';

export const TOKEN_TYPES = ['action', 'metaStep', 'parameter', 'property', 'variable', 'field', 'string', 'number', 'keyword'] as const;
export const TOKEN_MODIFIERS = ['implemented', 'notInTarget', 'unimplemented', 'undeclared', 'required', 'unknown', 'declaration'] as const;
export type TokenType = typeof TOKEN_TYPES[number];
export type TokenModifier = typeof TOKEN_MODIFIERS[number];

/** Where an action stands: declared in the catalog, and implemented where. */
export type ActionStatus = 'implemented' | 'notInTarget' | 'unimplemented' | 'undeclared';

/** One segment of an assertion's subject: a capture in scope or a field its action returns, one that is not, or past an open shape. */
export type SubjectStatus = 'known' | 'unknown' | 'open';

export interface TokenContext {
  /** An action's status and declared parameters; undefined parameters when the catalog does not have it. */
  action(name: string): { status: ActionStatus; params?: { name: string; required: boolean }[] };
  /** A meta step's parameters, or undefined when it is not declared or imported. */
  meta(name: string): { name: string; required: boolean }[] | undefined;
  /** The keys every step may carry (the schema's step envelope). */
  envelope: Set<string>;
  /** Each segment of an assertion's `var:` path at a position, [capture, ...fields]; every segment is known when absent. */
  subject?(pos: { line: number; character: number }, path: string[]): SubjectStatus[];
}

export interface SuiteToken {
  line: number;
  character: number;
  length: number;
  type: TokenType;
  modifiers: TokenModifier[];
}

/** The keys whose value is a list of steps (the schema's stepList): a case's and a meta step's, and the hooks. */
const STEP_LISTS = new Set(['steps', 'setup', 'beforeEach', 'afterEach', 'teardown', 'cleanup']);

/** Step keys syntaxes/bdd-suite.injection.tmLanguage.json colours: the Gherkin keywords, `why`, the capture keys, the structure keys. */
const GRAMMAR_KEYS = new Set(['given', 'when', 'then', 'and', 'why', 'captureAs', 'ifCapture', 'table', 'asserts']);

/** Keys whose value is prose, read as a sentence rather than a value. */
const PROSE_KEYS = new Set(['given', 'when', 'then', 'and', 'why', 'description']);

/** A path segment of an assertion's subject: a name or a list index. */
const SEGMENT = /^(?:[A-Za-z_]\w*|\d+)$/;

/** The tokens of one suite or library, in document order. */
export function suiteTokens(text: string, ctx: TokenContext): SuiteToken[] {
  const parsed = parseYaml(text);
  const out: SuiteToken[] = [];
  const covered = new Set<number>();
  /** A token over part of a scalar, `from` characters into its source text; none for a value over several lines. */
  const span = (node: Scalar, from: number, length: number | undefined, type: TokenType, modifiers: TokenModifier[]) => {
    const r = node.range!;
    const range = parsed.index.range(r[0] + from, length === undefined ? r[1] : r[0] + from + length);
    if (range.start.line !== range.end.line || range.end.character === range.start.character) return;
    covered.add(r[0]);
    out.push({ line: range.start.line, character: range.start.character, length: range.end.character - range.start.character, type, modifiers });
  };
  const add = (node: unknown, type: TokenType, modifiers: TokenModifier[]) => {
    if (isScalar(node)) span(node, 0, undefined, type, modifiers);
  };
  const keyName = (p: Pair) => (isScalar(p.key) ? String(p.key.value) : undefined);

  const step = (map: YAMLMap) => {
    const pairs = map.items as Pair[];
    const value = (key: string) => {
      const v = pairs.find(p => keyName(p) === key)?.value;
      return isScalar(v) ? String(v.value) : undefined;
    };
    const actionName = value('action');
    const metaName = value('meta');
    const action = actionName === undefined ? undefined : ctx.action(actionName);
    const meta = metaName === undefined ? undefined : ctx.meta(metaName);
    for (const p of pairs) {
      const key = keyName(p);
      if (key === 'action') add(p.value, 'action', action ? [action.status] : []);
      else if (key === 'meta') add(p.value, 'metaStep', meta ? [] : ['undeclared']);
      else if (key === 'with' && isMap(p.value)) {
        for (const w of (p.value as YAMLMap).items as Pair[]) {
          const param = meta?.find(m => m.name === keyName(w));
          add(w.key, 'parameter', !meta ? [] : param ? (param.required ? ['required'] : []) : ['unknown']);
        }
      } else if (ctx.envelope.has(key as string)) {
        // The grammar colours these keys itself; a property token would paint over it.
        if (!GRAMMAR_KEYS.has(key as string)) add(p.key, 'property', []);
        if (key === 'captureAs') add(p.value, 'variable', ['declaration']);
      } else if (action?.params) {
        const param = action.params.find(x => x.name === key);
        add(p.key, 'parameter', param ? (param.required ? ['required'] : []) : ['unknown']);
      } else if (action) {
        add(p.key, 'parameter', []);
      }
    }
  };

  /** `var: capture.field.0.name`: the capture and each field, marked unknown where the context says so. */
  const subject = (node: Scalar) => {
    const source = text.slice(node.range![0], node.range![1]);
    const quote = /^["']/.test(source) ? 1 : 0;
    const path = String(node.value).split('.');
    if (typeof node.value !== 'string' || !path.every(s => SEGMENT.test(s))) return;
    const start = parsed.index.range(node.range![0] + quote, node.range![0] + quote).start;
    const status = ctx.subject?.(start, path) ?? path.map(() => 'known' as const);
    let at = quote;
    path.forEach((seg, i) => {
      span(node, at, seg.length, i === 0 ? 'variable' : 'field', status[i] === 'unknown' ? ['unknown'] : []);
      at += seg.length + 1;
    });
  };

  // A list under `steps:` (cases and meta step definitions) or a hook key is a list of steps; one under `asserts:` is assertions.
  const walk = (node: unknown) => {
    if (isMap(node)) {
      for (const p of (node as YAMLMap).items as Pair[]) {
        if (STEP_LISTS.has(keyName(p) as string) && isSeq(p.value)) {
          for (const item of p.value.items) if (isMap(item)) step(item as YAMLMap);
        }
        if (keyName(p) === 'asserts' && isSeq(p.value)) {
          for (const item of p.value.items) {
            const v = isMap(item) ? (item.items as Pair[]).find(a => keyName(a) === 'var')?.value : undefined;
            if (isScalar(v)) subject(v);
          }
        }
        walk(p.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) walk(item);
    }
  };
  walk(parsed.doc.contents);

  /** A value nothing above coloured, by its type; an expression is the grammar's, prose stays prose. */
  const typed = (node: unknown) => {
    if (!isScalar(node) || covered.has(node.range![0])) return;
    const v = node.value;
    if (typeof v === 'string' && v.includes('${')) return;
    add(node, typeof v === 'number' ? 'number' : typeof v === 'boolean' || v === null ? 'keyword' : 'string', []);
  };
  const values = (node: unknown) => {
    if (isMap(node)) {
      for (const p of (node as YAMLMap).items as Pair[]) {
        if (!PROSE_KEYS.has(keyName(p) as string)) typed(p.value);
        values(p.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) {
        typed(item);
        values(item);
      }
    }
  };
  values(parsed.doc.contents);
  return out.sort((a, b) => a.line - b.line || a.character - b.character);
}
