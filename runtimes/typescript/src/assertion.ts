// The assertion operators (DEC-Y20), held to asserts/cases.yaml.
//
// equals compares text ignoring case, so 3 equals "3"; contains is membership
// for a list and a case-blind substring for text; gt/gte/lt/lte read numbers;
// isTrue and isFalse want a boolean; absent and null differ only to isNull and
// isNotNull. `script` runs PowerShell and is refused outside it (E201).
import { asNumber, isList, text, Value } from './value.js';

export const OPERATORS: readonly string[] = [
  'equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'matches', 'in',
  'gt', 'gte', 'lt', 'lte', 'count', 'isTrue', 'isFalse', 'isNull', 'isNotNull', 'script',
];

/**
 * The constructs SuiteLint.psm1 refuses because one binding's engine cannot
 * run them, plus an inline flag group, which RE2 accepts and JavaScript only
 * partly does. Returns what the pattern uses, or "" when it is portable.
 */
export function unportable(pattern: string): string {
  if (/\(\?=/.test(pattern)) return 'a lookahead';
  if (/\(\?!/.test(pattern)) return 'a negative lookahead';
  if (/\(\?<=/.test(pattern)) return 'a lookbehind';
  if (/\(\?<!/.test(pattern)) return 'a negative lookbehind';
  if (/\\[1-9]/.test(pattern)) return 'a backreference';
  if (/\(\?[a-zA-Z]+(:|\))/.test(pattern)) return 'an inline flag group';
  return '';
}

/** Why two values could not be compared at all; `code` when a validator reports the same before a run. */
export class CompareError extends Error {
  constructor(message: string, readonly code = '') {
    super(message);
  }
}

function numberOf(v: Value, side: string, op: string): number {
  const n = asNumber(v);
  if (n === undefined) throw new CompareError(`${op} compares numbers, and the ${side} is '${text(v)}', which is not one.`);
  return n;
}

/** What an expected value of isTrue/isFalse/isNull/isNotNull asks for. */
function truthOf(v: Value): boolean {
  if (typeof v === 'boolean') return v;
  if (v === null) return false;
  const t = text(v);
  return t !== '' && t !== '0';
}

/** Whether the assertion holds; throws CompareError when the operands cannot be compared. */
export function compare(op: string, actual: Value, expected: Value, present: boolean): boolean {
  const subject = text(actual);
  const wanted = text(expected);
  switch (op) {
    case 'equals': return subject.toLowerCase() === wanted.toLowerCase();
    case 'notEquals': return subject.toLowerCase() !== wanted.toLowerCase();
    case 'contains':
      return isList(actual) ? actual.some(item => text(item) === wanted) : subject.toLowerCase().includes(wanted.toLowerCase());
    case 'notContains': return !compare('contains', actual, expected, present);
    case 'startsWith': return subject.toLowerCase().startsWith(wanted.toLowerCase());
    case 'endsWith': return subject.toLowerCase().endsWith(wanted.toLowerCase());
    case 'matches': {
      const construct = unportable(wanted);
      if (construct) throw new CompareError(`the pattern '${wanted}' uses ${construct}, which is outside the subset the bindings share.`, 'E308');
      let pattern: RegExp;
      try {
        pattern = new RegExp(wanted, 'iu');
      } catch (e) {
        throw new CompareError(`the pattern '${wanted}' cannot be read: ${(e as Error).message}`);
      }
      return pattern.test(subject);
    }
    case 'in':
      if (!isList(expected)) throw new CompareError(`in takes a list, and '${wanted}' is not one.`);
      return expected.some(candidate => text(candidate).toLowerCase() === subject.toLowerCase());
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = numberOf(actual, 'subject', op);
      const b = numberOf(expected, 'expected value', op);
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
    case 'count': {
      if (!isList(actual)) throw new CompareError(`count takes a list, and the subject is '${subject}', which is not one.`);
      return actual.length === numberOf(expected, 'expected value', 'count');
    }
    case 'isTrue': return (actual === true) === truthOf(expected);
    case 'isFalse': return (actual === false) === truthOf(expected);
    case 'isNull': return (!present || actual === null) === truthOf(expected);
    case 'isNotNull': return (present && actual !== null) === truthOf(expected);
    case 'script': throw new CompareError('script runs PowerShell, which only the PowerShell binding implements.', 'E201');
    default: throw new CompareError(`Unknown assertion: ${op}`);
  }
}

/** The failure sentence an assertion that did not hold reports. */
export function describe(subject: string, op: string, expected: Value, actual: Value, present: boolean): string {
  const shown = !present ? '(absent)' : actual === null ? '(null)' : isList(actual) ? `[${actual.map(text).join(', ')}]` : text(actual);
  const wanted = isList(expected) ? `[${expected.map(text).join(', ')}]` : text(expected);
  switch (op) {
    case 'isTrue': return `expected ${subject} to be true, got '${shown}'`;
    case 'isFalse': return `expected ${subject} to be false, got '${shown}'`;
    case 'isNull': return `expected ${subject} to be absent or null, got '${shown}'`;
    case 'isNotNull': return `expected ${subject} to be present, got '${shown}'`;
    case 'count': return `expected ${subject} to have ${wanted} entries, got '${shown}'`;
    default: return `expected ${subject} ${op} '${wanted}', got '${shown}'`;
  }
}
