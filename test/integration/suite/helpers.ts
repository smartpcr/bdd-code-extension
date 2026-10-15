import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';

export async function api(): Promise<TestApi> {
  const ext = vscode.extensions.getExtension('local.bdd-suite');
  assert.ok(ext, 'the extension is installed in the test instance');
  const a = (await ext.activate()) as TestApi;
  await a.ready;
  return a;
}

export const folder = (): string => process.env.BDD_FOLDER!;
export const at = (...parts: string[]): vscode.Uri => vscode.Uri.file(path.join(folder(), ...parts));
/** Whether the checkout carries the TypeScript binding (B7); its halves run only then. */
export const hasTypeScript = (): boolean => fs.existsSync(path.join(folder(), 'test', 'e2e', 'bindings', 'typescript', 'src'));

export async function open(uri: vscode.Uri): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument(uri);
}

/** Position inside the `occurrence`-th match of `needle` (offset chars into it). */
export function find(doc: vscode.TextDocument, needle: string | RegExp, offset = 0, occurrence = 0): vscode.Position {
  const text = doc.getText();
  const re = typeof needle === 'string' ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : new RegExp(needle.source, 'g');
  const matches = [...text.matchAll(re)];
  assert.ok(matches[occurrence], `${needle} not found (occurrence ${occurrence}) in ${doc.uri.fsPath}`);
  return doc.positionAt(matches[occurrence].index! + offset);
}

export const key = (uri: vscode.Uri | string): string =>
  (typeof uri === 'string' ? uri : uri.fsPath).toLowerCase();

export function asLocations(results: (vscode.Location | vscode.LocationLink)[] | undefined): vscode.Location[] {
  return (results ?? []).map(r => ('targetUri' in r ? new vscode.Location(r.targetUri, r.targetRange) : r));
}

export async function lineText(loc: vscode.Location): Promise<string> {
  return (await vscode.workspace.openTextDocument(loc.uri)).lineAt(loc.range.start.line).text;
}

export async function hoverText(uri: vscode.Uri, pos: vscode.Position): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, pos);
  return hovers.flatMap(h => h.contents.map(c => (typeof c === 'string' ? c : c.value))).join('\n---\n');
}

/** Poll `check` until it returns true or `ms` passes; returns the elapsed time. */
export async function within(ms: number, check: () => Promise<boolean> | boolean): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (await check()) return Date.now() - started;
    if (Date.now() - started > ms) throw new Error(`not true within ${ms} ms`);
    await new Promise(r => setTimeout(r, 25));
  }
}
