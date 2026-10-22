// Declaring and implementing an action from the editor (plan B5.1-B5.4,
// DEC-B10): the quick fix on E104, *Implement in binding*, and the edits each
// one applies as a single WorkspaceEdit before the schema generator runs.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SUITE_DOCUMENTS } from './suiteLanguage';
import { TrustGate } from '../config/trust';
import { parseCatalog } from '../core/catalog';
import { addBindingEdit, commonStepKeys, FileEdit, planDeclare } from '../core/catalogEdit';
import { missingImplementations, workspaceBindings } from '../core/coverage';
import { csharpHandlerClass, planStub, powershellStubFile, registryFileOf, renderTemplate, stubTarget } from '../core/stubs';
import { parseSuite } from '../core/suites';
import { Pos, StepInfo } from '../core/types';
import { contains } from '../core/workspaceIndex';
import { MAX_STDERR_BYTES, MAX_TOOL_OUTPUT_BYTES, SCHEMA_TIMEOUT_MS } from '../limits';
import { runTool } from '../tools/runTool';
import { FolderIndexer, toRange } from './indexer';

/** What a scaffolding command did, for its caller and for the tests. */
export interface ScaffoldResult {
  ok: boolean;
  message: string;
  /** The files the edit touched or created. */
  files: string[];
  /** How the schema generator ended: `exit 0`, or why not. */
  generator?: string;
}

export interface ScaffoldHost {
  owner(uri: vscode.Uri): FolderIndexer | undefined;
  indexers(): FolderIndexer[];
  log(line: string): void;
  show(): void;
  gate: TrustGate;
  extensionPath: string;
}

type Owner = (uri: vscode.Uri) => FolderIndexer | undefined;

const codeOf = (d: vscode.Diagnostic) => String(typeof d.code === 'object' ? d.code.value : d.code);

/**
 * The document's steps as its text is now. The index trails the buffer by
 * INDEX_DEBOUNCE_MS and a file created a moment ago may not be in it yet, while
 * a quick fix answers for the diagnostic the user is looking at.
 */
function liveSteps(doc: vscode.TextDocument): StepInfo[] {
  return parseSuite(doc.getText(), doc.uri.fsPath).steps;
}

function stepAt(steps: StepInfo[], pos: Pos): StepInfo | undefined {
  return steps.filter(s => contains(s.range, pos))
    .sort((a, b) => (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line))[0];
}

/** The quick fix *Declare action* on E104 (any source) and *Implement in* on a declared action's step. */
export function registerScaffoldActions(owner: Owner): vscode.Disposable {
  return vscode.languages.registerCodeActionsProvider(SUITE_DOCUMENTS, {
    provideCodeActions(doc, range, context) {
      const ix = owner(doc.uri);
      const catalog = ix?.index.catalog;
      if (!ix || !catalog) return [];
      const out: vscode.CodeAction[] = [];
      const declared = new Set<string>();
      if (ix.classify(doc.uri.fsPath)?.kind !== 'suite') return [];
      const steps = liveSteps(doc);
      for (const d of context.diagnostics) {
        if (codeOf(d) !== 'E104') continue;
        const name = stepAt(steps, d.range.start)?.action;
        if (!name || catalog.actions.has(name) || declared.has(name)) continue;
        declared.add(name);
        const fix = new vscode.CodeAction(`Declare action ${name}`, vscode.CodeActionKind.QuickFix);
        fix.diagnostics = [d];
        fix.isPreferred = true;
        fix.command = { title: fix.title, command: 'bddSuite.declareAction', arguments: [doc.uri, name] };
        out.push(fix);
      }
      const step = stepAt(steps, range.start);
      const entry = step?.action ? catalog.actions.get(step.action) : undefined;
      // An imported action (the core's, say) is implemented where it is declared, not in this workspace.
      if (entry && !entry.file) {
        const sites = ix.index.sitesFor(entry.name);
        for (const b of workspaceBindings(catalog.ownBindings, ix.layout.bindings)) {
          if (!stubTarget(b.name) || sites.some(s => s.binding === b.name)) continue;
          const act = new vscode.CodeAction(`Implement ${entry.name} in ${b.label}`, vscode.CodeActionKind.Refactor.append('bddSuite'));
          act.command = { title: act.title, command: 'bddSuite.implementAction', arguments: [entry.name, b.name] };
          out.push(act);
        }
      }
      return out;
    },
  }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor] });
}

/**
 * Above each step whose action is missing somewhere: which languages lack it,
 * and one click to implement it in each language with a stub template, or to
 * declare it when the catalog does not have it (setting `codeLens.implement`).
 */
export function registerImplementLens(owner: Owner, changed: vscode.Event<void>): vscode.Disposable {
  return vscode.languages.registerCodeLensProvider(SUITE_DOCUMENTS, {
    onDidChangeCodeLenses: changed,
    async provideCodeLenses(doc) {
      const ix = owner(doc.uri);
      await ix?.ready;
      const catalog = ix?.index.catalog;
      if (!ix || !catalog || !ix.layout.settings['codeLens.implement'] || !ix.index.isSuiteOrLibrary(doc.uri.fsPath)) return [];
      const rank = (b: string) => (catalog.bindings.includes(b) ? catalog.bindings.indexOf(b) : catalog.bindings.length);
      const bindings = workspaceBindings(catalog.ownBindings, [...ix.layout.bindings].sort((a, b) => rank(a.name) - rank(b.name)));
      const out: vscode.CodeLens[] = [];
      for (const step of liveSteps(doc)) {
        if (!step.action || !step.actionRange) continue;
        const action = step.action;
        const range = toRange(step.actionRange);
        if (!catalog.actions.has(action)) {
          out.push(new vscode.CodeLens(range, { title: `$(lightbulb) Declare action ${action}`, command: 'bddSuite.declareAction', arguments: [doc.uri, action] }));
          continue;
        }
        if (catalog.actions.get(action)!.file) continue;
        const registered = ix.index.sitesFor(action).map(s => s.binding);
        const { missing, generate } = missingImplementations(registered, bindings, b => !!stubTarget(b));
        if (!missing.length) continue;
        out.push(new vscode.CodeLens(range, { title: `Not implemented in ${missing.map(b => b.label).join(', ')}`, command: '' }));
        for (const b of generate) {
          out.push(new vscode.CodeLens(range, { title: `$(add) Implement in ${b.label}`, command: 'bddSuite.implementAction', arguments: [action, b.name] }));
        }
      }
      return out;
    },
  });
}

export function registerScaffoldCommands(host: ScaffoldHost): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('bddSuite.declareAction', (uri?: vscode.Uri, name?: string) => declareAction(host, uri, name)),
    vscode.commands.registerCommand('bddSuite.implementAction', (action?: string, binding?: string) => implementAction(host, action, binding)),
    vscode.commands.registerCommand('bddSuite.regenerateSchema', (uri?: vscode.Uri) => regenerateSchema(host, uri)),
  ];
}

const refused = (message: string): ScaffoldResult => ({ ok: false, message, files: [] });

async function report(host: ScaffoldHost, r: ScaffoldResult): Promise<ScaffoldResult> {
  host.log(r.message);
  if (r.ok) void vscode.window.showInformationMessage(r.message);
  else void vscode.window.showWarningMessage(r.message);
  return r;
}

/** A template from `bddSuite.templatesDir` when the workspace has one by that name, else the shipped one. */
function template(host: ScaffoldHost, ix: FolderIndexer, name: string): string {
  const dir = ix.layout.settings.templatesDir;
  const own = dir ? path.resolve(ix.layout.folder, dir, name) : undefined;
  return fs.readFileSync(own && fs.existsSync(own) ? own : path.join(host.extensionPath, 'templates', name), 'utf8');
}

/** bddSuite.schemaGenerator in the workspace root (by default the Build-Schema.ps1 the extension carries, D12); its output goes to the log. */
async function runGenerator(host: ScaffoldHost, ix: FolderIndexer): Promise<{ ok: boolean; generator: string }> {
  const run = await runTool({ argv: ix.layout.schemaGenerator, cwd: ix.layout.root, timeoutMs: SCHEMA_TIMEOUT_MS, maxStdout: MAX_TOOL_OUTPUT_BYTES },
    undefined, { gate: () => host.gate.canRunWorkspaceCode(), maxStderr: MAX_STDERR_BYTES });
  const generator = run.kind === 'exited' ? `exit ${run.code}` : run.kind === 'failure' ? `${run.reason}: ${run.detail}` : 'cancelled';
  if (run.kind === 'exited') host.log((run.stdout + run.stderrTail).trimEnd());
  return { ok: run.kind === 'exited' && run.code === 0, generator };
}

/** *Regenerate the schema*: the generator for the catalog of the active editor's folder, or of the only folder. */
async function regenerateSchema(host: ScaffoldHost, uri?: vscode.Uri): Promise<ScaffoldResult> {
  const at = uri ?? vscode.window.activeTextEditor?.document.uri;
  const ix = (at && host.owner(at)) ?? (host.indexers().length === 1 ? host.indexers()[0] : undefined);
  if (!ix) return report(host, refused('Regenerate the schema: open a suite or the catalog of the folder to regenerate.'));
  const { ok, generator } = await runGenerator(host, ix);
  const schema = path.relative(ix.layout.root, path.join(path.dirname(ix.layout.catalogPath), 'suite.schema.json'));
  return report(host, {
    ok, files: [],
    message: ok ? `Regenerate the schema: ${schema} was regenerated from ${path.relative(ix.layout.root, ix.layout.catalogPath)}.`
      : `Regenerate the schema: the schema generator did not finish (${generator}); see the Suite Authoring log.`,
  });
}

/** Applies the edits as one WorkspaceEdit (one undo), saves the files it changed, and runs the schema generator. */
async function applyAndGenerate(host: ScaffoldHost, ix: FolderIndexer, edits: FileEdit[], label: string): Promise<ScaffoldResult> {
  const edit = new vscode.WorkspaceEdit();
  const docs = new Map<string, vscode.TextDocument>();
  for (const e of edits) {
    const uri = vscode.Uri.file(e.file);
    if (e.create) {
      edit.createFile(uri, { overwrite: false, ignoreIfExists: false, contents: Buffer.from(e.text, 'utf8') });
      continue;
    }
    const doc = docs.get(e.file) ?? await vscode.workspace.openTextDocument(uri);
    docs.set(e.file, doc);
    edit.replace(uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
  }
  if (!await vscode.workspace.applyEdit(edit)) return report(host, refused(`${label}: the edit was not applied.`));
  for (const doc of docs.values()) await doc.save();
  const files = [...new Set(edits.map(e => e.file))];
  const { ok, generator } = await runGenerator(host, ix);
  const changed = files.map(f => path.relative(ix.layout.root, f)).join(', ');
  return report(host, {
    ok, files, generator,
    message: ok ? `${label}: changed ${changed}; the schema was regenerated.`
      : `${label}: changed ${changed}, but the schema generator did not finish (${generator}); run it before committing.`,
  });
}

/** *Declare action* (B5.1): the catalog entry, the PowerShell stub, the regenerated schema. */
/**
 * The keys every step may carry, from the first schema beside the catalog that
 * lists them: the generated suite.schema.json (extension fields included), or
 * the older suite.base.json. Undefined when neither does, or neither can be read.
 */
export function stepEnvelopeKeys(catalogFile: string): string[] | undefined {
  for (const name of ['suite.schema.json', 'suite.base.json']) {
    try {
      const keys = commonStepKeys(fs.readFileSync(path.join(path.dirname(catalogFile), name), 'utf8'));
      if (keys) return keys;
    } catch {
      // Missing, or unreadable for now (EMFILE while a window starts): try the next.
    }
  }
  return undefined;
}

export async function declareAction(host: ScaffoldHost, uri?: vscode.Uri, name?: string): Promise<ScaffoldResult> {
  const editor = vscode.window.activeTextEditor;
  const docUri = uri ?? editor?.document.uri;
  const ix = docUri && host.owner(docUri);
  if (!docUri || !ix?.index.catalog) return report(host, refused('Declare action: open a suite in a workspace with an actions catalog.'));
  const steps = liveSteps(await vscode.workspace.openTextDocument(docUri));
  const atCursor = editor && editor.document.uri.toString() === docUri.toString() ? stepAt(steps, editor.selection.active) : undefined;
  const step = (name ? [atCursor, ...steps].find(s => s?.action === name) : atCursor) ?? undefined;
  const action = name ?? step?.action;
  if (!action) return report(host, refused('Declare action: put the cursor on a step whose action is not declared.'));
  const catalogFile = ix.layout.catalogPath;
  const catalogDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(catalogFile));
  // Declared in this catalog's current text, or in a catalog it imports (DEC-S10): either way it needs no
  // declaring. Only imported entries come from the index, which lags an edit or an undo of this file.
  const declared = (n: string) => parseCatalog(catalogDoc.getText(), catalogFile).actions.has(n) || !!ix.index.catalog?.actions.get(n)?.file;
  // Before the stub: an action already declared is refused for that, whatever its stub's state.
  if (declared(action)) return report(host, refused(`Declare action: ${action} is already in the catalog.`));
  // The stub goes into the binding suites are meant to run with: a PowerShell file of
  // its own, or a registry entry and handler; none for a binding with no template.
  const binding = ix.layout.settings.targetBinding;
  let stub: FileEdit[] = [];
  let listed: string | undefined;
  if (binding === 'powershell') {
    const rel = powershellStubFile(action, ix.layout.bindings.find(b => b.name === binding)?.stubFile);
    const stubFile = path.join(ix.layout.root, rel);
    if (fs.existsSync(stubFile)) return report(host, refused(`Declare action: ${rel} already exists.`));
    stub = [{ file: stubFile, start: 0, end: 0, text: renderTemplate(template(host, ix, 'powershell.ps1.tmpl'), action), create: true }];
    listed = binding;
  } else if (stubTarget(binding)) {
    const planned = await registryStub(host, ix, action, binding);
    if ('refused' in planned) return report(host, refused(`Declare action: ${planned.refused}`));
    stub = planned.edits;
    listed = binding;
  }
  const plan = planDeclare({
    catalogFile,
    catalogText: catalogDoc.getText(),
    declared,
    name: action,
    stepParams: step?.params.map(p => ({ name: p.name, value: p.value })) ?? [],
    commonKeys: stepEnvelopeKeys(catalogFile),
    binding: listed,
    stub,
  });
  if ('refused' in plan) return report(host, refused(`Declare action: ${plan.refused}`));
  return applyAndGenerate(host, ix, plan.edits, `Declared ${action}`);
}

/**
 * The C# file in `dir` that declares `class <name>`: `<name>.cs` first, then the
 * others by name, so a partial class gets its stubs in its main file.
 */
function classFile(dir: string, name: string): string | undefined {
  const declares = new RegExp(`\\bclass ${name}\\b`);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.cs')).sort((a, b) => Number(b === `${name}.cs`) - Number(a === `${name}.cs`) || a.localeCompare(b));
  const found = files.find(f => declares.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  return found && path.join(dir, found);
}

/**
 * A binding's registry stub for an action (B5.2-B5.4): the registry entry and the
 * handler. The registry is where the binding's own actions already are, the
 * layout's default file until it has any; a qualified C# dictionary registry's
 * handler goes into the qualifying class's file.
 */
async function registryStub(host: ScaffoldHost, ix: FolderIndexer, action: string, binding: string): Promise<{ edits: FileEdit[] } | { refused: string }> {
  const target = stubTarget(binding);
  if (!target) return { refused: `there is no stub template for the ${binding} binding.` };
  const catalog = ix.index.catalog;
  const own = (a: string) => !!catalog?.actions.has(a) && !catalog.actions.get(a)!.file;
  const configured = ix.layout.bindings.find(b => b.name === binding)?.stubFile;
  const file = registryFileOf(ix.index.allSites(), binding, own) ?? path.join(ix.layout.root, configured ?? target.file);
  const shown = path.relative(ix.layout.root, file).split(path.sep).join('/');
  if (!fs.existsSync(file)) return { refused: `${shown} does not exist in this checkout.` };
  const registry = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const owner = binding === 'csharp' ? csharpHandlerClass(registry.getText()) : undefined;
  const handlerPath = owner ? classFile(path.dirname(file), owner) : undefined;
  const handlerFile = handlerPath ? { file: handlerPath, text: (await vscode.workspace.openTextDocument(vscode.Uri.file(handlerPath))).getText() } : undefined;
  return planStub({
    binding, action, file, shown, handlerFile, text: registry.getText(), template: template(host, ix, target.template),
    hasSite: ix.index.sitesFor(action).some(s => s.binding === binding),
  });
}

/** *Implement in binding* (B5.2-B5.4): the registry entry, the stub, the binding in the catalog, the schema. */
export async function implementAction(host: ScaffoldHost, action?: string, binding?: string): Promise<ScaffoldResult> {
  const editor = vscode.window.activeTextEditor;
  const ix = (editor && host.owner(editor.document.uri)) ?? host.indexers()[0];
  const catalog = ix?.index.catalog;
  if (!ix || !catalog) return report(host, refused('Implement action: this workspace has no actions catalog.'));
  action ??= editor && ix.index.isSuiteOrLibrary(editor.document.uri.fsPath) ? stepAt(liveSteps(editor.document), editor.selection.active)?.action : undefined;
  action ??= (await vscode.window.showQuickPick([...catalog.actions.keys()], { placeHolder: 'Which action should get a stub?' }));
  if (!action) return refused('Implement action: no action chosen.');
  const chosen = action;
  if (!binding) {
    const open = workspaceBindings(catalog.ownBindings, ix.layout.bindings).filter(b => stubTarget(b.name) && !ix.index.sitesFor(chosen).some(s => s.binding === b.name));
    binding = (await vscode.window.showQuickPick(open.map(b => ({ label: b.label, description: b.name })),
      { placeHolder: `Implement ${chosen} in which binding?` }))?.description;
    if (!binding) return refused('Implement action: no binding chosen.');
  }
  const catalogFile = ix.layout.catalogPath;
  const catalogDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(catalogFile));
  const current = parseCatalog(catalogDoc.getText(), catalogFile);
  const entry = current.actions.get(chosen);
  const imported = catalog.actions.get(chosen)?.file;
  if (!entry && imported) return report(host, refused(`Implement action: ${chosen} is declared in the imported catalog ${imported}, which this workspace does not edit.`));
  if (!entry) return report(host, refused(`Implement action: ${chosen} is not in the catalog; declare it first.`));
  const stub = await registryStub(host, ix, chosen, binding);
  if ('refused' in stub) return report(host, refused(`Implement action: ${stub.refused}`));
  const listed = addBindingEdit(catalogFile, catalogDoc.getText(), entry, binding, current.bindings);
  if (listed && 'refused' in listed) return report(host, refused(`Implement action: ${listed.refused}`));
  const label = ix.layout.bindings.find(b => b.name === binding)?.label ?? binding;
  return applyAndGenerate(host, ix, [...stub.edits, ...(listed ? [listed] : [])], `Implemented ${chosen} in ${label}`);
}
