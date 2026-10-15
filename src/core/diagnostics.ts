// Lint output: parsing it against diagnostic.schema.json's shape, mapping it to
// editor positions, and keeping each linted file's result (plan 2.4, B2.1, B2.2).
import * as path from 'path';
import { fileKey } from './paths';

/** One finding exactly as a binding's `lint --json` prints it. */
export interface RawDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  file: string;
  line: number;
  column: number;
  message: string;
  suggestion?: string;
}

/** A finding resolved to an absolute file and zero-based position. */
export interface LintDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  file: string;
  line: number;
  character: number;
  message: string;
  suggestion?: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; detail: string };

const KEYS = new Set(['code', 'severity', 'file', 'line', 'column', 'message', 'suggestion']);
const posInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 1;

/** The shape of diagnostic.schema.json, element by element (B2.1-6). */
export function isRawDiagnostic(v: unknown): v is RawDiagnostic {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return Object.keys(o).every(k => KEYS.has(k))
    && typeof o.code === 'string' && /^[EW][0-9]{3}$/.test(o.code)
    && (o.severity === 'error' || o.severity === 'warning')
    && typeof o.file === 'string' && o.file.length > 0
    && posInt(o.line) && posInt(o.column)
    && typeof o.message === 'string' && o.message.length > 0
    && (o.suggestion === undefined || typeof o.suggestion === 'string');
}

/**
 * Exit 0 or 2 with a JSON array of diagnostics is a result. Anything else,
 * including exit 2 with output that is not that array, is a failure: exit 2
 * means both "findings" and "harness error" (DEC-Y14), so the parse decides.
 */
export function parseLintOutput(stdout: string, exitCode: number | null): ParseResult<RawDiagnostic[]> {
  if (exitCode !== 0 && exitCode !== 2) return { ok: false, detail: `exit code ${exitCode}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.replace(/^﻿/, ''));
  } catch {
    return { ok: false, detail: 'the output is not JSON' };
  }
  if (!Array.isArray(parsed)) return { ok: false, detail: 'the output is not a JSON array' };
  const bad = parsed.findIndex(d => !isRawDiagnostic(d));
  if (bad !== -1) return { ok: false, detail: `element ${bad} is not a diagnostic` };
  return { ok: true, value: parsed as RawDiagnostic[] };
}

/** `actions --json`: a JSON array of action names. */
export function parseActionsOutput(stdout: string): ParseResult<string[]> {
  try {
    const parsed: unknown = JSON.parse(stdout.replace(/^﻿/, ''));
    if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) return { ok: true, value: parsed };
    return { ok: false, detail: 'the output is not a JSON array of names' };
  } catch {
    return { ok: false, detail: 'the output is not JSON' };
  }
}

/** One-based file positions to zero-based, and the file to an absolute key under `root` (INV-10). */
export function toZeroBased(d: RawDiagnostic, root: string): LintDiagnostic {
  const out: LintDiagnostic = {
    code: d.code, severity: d.severity, file: fileKey(path.resolve(root, d.file)),
    line: d.line - 1, character: d.column - 1, message: d.message,
  };
  if (d.suggestion !== undefined) out.suggestion = d.suggestion;
  return out;
}

/** Where the YAML token starting at `character` ends; the line's end when there is none. */
export function tokenEnd(lineText: string, character: number): number {
  const m = /[^\s:,[\]{}#]+/y;
  m.lastIndex = character;
  const hit = m.exec(lineText);
  return hit ? character + hit[0].length : lineText.length;
}

/** An open editor buffer, as the lint controller sees it. */
export interface OpenBuffer {
  path: string;
  text: string;
  dirty: boolean;
}

/**
 * The unsaved text a live lint sends (plan B8.2 item 2): every dirty buffer the
 * index holds as a suite or library, keyed by absolute path. A clean buffer is
 * what the disk holds, so it is not sent (INV-12: nothing is written instead).
 */
export function selectOverlays(buffers: OpenBuffer[], isCandidate: (file: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of buffers) if (b.dirty && isCandidate(b.path)) out[b.path] = b.text;
  return out;
}

export interface Published {
  diagnostic: LintDiagnostic;
  stale: boolean;
}

/**
 * Each linted file's latest result (INV-3, INV-4). A result replaces only the
 * same linted file's previous one; a failure marks it stale and never empties it.
 */
export class LintResults {
  private readonly byLinted = new Map<string, { diagnostics: LintDiagnostic[]; stale: boolean }>();

  /** Replace one linted file's result; returns every file whose published set may have changed. */
  replace(linted: string, diagnostics: LintDiagnostic[]): string[] {
    const key = fileKey(linted);
    const old = this.byLinted.get(key)?.diagnostics ?? [];
    this.byLinted.set(key, { diagnostics, stale: false });
    return [...new Set([key, ...old.map(d => d.file), ...diagnostics.map(d => d.file)])];
  }

  /** Keep the previous result of a linted file, marked stale. */
  markStale(linted: string): string[] {
    const entry = this.byLinted.get(fileKey(linted));
    if (!entry) return [];
    entry.stale = true;
    return [...new Set([fileKey(linted), ...entry.diagnostics.map(d => d.file)])];
  }

  isStale(linted: string): boolean {
    return this.byLinted.get(fileKey(linted))?.stale ?? false;
  }

  /** Everything published for `file`, across all linted files. */
  forFile(file: string): Published[] {
    const key = fileKey(file);
    const out: Published[] = [];
    for (const entry of this.byLinted.values()) {
      for (const d of entry.diagnostics) if (d.file === key) out.push({ diagnostic: d, stale: entry.stale });
    }
    return out;
  }
}
