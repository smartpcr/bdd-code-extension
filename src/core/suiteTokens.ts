// Semantic highlighting of a suite file (the BDD Suite language mode): what a
// grammar cannot know, because it needs the catalog and the code. An action is
// coloured by where it is implemented, a step's keys by whether the schema or
// the action declares them, and a meta step's `with:` keys by its definition.
// Pure: the caller says what each action and meta step is.
import { isMap, isScalar, isSeq, Pair, YAMLMap } from 'yaml';
import { parseYaml } from './yamlPositions';

export const TOKEN_TYPES = ['action', 'metaStep', 'parameter', 'property', 'variable'] as const;
export const TOKEN_MODIFIERS = ['implemented', 'notInTarget', 'unimplemented', 'undeclared', 'required', 'unknown', 'declaration'] as const;
export type TokenType = typeof TOKEN_TYPES[number];
export type TokenModifier = typeof TOKEN_MODIFIERS[number];

/** Where an action stands: declared in the catalog, and implemented where. */
export type ActionStatus = 'implemented' | 'notInTarget' | 'unimplemented' | 'undeclared';

export interface TokenContext {
  /** An action's status and declared parameters; undefined parameters when the catalog does not have it. */
  action(name: string): { status: ActionStatus; params?: { name: string; required: boolean }[] };
  /** A meta step's parameters, or undefined when it is not declared or imported. */
  meta(name: string): { name: string; required: boolean }[] | undefined;
  /** The keys every step may carry (the schema's step envelope). */
  envelope: Set<string>;
}

export interface SuiteToken {
  line: number;
  character: number;
  length: number;
  type: TokenType;
  modifiers: TokenModifier[];
}

/** The tokens of one suite or library, in document order. */
export function suiteTokens(text: string, ctx: TokenContext): SuiteToken[] {
  const parsed = parseYaml(text);
  const out: SuiteToken[] = [];
  const add = (node: unknown, type: TokenType, modifiers: TokenModifier[]) => {
    if (!isScalar(node)) return;
    const r = node.range!;
    const range = parsed.index.range(r[0], r[1]);
    if (range.start.line !== range.end.line || range.end.character === range.start.character) return;
    out.push({ line: range.start.line, character: range.start.character, length: range.end.character - range.start.character, type, modifiers });
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
        add(p.key, 'property', []);
        if (key === 'captureAs') add(p.value, 'variable', ['declaration']);
      } else if (action?.params) {
        const param = action.params.find(x => x.name === key);
        add(p.key, 'parameter', param ? (param.required ? ['required'] : []) : ['unknown']);
      } else if (action) {
        add(p.key, 'parameter', []);
      }
    }
  };

  // Every list under a `steps:` key is a list of steps: in cases, hooks and meta step definitions.
  const walk = (node: unknown) => {
    if (isMap(node)) {
      for (const p of (node as YAMLMap).items as Pair[]) {
        if (keyName(p) === 'steps' && isSeq(p.value)) {
          for (const item of p.value.items) if (isMap(item)) step(item as YAMLMap);
        }
        walk(p.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) walk(item);
    }
  };
  walk(parsed.doc.contents);
  return out.sort((a, b) => a.line - b.line || a.character - b.character);
}
