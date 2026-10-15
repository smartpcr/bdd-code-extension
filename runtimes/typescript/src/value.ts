// The values a suite holds, typed from the first byte (TS-1, TS-2).
//
// A YAML integer is a bigint and a YAML float is a number, so `2` and `2.0`
// stay different kinds the way they are in Go, C# and Rust; a mapping is a Map,
// so a key that looks like an integer keeps its written place. Text and number
// conversions follow Go's strconv, which is what the other bindings agree on.

export type Value = null | boolean | string | bigint | number | Value[] | ValueMap;
export type ValueMap = Map<string, Value>;

export const isMap = (v: unknown): v is ValueMap => v instanceof Map;
export const isList = (v: unknown): v is Value[] => Array.isArray(v);

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const inInt64 = (n: bigint) => n >= INT64_MIN && n <= INT64_MAX;

/** Go's strconv.ParseInt(s, 10, 64): optional sign and decimal digits only. */
export function parseDecimalInt(s: string): bigint | undefined {
  if (!/^[+-]?[0-9]+$/.test(s)) return undefined;
  const n = BigInt(s);
  return inInt64(n) ? n : undefined;
}

/**
 * Go's strconv.ParseInt(s, 0, 64): a sign, then 0x, 0o, 0b or a leading 0
 * (octal) or decimal digits; underscores only between digits or after a
 * prefix.
 */
export function parseGoInt(s: string): bigint | undefined {
  const m = /^([+-]?)(0[xX]|0[oO]|0[bB]|0(?=[0-9_])|)(.*)$/.exec(s)!;
  const [, sign, prefix, rest] = m as unknown as [string, string, string, string];
  const base = prefix === '' ? 10 : /x/i.test(prefix) ? 16 : /b/i.test(prefix) ? 2 : 8;
  const digit = base === 16 ? '[0-9a-fA-F]' : base === 10 ? '[0-9]' : base === 8 ? '[0-7]' : '[01]';
  // An underscore may follow a prefix or a digit and must be followed by a digit.
  const body = prefix ? `_?${digit}+(_${digit}+)*` : `${digit}+(_${digit}+)*`;
  if (!new RegExp(`^${body}$`).test(rest)) return prefix === '0' && rest === '' ? 0n : undefined;
  const clean = rest.replace(/_/g, '');
  const magnitude = base === 10 ? BigInt(clean) : BigInt((base === 16 ? '0x' : base === 8 ? '0o' : '0b') + clean);
  const n = sign === '-' ? -magnitude : magnitude;
  return inInt64(n) ? n : undefined;
}

/** Go's strconv.ParseFloat(s, 64) for the forms a suite can write: decimal, exponent, inf, infinity, nan. */
export function parseGoFloat(s: string): number | undefined {
  if (/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(s)) return Number(s);
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(s);
  if (!special) return undefined;
  if (special[2]!.toLowerCase() === 'nan') return NaN;
  return special[1] === '-' ? -Infinity : Infinity;
}

/** Go's strconv.FormatFloat(f, 'g', -1, 64): shortest digits, exponent form below 1e-4 or from 1e6. */
export function formatGoFloat(f: number): string {
  if (Number.isNaN(f)) return 'NaN';
  if (f === Infinity) return '+Inf';
  if (f === -Infinity) return '-Inf';
  if (f === 0) return Object.is(f, -0) ? '-0' : '0';
  const [mantissa, e] = f.toExponential().split('e') as [string, string];
  const exp = Number(e);
  if (exp < -4 || exp >= 6) {
    const sign = exp < 0 ? '-' : '+';
    const digits = String(Math.abs(exp)).padStart(2, '0');
    return `${mantissa}e${sign}${digits}`;
  }
  // Fixed notation with the same shortest digits.
  const negative = mantissa.startsWith('-');
  const digits = mantissa.replace('-', '').replace('.', '');
  let out: string;
  if (exp >= 0) {
    const whole = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
    const frac = digits.slice(exp + 1);
    out = frac ? `${whole}.${frac}` : whole;
  } else {
    out = `0.${'0'.repeat(-exp - 1)}${digits}`;
  }
  return negative ? `-${out}` : out;
}

/** A float as the bindings print it: a whole number without a fraction, else Go's 'g'. */
export function numberText(f: number): string {
  if (Number.isFinite(f) && f === Math.trunc(f) && Math.abs(f) < 9.2e18) return BigInt(f).toString();
  return formatGoFloat(f);
}

/** The canonical text of a value: null is "", booleans lowercase, a list joined with ", ", a map as JSON. */
export function text(v: Value | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return numberText(v);
  if (isList(v)) return v.map(text).join(', ');
  return toJson(v);
}

/** A value as a number, the way the comparisons read one: an int, a float, or a string that parses. */
export function asNumber(v: Value | undefined): number | undefined {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseGoFloat(v.trim());
  return undefined;
}

/** The JSON-compatible copy Ajv validates: bigint to number, Map to object. */
export function toPlain(v: Value | undefined): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (isList(v)) return v.map(toPlain);
  if (isMap(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, item] of v) out[k] = toPlain(item);
    return out;
  }
  return v ?? null;
}

/** JSON text with a bigint written as an integer and map keys in their order. */
export function toJson(v: Value | undefined, indent?: number): string {
  const json = (x: Value | undefined, depth: number): string => {
    const pad = indent ? '\n' + ' '.repeat(indent * (depth + 1)) : '';
    const close = indent ? '\n' + ' '.repeat(indent * depth) : '';
    const sep = indent ? ': ' : ':';
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'bigint') return x.toString();
    if (typeof x === 'number') return Number.isFinite(x) ? JSON.stringify(x) : 'null';
    if (typeof x === 'boolean' || typeof x === 'string') return JSON.stringify(x);
    if (isList(x)) return x.length ? `[${x.map(i => pad + json(i, depth + 1)).join(',')}${close}]` : '[]';
    const entries = [...x];
    return entries.length ? `{${entries.map(([k, i]) => `${pad}${JSON.stringify(k)}${sep}${json(i, depth + 1)}`).join(',')}${close}}` : '{}';
  };
  return json(v, 0);
}

/** A map built from entries, for tests and small literals. */
export const mapOf = (entries: Record<string, Value>): ValueMap => new Map(Object.entries(entries));
