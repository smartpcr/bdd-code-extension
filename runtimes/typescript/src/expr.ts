// The expression language inside ${...} (yml_suite_design.md 5.9), held to
// expressions/cases.yaml.
//
// The parser evaluates as it reads, one precedence level per method (ternary,
// or, and, comparison, sum, product, unary, primary), so the first problem met
// left to right is the one reported, which is the order the table pins. A
// ternary evaluates the branch it takes and only checks the other one: an
// unknown function, a wrong argument count or an unstable call there is still
// refused.
//
// Numbers keep their kind (TS-2): an integer literal is a bigint and stays one
// through + - * %; / gives an integer when it divides exactly; any float
// operand makes the result a float. An integer result outside int64 is
// refused with E307 rather than wrapped or widened.
import { CORE_ROOTS } from './extension.js';
import { asNumber, isList, isMap, parseDecimalInt, parseGoFloat, text, Value } from './value.js';

export interface FunctionSpec {
  min: number;
  max: number;
  /** False for env, uuid and nowIso, which a stable value (a vars block) may not call. */
  deterministic: boolean;
}

export const FUNCTIONS: Readonly<Record<string, FunctionSpec>> = {
  lower: { min: 1, max: 1, deterministic: true },
  upper: { min: 1, max: 1, deterministic: true },
  trim: { min: 1, max: 1, deterministic: true },
  replace: { min: 3, max: 3, deterministic: true },
  format: { min: 1, max: 99, deterministic: true },
  split: { min: 2, max: 2, deterministic: true },
  join: { min: 2, max: 2, deterministic: true },
  startsWith: { min: 2, max: 2, deterministic: true },
  endsWith: { min: 2, max: 2, deterministic: true },
  contains: { min: 2, max: 2, deterministic: true },
  len: { min: 1, max: 1, deterministic: true },
  first: { min: 1, max: 1, deterministic: true },
  last: { min: 1, max: 1, deterministic: true },
  int: { min: 1, max: 1, deterministic: true },
  float: { min: 1, max: 1, deterministic: true },
  str: { min: 1, max: 1, deterministic: true },
  bool: { min: 1, max: 1, deterministic: true },
  default: { min: 2, max: 2, deterministic: true },
  env: { min: 1, max: 1, deterministic: false },
  uuid: { min: 0, max: 0, deterministic: false },
  nowIso: { min: 0, max: 0, deterministic: false },
};

export const FUNCTION_NAMES: readonly string[] = Object.keys(FUNCTIONS).sort();

/** The roots a path may start at when no extension adds a context key. */
export const ROOTS: readonly string[] = CORE_ROOTS;

/** An expression refused with its code (E301, E305-E309). */
export class ExprError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const refuse = (code: string, message: string) => new ExprError(code, message);

export interface Scope {
  /** The context the roots are read from. */
  value: Value;
  /** False where a value has to be stable (a vars block): env, uuid and nowIso are refused (E309). */
  allowNonDeterministic: boolean;
  /** Checks the shape and the calls without reading anything; used for an untaken branch and by read(). */
  syntaxOnly?: boolean;
  /** The roots a path may start at: the core's and the extensions' context keys. ROOTS when absent. */
  roots?: readonly string[];
}

export const newScope = (value: Value, roots: readonly string[] = ROOTS): Scope => ({ value, allowNonDeterministic: true, roots });
export const stable = (scope: Scope): Scope => ({ ...scope, allowNonDeterministic: false });

type Token =
  | { kind: 'number'; value: bigint | number; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'name'; text: string }
  | { kind: 'op'; text: string }
  | { kind: 'end'; text: '' };

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isNameStart = (c: string | undefined) => c !== undefined && /[A-Za-z_]/.test(c);
const isNameRest = (c: string | undefined) => isNameStart(c) || isDigit(c);

/** Splits an expression into tokens; an unclosed string or a character outside the language is E305. */
export function scan(source: string): Token[] {
  const chars = [...source];
  const out: Token[] = [];
  let at = 0;
  while (at < chars.length) {
    const c = chars[at]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      at++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = chars.indexOf(c, at + 1);
      if (end < 0) throw refuse('E305', `a string is never closed, in '${source}'`);
      out.push({ kind: 'text', text: chars.slice(at + 1, end).join('') });
      at = end + 1;
      continue;
    }
    if (isDigit(c)) {
      let written = '';
      // A dot joins a number only once and only when a digit follows it, so `capture.list.0.name` stays a path.
      while (at < chars.length && (isDigit(chars[at]) || (chars[at] === '.' && isDigit(chars[at + 1]) && !written.includes('.')))) {
        written += chars[at++];
      }
      const value = written.includes('.') ? parseGoFloat(written) : parseDecimalInt(written);
      if (value === undefined) throw refuse('E305', `'${written}' is not a number this language can read, in '${source}'`);
      out.push({ kind: 'number', value, text: written });
      continue;
    }
    if (isNameStart(c)) {
      let name = '';
      while (at < chars.length && isNameRest(chars[at])) name += chars[at++];
      out.push({ kind: 'name', text: name });
      continue;
    }
    const two = c + (chars[at + 1] ?? '');
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
      out.push({ kind: 'op', text: two });
      at += 2;
      continue;
    }
    if ('+-*/%<>?:(),.'.includes(c)) {
      out.push({ kind: 'op', text: c });
      at++;
      continue;
    }
    throw refuse('E305', `'${c}' is not part of this language, at position ${at + 1} of '${source}'`);
  }
  out.push({ kind: 'end', text: '' });
  return out;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function checked(n: bigint): bigint {
  if (n < INT64_MIN || n > INT64_MAX) throw refuse('E307', 'integer overflow: the result does not fit in a 64-bit integer');
  return n;
}

/** A value as an exact integer: a bigint, or text that is one. Undefined for anything that is a float or no number. */
function asWhole(v: Value): bigint | undefined {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string') return parseDecimalInt(v.trim());
  return undefined;
}

/** true/yes/1 and false/no/0/"" (and null), ignoring case and surrounding space. */
function toBool(v: Value): boolean | undefined {
  if (typeof v === 'boolean') return v;
  const t = text(v).trim().toLowerCase();
  if (t === 'true' || t === 'yes' || t === '1') return true;
  if (t === 'false' || t === 'no' || t === '0' || t === '') return false;
  return undefined;
}

function truthy(v: Value): boolean {
  const b = toBool(v);
  if (b === undefined) throw refuse('E307', `bool cannot read '${text(v)}' as true or false`);
  return b;
}

const equalFold = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function arithmetic(op: string, left: Value, right: Value): Value {
  const a = asNumber(left);
  const b = asNumber(right);
  if (op === '+' && (a === undefined || b === undefined)) return text(left) + text(right);
  if (a === undefined || b === undefined) throw refuse('E307', `${op} takes numbers, and '${text(left)}' or '${text(right)}' is not one`);
  const x = asWhole(left);
  const y = asWhole(right);
  if ((op === '/' || op === '%') && b === 0) throw refuse('E307', 'division by zero');
  const float = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '%' ? a % b : a / b;
  if (x !== undefined && y !== undefined) {
    const exact = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '%' ? x % y : x % y === 0n ? x / y : undefined;
    // Exact while a float would be exact too; past 2^53 the result is what Go,
    // Rust and C# give, which all compute in f64 and keep a whole result
    // under 9.2e18 an integer (B7.3 item 6: no corpus row pins it).
    if (exact !== undefined && exact <= SAFE && exact >= -SAFE) return exact;
    return Number.isInteger(float) && Math.abs(float) < 9.2e18 ? BigInt(float) : float;
  }
  return float;
}

const SAFE = 2n ** 53n;

function compare(op: string, left: Value, right: Value): boolean {
  const a = asNumber(left);
  const b = asNumber(right);
  const numeric = a !== undefined && b !== undefined;
  const x = asWhole(left);
  const y = asWhole(right);
  // Two integers compare exactly; anything else numeric compares as floats.
  const order = !numeric ? 0 : x !== undefined && y !== undefined ? (x < y ? -1 : x > y ? 1 : 0) : (a! < b! ? -1 : a! > b! ? 1 : a === b ? 0 : NaN);
  if (op === '==') return numeric ? order === 0 : equalFold(text(left), text(right));
  if (op === '!=') return numeric ? order !== 0 : !equalFold(text(left), text(right));
  if (!numeric) throw refuse('E307', `${op} compares numbers, and '${text(left)}' or '${text(right)}' is not one`);
  if (op === '<') return order < 0;
  if (op === '<=') return order <= 0;
  if (op === '>') return order > 0;
  return order >= 0;
}

/** A field of a map, or nothing. */
export function field(held: Value, key: string): { found: boolean; value: Value } {
  return isMap(held) && held.has(key) ? { found: true, value: held.get(key)! } : { found: false, value: null };
}

function resolve(segments: string[], scope: Scope): Value {
  const whole = segments.join('.');
  const roots = scope.roots ?? ROOTS;
  if (!roots.includes(segments[0]!)) throw refuse('E301', `\${${whole}} resolves to nothing. A path starts at ${roots.join(', ')}.`);
  let current: Value = scope.value;
  for (const segment of segments) {
    if (current === null) throw refuse('E301', `\${${whole}} resolves to nothing.`);
    if (isList(current) && /^[0-9]+$/.test(segment)) {
      const index = Number(segment);
      if (index >= current.length) throw refuse('E301', `\${${whole}} resolves to nothing: the list has ${current.length} entries.`);
      current = current[index]!;
      continue;
    }
    const f = field(current, segment);
    if (!f.found) throw refuse('E301', `\${${whole}} resolves to nothing: no ${segment} there.`);
    current = f.value;
  }
  return current;
}

const asList = (v: Value): Value[] => (isList(v) ? v : v === null ? [] : [v]);

let minted = 0n;
export function newIdentifier(): string {
  minted++;
  return (BigInt(Date.now()) * 1_000_000n).toString(16).padStart(16, '0') + minted.toString(16).padStart(16, '0');
}

function call(name: string, args: Value[], scope: Scope): Value {
  const spec = FUNCTIONS[name];
  if (!spec) {
    const prefix = name.toLowerCase().slice(0, 2);
    const guess = FUNCTION_NAMES.find(c => c.toLowerCase().startsWith(prefix));
    throw refuse('E306', `there is no function called ${name}.${guess ? ` Did you mean ${guess}?` : ''}`);
  }
  if (args.length < spec.min || args.length > spec.max) {
    const expected = spec.min === spec.max ? String(spec.min) : `${spec.min} to ${spec.max}`;
    throw refuse('E307', `${name} takes ${expected} argument(s), not ${args.length}`);
  }
  if (!spec.deterministic && !scope.allowNonDeterministic) throw refuse('E309', `${name} is not deterministic, and this value has to be stable`);
  if (scope.syntaxOnly) return 1n;
  const t = (i: number) => text(args[i]!);
  switch (name) {
    case 'lower': return t(0).toLowerCase();
    case 'upper': return t(0).toUpperCase();
    case 'trim': return t(0).trim();
    case 'replace': return t(0).split(t(1)).join(t(2));
    case 'format': return args.slice(1).reduce<string>((out, arg, i) => out.split(`{${i}}`).join(text(arg)), t(0));
    case 'split': return t(0).split(t(1));
    case 'join': return asList(args[0]!).map(text).join(t(1));
    case 'startsWith': return t(0).toLowerCase().startsWith(t(1).toLowerCase());
    case 'endsWith': return t(0).toLowerCase().endsWith(t(1).toLowerCase());
    case 'contains': {
      const subject = args[0]!;
      // A list by membership (exact text); a string by substring, ignoring case.
      if (isList(subject)) return subject.some(item => text(item) === t(1));
      return t(0).toLowerCase().includes(t(1).toLowerCase());
    }
    case 'len': {
      const v = args[0]!;
      if (v === null) return 0n;
      if (typeof v === 'string') return BigInt([...v].length);
      if (isList(v)) return BigInt(v.length);
      if (isMap(v)) return BigInt(v.size);
      throw refuse('E307', 'len takes a string or a list');
    }
    case 'first':
    case 'last': {
      const items = asList(args[0]!);
      if (!items.length) throw refuse('E307', `${name} takes a list with something in it`);
      return name === 'first' ? items[0]! : items[items.length - 1]!;
    }
    case 'int': {
      const whole = asWhole(args[0]!);
      if (whole !== undefined) return whole;
      const n = asNumber(args[0]!);
      if (n === undefined || !Number.isFinite(n)) throw refuse('E307', `int cannot read '${t(0)}' as a number`);
      return checked(BigInt(Math.trunc(n)));
    }
    case 'float': {
      const n = asNumber(args[0]!);
      if (n === undefined) throw refuse('E307', `float cannot read '${t(0)}' as a number`);
      return n;
    }
    case 'str': return t(0);
    case 'bool': {
      const b = toBool(args[0]!);
      if (b === undefined) throw refuse('E307', `bool cannot read '${t(0)}' as true or false`);
      return b;
    }
    case 'default': return args[0] === null || t(0) === '' ? args[1]! : args[0]!;
    case 'env': return process.env[t(0)] ?? '';
    case 'uuid': return newIdentifier();
    default: return new Date().toISOString().replace(/\.[0-9]{3}Z$/, 'Z');
  }
}

/** One expression read and evaluated left to right, or the first problem met. */
class Reader {
  private at = 0;
  constructor(private readonly tokens: Token[], private readonly source: string, private scope: Scope) {}

  private peek(): Token {
    return this.tokens[this.at]!;
  }

  private is(...texts: string[]): boolean {
    const t = this.peek();
    return (t.kind === 'op' || t.kind === 'name') && texts.includes(t.text);
  }

  private get dry(): boolean {
    return !!this.scope.syntaxOnly;
  }

  expression(): Value {
    const result = this.ternary();
    const left = this.peek();
    if (left.kind !== 'end') throw refuse('E305', `'${left.text}' is left over at the end of '${this.source}'`);
    return result;
  }

  private ternary(): Value {
    const condition = this.or();
    if (!this.is('?')) return condition;
    this.at++;
    const taken = this.dry ? true : truthy(condition);
    const whenTrue = this.branch(taken);
    if (!this.is(':')) throw refuse('E305', `a ? needs a : after it, in '${this.source}'`);
    this.at++;
    const whenFalse = this.branch(!taken);
    return taken ? whenTrue : whenFalse;
  }

  /** The branch a ternary takes is evaluated; the other is only checked. */
  private branch(evaluate: boolean): Value {
    if (evaluate || this.dry) return this.ternary();
    const outer = this.scope;
    this.scope = { ...outer, syntaxOnly: true };
    try {
      return this.ternary();
    } finally {
      this.scope = outer;
    }
  }

  private or(): Value {
    let left = this.and();
    while (this.is('or')) {
      this.at++;
      const right = this.and();
      if (this.dry) left = true;
      else {
        // Both sides are read as booleans, so a right side that is not one is refused even when the left decides.
        const one = truthy(left);
        const other = truthy(right);
        left = one || other;
      }
    }
    return left;
  }

  private and(): Value {
    let left = this.comparison();
    while (this.is('and')) {
      this.at++;
      const right = this.comparison();
      if (this.dry) left = true;
      else {
        const one = truthy(left);
        const other = truthy(right);
        left = one && other;
      }
    }
    return left;
  }

  private comparison(): Value {
    const left = this.sum();
    for (const op of ['==', '!=', '<=', '>=', '<', '>']) {
      if (this.is(op)) {
        this.at++;
        const right = this.sum();
        return this.dry ? true : compare(op, left, right);
      }
    }
    return left;
  }

  private sum(): Value {
    let left = this.product();
    while (this.is('+', '-')) {
      const op = this.peek().text;
      this.at++;
      const right = this.product();
      left = this.dry ? 1n : arithmetic(op, left, right);
    }
    return left;
  }

  private product(): Value {
    let left = this.unary();
    while (this.is('*', '/', '%')) {
      const op = this.peek().text;
      this.at++;
      const right = this.unary();
      left = this.dry ? 1n : arithmetic(op, left, right);
    }
    return left;
  }

  private unary(): Value {
    if (this.is('-')) {
      this.at++;
      const held = this.unary();
      return this.dry ? 1n : arithmetic('-', 0n, held);
    }
    if (this.is('not')) {
      this.at++;
      const held = this.unary();
      return this.dry ? true : !truthy(held);
    }
    return this.primary();
  }

  private primary(): Value {
    const found = this.tokens[this.at++]!;
    switch (found.kind) {
      case 'number': return found.value;
      case 'text': return found.text;
      case 'end': throw refuse('E305', `'${this.source}' ends before it says anything`);
      case 'op': {
        if (found.text !== '(') throw refuse('E305', `'${found.text}' has nothing to work on, in '${this.source}'`);
        const inside = this.ternary();
        if (!this.is(')')) throw refuse('E305', `a ( is never closed, in '${this.source}'`);
        this.at++;
        return inside;
      }
      default: break;
    }
    if (found.text === 'true') return true;
    if (found.text === 'false') return false;
    if (found.text === 'null') return null;
    if (this.is('(')) {
      this.at++;
      const args: Value[] = [];
      if (!this.is(')')) {
        do {
          if (args.length) this.at++;
          args.push(this.ternary());
        } while (this.is(','));
      }
      if (!this.is(')')) throw refuse('E305', `a call to ${found.text} is never closed, in '${this.source}'`);
      this.at++;
      return call(found.text, args, this.scope);
    }
    const segments = [found.text];
    while (this.is('.')) {
      this.at++;
      const segment = this.tokens[this.at++]!;
      if (segment.kind === 'name' || segment.kind === 'number') segments.push(segment.text);
      else throw refuse('E305', `a path ends with a dot, in '${this.source}'`);
    }
    return this.dry ? 1n : resolve(segments, this.scope);
  }
}

/** Evaluates one expression (the text inside ${ }). Throws ExprError. */
export function evaluate(source: string, scope: Scope): Value {
  return new Reader(scan(source), source, scope).expression();
}

/** Each ${...} in a text, with the span it covers; a ${ never closed is text. */
export function references(source: string): { expression: string; start: number; end: number }[] {
  const chars = [...source];
  const out: { expression: string; start: number; end: number }[] = [];
  for (let at = 0; at < chars.length; at++) {
    if (chars[at] !== '$' || chars[at + 1] !== '{') continue;
    const close = chars.indexOf('}', at + 2);
    if (close < 0) continue;
    out.push({ expression: chars.slice(at + 2, close).join(''), start: at, end: close + 1 });
    at = close;
  }
  return out;
}

/**
 * Expands every ${...} in a value. A string that is exactly one ${...} keeps
 * the expression's type; otherwise each is replaced by its text, and a failing
 * one is refused with its own code (design 6.4). Lists and maps are expanded
 * item by item.
 */
export function expand(held: Value, scope: Scope): Value {
  if (typeof held === 'string') {
    const trimmed = held.trim();
    if (held === trimmed && trimmed.startsWith('${') && trimmed.endsWith('}') && !trimmed.slice(2, -1).includes('${')) {
      return evaluate(trimmed.slice(2, -1), scope);
    }
    const chars = [...held];
    let out = '';
    let last = 0;
    for (const r of references(held)) {
      out += chars.slice(last, r.start).join('') + text(evaluate(r.expression, scope));
      last = r.end;
    }
    return out + chars.slice(last).join('');
  }
  if (isList(held)) return held.map(item => expand(item, scope));
  if (isMap(held)) return new Map([...held].map(([k, v]) => [k, expand(v, scope)]));
  return held;
}

export interface Reading {
  /** Each path read, as its segments. */
  paths: string[][];
  /** Each function called, by name. */
  functions: string[];
  error?: ExprError;
}

const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null']);

/** What an expression reads and calls, checked without evaluating anything; stable refuses unstable calls. */
export function read(source: string, isStable: boolean): Reading {
  const reading: Reading = { paths: [], functions: [] };
  let tokens: Token[];
  try {
    tokens = scan(source);
    new Reader(tokens, source, { value: null, allowNonDeterministic: !isStable, syntaxOnly: true }).expression();
  } catch (e) {
    reading.error = e as ExprError;
    return reading;
  }
  for (let at = 0; at < tokens.length; at++) {
    const t = tokens[at]!;
    if (t.kind !== 'name' || KEYWORDS.has(t.text)) continue;
    if (tokens[at + 1]?.kind === 'op' && tokens[at + 1]!.text === '(') {
      reading.functions.push(t.text);
      continue;
    }
    const segments = [t.text];
    while (tokens[at + 1]?.text === '.' && (tokens[at + 2]?.kind === 'name' || tokens[at + 2]?.kind === 'number')) {
      segments.push(tokens[at + 2]!.text);
      at += 2;
    }
    reading.paths.push(segments);
  }
  return reading;
}
