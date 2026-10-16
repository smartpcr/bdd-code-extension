// What is being typed inside ${ } at a cursor (plan B3.2). Only for
// completion: it never evaluates and never judges validity (DEC-B08).

/** The closed function list of yml_suite_design.md 5.9, with a signature for documentation. */
export const FUNCTIONS: Record<string, string> = {
  lower: 'lower(text)', upper: 'upper(text)', trim: 'trim(text)', replace: 'replace(text, old, new)',
  format: 'format(pattern, args...)', split: 'split(text, separator)', join: 'join(list, separator)',
  startsWith: 'startsWith(text, prefix)', endsWith: 'endsWith(text, suffix)', contains: 'contains(textOrList, item)',
  len: 'len(listOrText)', first: 'first(list)', last: 'last(list)',
  int: 'int(value)', float: 'float(value)', str: 'str(value)', bool: 'bool(value)', default: 'default(value, fallback)',
  env: 'env(name) - non-deterministic', uuid: 'uuid() - non-deterministic', nowIso: 'nowIso() - non-deterministic',
};

/** The context keys every runtime's core has; a workspace's extensions add their own (bddSuite.contextKeys). */
export const CONTEXT_KEYS = ['timeoutSec', 'defaults'];
export const NAMESPACES = ['capture', 'param', 'var', 'row'];

export type ExprContext =
  /** An operand position: a namespace, context key or function name, `prefix` typed so far. */
  | { kind: 'root'; prefix: string; start: number }
  /** After `root.seg1.seg2.`, with `prefix` typed of the next segment. */
  | { kind: 'path'; root: string; segments: string[]; prefix: string; start: number };

/**
 * The offset just after the innermost `${` that is still open at `offset`, or -1.
 * An unclosed `${` (still being typed) stays open to the end of the text.
 */
export function enclosingExpression(text: string, offset: number): number {
  const stack: { start: number; depth: number }[] = [];
  let i = 0;
  while (i < offset) {
    if (text.startsWith('${', i)) {
      stack.push({ start: i + 2, depth: 1 });
      i += 2;
      continue;
    }
    const top = stack[stack.length - 1];
    const c = text[i];
    if (top && (c === '"' || c === "'")) {
      let j = i + 1;
      while (j < offset && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      if (j >= offset) return top.start;
      i = j + 1;
      continue;
    }
    if (top && c === '{') top.depth++;
    if (top && c === '}' && --top.depth === 0) stack.pop();
    i++;
  }
  return stack.length ? stack[stack.length - 1].start : -1;
}

/** True when the end of `body` is inside a string literal. */
function inString(body: string): boolean {
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
  }
  return quote !== '';
}

/** The text before an operand: nothing, an opening bracket, a comma, an operator, or and/or/not. */
const OPERAND_BEFORE = /(^|[(,+\-*/%<>=!?:]|\band|\bor|\bnot)\s*$/;

export function cursorContext(text: string, offset: number): ExprContext | undefined {
  const start = enclosingExpression(text, offset);
  if (start < 0) return undefined;
  const body = text.slice(start, offset);
  if (inString(body)) return undefined;
  const path = /([A-Za-z_]\w*)((?:\.(?:[A-Za-z_]\w*|\d+))*)\.([A-Za-z_]\w*|\d*)$/.exec(body);
  if (path && OPERAND_BEFORE.test(body.slice(0, path.index))) {
    const segments = path[2] ? path[2].slice(1).split('.') : [];
    return { kind: 'path', root: path[1], segments, prefix: path[3], start: offset - path[3].length };
  }
  const word = /[A-Za-z_]\w*$/.exec(body);
  const prefix = word ? word[0] : '';
  const before = body.slice(0, body.length - prefix.length);
  if (!OPERAND_BEFORE.test(before)) return undefined;
  return { kind: 'root', prefix, start: offset - prefix.length };
}
