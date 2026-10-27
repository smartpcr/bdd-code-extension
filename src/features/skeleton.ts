// *Suite: Create suites workspace skeleton*: a new workspace from the shipped
// templates (templates/skeleton), with any of bddSuite.templatesDir/skeleton
// over them: its settings, catalog, first suite and one binding per language,
// then the generated schema. Available with or without a catalog in the window.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { expandArgv } from '../config/bundled';
import { DEFAULT_SETTINGS } from '../config/defaults';
import { TrustGate } from '../config/trust';
import { fileKey } from '../core/paths';
import {
  BUILD_OUTPUT_DIRS, isSkeletonLanguage, overlayTemplates, planSkeleton, SKELETON_LANGUAGES, SkeletonLanguage, skeletonNameProblem, skeletonParts,
  suggestSkeletonName, TemplateFile,
} from '../core/skeleton';
import { MAX_STDERR_BYTES, MAX_TOOL_OUTPUT_BYTES, SCHEMA_TIMEOUT_MS } from '../limits';
import { runTool } from '../tools/runTool';

export interface SkeletonHost {
  log(line: string): void;
  show(): void;
  gate: TrustGate;
  extensionPath: string;
  /** The extension's version: the bdd-suite release the new workspace's packages are pinned to. */
  version: string;
}

/** What the command may be given instead of asking: by the tests, or by another command. */
export interface SkeletonArgs {
  target?: string;
  /** In order: the first is the target binding and the lint tool. */
  languages?: string[];
  name?: string;
  /** false: never offer to open the new folder. */
  open?: boolean;
}

export interface SkeletonResult {
  ok: boolean;
  message: string;
  /** Written, relative to the target, with `/` separators. */
  files: string[];
  /** There already, and kept as they were. */
  skipped: string[];
  /** How the schema generator ended: `exit 0`, or why not. */
  generator?: string;
}

const CATALOG = 'schema/actions.catalog.yaml';

/** Every file under `dir` but build output, relative to it with `/` separators and LF line ends; none when it does not exist. */
function readTemplateDir(dir: string, under = ''): TemplateFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, under), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap(e => {
    const rel = under ? `${under}/${e.name}` : e.name;
    if (e.isDirectory()) return BUILD_OUTPUT_DIRS.has(e.name) ? [] : readTemplateDir(dir, rel);
    return [{ path: rel, text: fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n') }];
  });
}

/** The first workspace folder's bddSuite.templatesDir, resolved; undefined when none sets one. */
function ownTemplatesDir(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const dir = vscode.workspace.getConfiguration('bddSuite', folder.uri).get<string>('templatesDir');
    if (dir) return path.resolve(folder.uri.fsPath, dir, 'skeleton');
  }
  return undefined;
}

export function registerSkeletonCommand(host: SkeletonHost): vscode.Disposable {
  return vscode.commands.registerCommand('bddSuite.createSkeleton', (args?: SkeletonArgs) => createSkeleton(host, args ?? {}));
}

async function chooseTarget(args: SkeletonArgs): Promise<string | undefined> {
  if (args.target) return path.resolve(args.target);
  const picked = await vscode.window.showOpenDialog({
    title: 'Suite: the folder of the new suites workspace (an empty one, or one with no catalog yet)',
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Create the skeleton here',
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  return picked?.[0]?.fsPath;
}

async function chooseLanguages(args: SkeletonArgs): Promise<SkeletonLanguage[] | string | undefined> {
  if (args.languages) {
    const unknown = args.languages.filter(l => !isSkeletonLanguage(l));
    return unknown.length ? `There is no skeleton for ${unknown.join(', ')}; there is one for ${SKELETON_LANGUAGES.map(l => l.id).join(', ')}.`
      : args.languages as SkeletonLanguage[];
  }
  const picked = await vscode.window.showQuickPick(
    SKELETON_LANGUAGES.map(l => ({ label: l.label, description: l.description, id: l.id, picked: l.id === 'csharp' })),
    { title: 'Suite: the binding languages of the new workspace', canPickMany: true, ignoreFocusOut: true });
  if (!picked?.length) return undefined;
  if (picked.length === 1) return [picked[0].id];
  // Of several, the one suites run with comes first: it is the target binding and the lint tool.
  const first = await vscode.window.showQuickPick(picked.map(p => ({ label: p.label, id: p.id })),
    { title: 'Suite: which binding do the suites run with (the target binding)?', ignoreFocusOut: true });
  return first && [first.id, ...picked.map(p => p.id).filter(id => id !== first.id)];
}

async function chooseName(args: SkeletonArgs, target: string): Promise<string | undefined> {
  if (args.name !== undefined) return args.name;
  return vscode.window.showInputBox({
    title: 'Suite: the name of the new suites',
    prompt: 'The first suite\'s name, and the binding\'s namespace (order-service is OrderService) and action family (orderService.*).',
    value: suggestSkeletonName(path.basename(target)) ?? 'suites',
    validateInput: v => skeletonNameProblem(v),
    ignoreFocusOut: true,
  });
}

async function report(host: SkeletonHost, r: SkeletonResult): Promise<SkeletonResult> {
  host.log(r.message);
  if (r.ok) void vscode.window.showInformationMessage(r.message);
  else void vscode.window.showWarningMessage(r.message);
  return r;
}

const refused = (message: string): SkeletonResult => ({ ok: false, message, files: [], skipped: [] });

export async function createSkeleton(host: SkeletonHost, args: SkeletonArgs): Promise<SkeletonResult> {
  const interactive = args.target === undefined;
  const target = await chooseTarget(args);
  if (!target) return refused('Create suites workspace skeleton: no folder chosen.');
  const languages = await chooseLanguages(args);
  if (typeof languages === 'string') return report(host, refused(`Create suites workspace skeleton: ${languages}`));
  if (!languages) return refused('Create suites workspace skeleton: no language chosen.');
  const name = await chooseName(args, target);
  if (name === undefined) return refused('Create suites workspace skeleton: no name given.');

  const own = ownTemplatesDir();
  const shipped = path.join(host.extensionPath, 'templates', 'skeleton');
  const plan = planSkeleton({
    name, languages, version: host.version,
    templates: part => overlayTemplates(readTemplateDir(path.join(shipped, part)), own ? readTemplateDir(path.join(own, part)) : []),
  });
  if ('refused' in plan) return report(host, refused(`Create suites workspace skeleton: ${plan.refused}`));
  if (own) host.log(`Create suites workspace skeleton: templates from ${own} over the shipped ones, for ${skeletonParts(languages).join(', ')}.`);

  // A folder with a catalog is a suites workspace already; its other files are never overwritten.
  if (fs.existsSync(path.join(target, CATALOG))) {
    return report(host, refused(`Create suites workspace skeleton: ${path.join(target, CATALOG)} exists; this folder is a suites workspace already.`));
  }
  const skipped = plan.files.filter(f => fs.existsSync(path.join(target, f.path))).map(f => f.path);
  if (skipped.length && interactive) {
    const shown = skipped.slice(0, 8).join(', ') + (skipped.length > 8 ? ', ...' : '');
    const go = await vscode.window.showWarningMessage(`${skipped.length} of the skeleton's files exist in ${target} and are kept as they are: ${shown}. Create the others?`,
      { modal: true }, 'Create the others');
    if (go !== 'Create the others') return refused('Create suites workspace skeleton: cancelled.');
  }
  const files: string[] = [];
  for (const f of plan.files) {
    if (skipped.includes(f.path)) continue;
    const file = path.join(target, f.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // wx: a file that appeared since the check is kept too.
    try {
      fs.writeFileSync(file, f.text, { flag: 'wx' });
      files.push(f.path);
    } catch {
      skipped.push(f.path);
    }
  }
  host.log(`Create suites workspace skeleton in ${target} (${languages.join(', ')}, ${plan.names.name}): wrote ${files.join(', ')}${skipped.length ? `; kept ${skipped.join(', ')}` : ''}.`);

  // The schema the editor and every suiterun check suites against, from the new catalog.
  const run = await runTool({
    argv: expandArgv(DEFAULT_SETTINGS.schemaGenerator, CATALOG, host.extensionPath), cwd: target, timeoutMs: SCHEMA_TIMEOUT_MS, maxStdout: MAX_TOOL_OUTPUT_BYTES,
  }, undefined, { gate: () => host.gate.canRunWorkspaceCode(), maxStderr: MAX_STDERR_BYTES });
  const generator = run.kind === 'exited' ? `exit ${run.code}` : run.kind === 'failure' ? `${run.reason}: ${run.detail}` : 'cancelled';
  if (run.kind === 'exited') host.log((run.stdout + run.stderrTail).trimEnd());
  const generated = run.kind === 'exited' && run.code === 0;

  const message = `Created the ${plan.names.name} suites workspace in ${target} (${languages.join(', ')})`
    + (skipped.length ? `, keeping ${skipped.length} file(s) that were there` : '')
    + (generated ? '.' : `; the schema generator did not finish (${generator}): run Suite: Regenerate the schema there.`);
  const result: SkeletonResult = { ok: true, message, files, skipped, generator };
  await report(host, result);

  // A folder open as a workspace folder picks its new settings up by itself; any other is offered.
  const open = (vscode.workspace.workspaceFolders ?? []).some(f => fileKey(f.uri.fsPath) === fileKey(target));
  if (args.open !== false && !open) {
    const choice = await vscode.window.showInformationMessage(`Open ${target}? Its settings apply when it is the workspace folder.`,
      'Open Folder', 'Open in New Window', 'Add to Workspace');
    const uri = vscode.Uri.file(target);
    if (choice === 'Open Folder') await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
    if (choice === 'Open in New Window') await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    if (choice === 'Add to Workspace') vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri });
  }
  return result;
}
