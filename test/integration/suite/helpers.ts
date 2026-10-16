import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import { BindingName, samplePrograms } from '../harness/sample';

export async function api(): Promise<TestApi> {
  const ext = vscode.extensions.getExtension('asz.bdd-suite');
  assert.ok(ext, 'the extension is installed in the test instance');
  const a = (await ext.activate()) as TestApi;
  await a.ready;
  return a;
}

export const folder = (): string => process.env.BDD_FOLDER!;
export const at = (...parts: string[]): vscode.Uri => vscode.Uri.file(path.join(folder(), ...parts));
/** The main checkout's samples/workspace; the worktree session's folder starts as a copy of it. */
export const mainSample = (): string => process.env.BDD_SAMPLE_ROOT!;
/**
 * A binding's program as runTest built it in the main sample (Go's in the test
 * profile's storage). The worktree has no build output, so a worktree test that
 * needs a real program sets the binding's `tool` to this.
 */
export const mainProgram = (binding: BindingName): string[] => {
  const argv = samplePrograms(mainSample())[binding];
  // In the extension host process.execPath is VS Code itself, not node.
  return binding === 'typescript' ? ['node', ...argv.slice(1)] : argv;
};

/** The repository root of the session's folder (the folder is <root>/samples/workspace). */
export const repoOf = (): string => path.resolve(folder(), '..', '..');
const SAMPLE_REL = 'samples/workspace';
const gitIn = (...args: string[]): string => execFileSync('git', ['-C', repoOf(), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * `git status --porcelain` of the session's sample only, run at the repository
 * root so its paths (relative to that root) are what git means.
 */
export const sampleStatus = (): string => gitIn('status', '--porcelain', '--untracked-files=all', '--', SAMPLE_REL);

/**
 * Every file git sees under the session's sample (tracked or untracked, not
 * ignored) with its content. While samples/ is uncommitted every file there is
 * untracked, so `git status` alone cannot tell an edited file from an unedited
 * one; the contents can.
 */
export function sampleSnapshot(): Map<string, Buffer> {
  const files = gitIn('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', SAMPLE_REL).split('\0').filter(Boolean);
  const out = new Map<string, Buffer>();
  // The folder's .vscode/settings.json is the editor's state, which tests set and unset; not the sample's content.
  for (const rel of files.filter(f => !f.startsWith(`${SAMPLE_REL}/.vscode/`))) {
    const file = path.join(repoOf(), rel);
    if (fs.existsSync(file)) out.set(file, fs.readFileSync(file));
  }
  return out;
}

/** Put the sample back to `snapshot`: files added since are removed, changed or removed ones rewritten. Returns what it touched. */
export function restoreSample(snapshot: Map<string, Buffer>): string[] {
  const touched: string[] = [];
  for (const file of sampleSnapshot().keys()) {
    if (!snapshot.has(file)) {
      fs.rmSync(file, { force: true });
      touched.push(`removed ${file}`);
    }
  }
  for (const [file, content] of snapshot) {
    if (!fs.existsSync(file) || !fs.readFileSync(file).equals(content)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      touched.push(`restored ${file}`);
    }
  }
  return touched;
}

/** The files whose content differs from `snapshot` (added, removed or changed). */
export function sampleChanges(snapshot: Map<string, Buffer>): string[] {
  const now = sampleSnapshot();
  return [...new Set([...now.keys(), ...snapshot.keys()])]
    .filter(f => !now.has(f) || !snapshot.has(f) || !now.get(f)!.equals(snapshot.get(f)!)).sort();
}
/** Whether the folder carries the TypeScript binding (B7); the sample always does. */
export const hasTypeScript = (): boolean => fs.existsSync(path.join(folder(), 'test', 'e2e', 'bindings', 'typescript', 'src'));

export async function open(uri: vscode.Uri): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument(uri);
}

/** Discard a buffer's unsaved edits, never writing the file. */
export async function revert(uri: vscode.Uri): Promise<void> {
  const doc = await open(uri);
  if (!doc.isDirty) return;
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  assert.strictEqual(doc.isDirty, false, `${uri.fsPath} was not reverted`);
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
