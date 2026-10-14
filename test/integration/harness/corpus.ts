// The conformance corpus as an oracle (E-B1). Reads run-manifest.yaml and the
// expectation files; nothing is copied into this repository.
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

export interface ExpectedDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  line: number;
  column: number;
}

export interface ValidateEntry {
  suite: string;
  /** The suite path relative to the repository root. */
  rel: string;
  /** The binding to check portability against: the entry's when it asks, else powershell. */
  target: string;
  exitCode: number;
  diagnostics: ExpectedDiagnostic[];
}

/**
 * Validate entries an editor lint can reproduce: no catalogOverlay (a corpus-only
 * mechanism) and no params (command-line --param values an editor does not have).
 */
export function validateEntries(root: string): { entries: ValidateEntry[]; excluded: string[] } {
  const base = path.join(root, 'test', 'e2e', 'conformance');
  const manifest = parse(fs.readFileSync(path.join(base, 'run-manifest.yaml'), 'utf8'));
  const entries: ValidateEntry[] = [];
  const excluded: string[] = [];
  for (const e of manifest.entries as Record<string, unknown>[]) {
    if (e.kind !== 'validate') continue;
    if (e.catalogOverlay || e.params) {
      excluded.push(`${e.suite} (${e.catalogOverlay ? 'catalogOverlay' : 'params'})`);
      continue;
    }
    const exp = JSON.parse(fs.readFileSync(path.join(base, String(e.expectation)), 'utf8'));
    entries.push({
      suite: String(e.suite),
      rel: `test/e2e/conformance/${e.suite}`,
      target: e.bindingCheck ? String(e.binding) : 'powershell',
      exitCode: exp.exitCode,
      diagnostics: (exp.diagnostics ?? []).map((d: ExpectedDiagnostic) =>
        ({ code: d.code, severity: d.severity, line: d.line, column: d.column })),
    });
  }
  return { entries, excluded };
}

export const sig = (d: ExpectedDiagnostic): string => `${d.code} ${d.severity} ${d.line}:${d.column}`;
