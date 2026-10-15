// A finding, its total order, and the two ways it is printed.
import * as path from 'node:path';
import type { Pos } from './model.js';

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  code: string;
  severity: Severity;
  file: string;
  position: Pos;
  message: string;
  suggestion?: string;
}

export const error = (code: string, file: string, position: Pos, message: string, suggestion?: string): Diagnostic =>
  ({ code, severity: 'error', file, position, message, ...(suggestion ? { suggestion } : {}) });

export const warning = (code: string, file: string, position: Pos, message: string, suggestion?: string): Diagnostic =>
  ({ ...error(code, file, position, message, suggestion), severity: 'warning' });

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** The total order every binding prints in: file, line, column, code, message. */
export function compare(a: Diagnostic, b: Diagnostic): number {
  return cmp(a.file, b.file) || cmp(a.position.line, b.position.line) || cmp(a.position.column, b.position.column)
    || cmp(a.code, b.code) || cmp(a.message, b.message);
}

/** Sorted, with adjacent duplicates dropped: the two structural passes both check the common step keys. */
export function sorted(found: Diagnostic[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const d of [...found].sort(compare)) if (!out.length || compare(out[out.length - 1]!, d) !== 0) out.push(d);
  return out;
}

/** Whether the findings fail the lint: any error, or anything at all when strict. */
export const fails = (found: Diagnostic[], strict: boolean): boolean => found.some(d => d.severity === 'error' || strict);

export function human(d: Diagnostic): string {
  const head = `${d.file}:${d.position.line}:${d.position.column}  ${d.code}  ${d.message}`;
  return d.suggestion ? `${head}\n    ${d.suggestion}` : head;
}

/** The --json document: an array in the key order the other bindings write. */
export function toJsonArray(found: Diagnostic[]): string {
  if (!found.length) return '[]';
  return JSON.stringify(found.map(d => ({
    code: d.code, severity: d.severity, file: d.file, line: d.position.line, column: d.position.column, message: d.message,
    ...(d.suggestion ? { suggestion: d.suggestion } : {}),
  })), null, 2);
}

/** A path relative to the root with forward slashes, or the full path when it is outside the root. */
export function relativePath(full: string, root: string): string {
  const rel = path.relative(root, full);
  const out = !rel || rel.startsWith('..') || path.isAbsolute(rel) ? full : rel;
  return out.replace(/\\/g, '/');
}
