import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import type { LintEvent } from '../../../src/features/lintController';
import { api, within } from './helpers';

/** Set a bddSuite setting and wait until the rebuilt controllers use it. */
export async function setting(key: string, value: unknown, target: vscode.ConfigurationTarget, settled: (a: TestApi) => boolean): Promise<TestApi> {
  await vscode.workspace.getConfiguration('bddSuite').update(key, value, target);
  const a = await api();
  await within(20_000, () => a.controllers.length > 0 && settled(a));
  await a.ready;
  return a;
}

/** Lint a file now through the current controller and return the event. */
export async function lint(uri: vscode.Uri): Promise<LintEvent> {
  const a = await api();
  await a.ready;
  let event = await a.controllers[0].lintNow(uri);
  // A settings rebuild replaced the controller mid-lint (superseded), or the
  // lint that opening the file schedules after LINT_DEBOUNCE_MS started and
  // cancelled this one (B2.2-3); ask again so the answer is a finished lint.
  for (let tries = 0; tries < 3 && (event.outcome === 'superseded' || event.outcome === 'cancelled'); tries++) {
    await a.ready;
    event = await a.controllers[0].lintNow(uri);
  }
  return event;
}

/** The lint diagnostics shown for a file, as "CODE severity line:column" with one-based positions. */
export function shown(uri: vscode.Uri): { sig: string; message: string; source: string }[] {
  return vscode.languages.getDiagnostics(uri)
    .filter(d => (d.source ?? '').startsWith('suiterun:'))
    .map(d => ({
      sig: `${d.code} ${d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'} ${d.range.start.line + 1}:${d.range.start.character + 1}`,
      message: d.message,
      source: d.source!,
    }));
}

/** Wait for the next lint event for `file` (fsPath compared case-insensitively). */
export function nextLint(file: string, ms = 30_000): Promise<LintEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no lint of ${file} within ${ms} ms`)), ms);
    void api().then(a => {
      const subs = a.controllers.map(c => c.onDidLint(e => {
        if (e.file.toLowerCase() === file.toLowerCase()) {
          clearTimeout(timer);
          subs.forEach(s => s.dispose());
          resolve(e);
        }
      }));
    });
  });
}
