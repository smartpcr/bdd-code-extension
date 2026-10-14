// Commands (plan B2.1, B2.3, B2.4).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TrustGate } from '../config/trust';
import { toMarkdownTable } from '../core/coverage';
import { parseActionsOutput } from '../core/diagnostics';
import { MAX_STDERR_BYTES } from '../limits';
import { actionsCommand, buildCommand, programPath } from '../tools/profiles';
import { runTool, ToolResult } from '../tools/runTool';
import { CoverageView } from './coverageView';
import { FolderIndexer } from './indexer';
import { LintController } from './lintController';

export interface CommandHost {
  indexers(): FolderIndexer[];
  controllers(): LintController[];
  log(line: string): void;
  show(): void;
  gate: TrustGate;
  coverage: CoverageView;
}

function describe(r: ToolResult): string {
  if (r.kind === 'exited') return `exit code ${r.code}`;
  if (r.kind === 'failure') return `${r.reason}: ${r.detail}`;
  return 'cancelled';
}

/** Print what a binding's program says it implements (B2.1's deliverable). */
export async function showActions(host: CommandHost, bindingName: string): Promise<string[] | undefined> {
  const ix = host.indexers()[0];
  const binding = ix?.layout.bindings.find(b => b.name === bindingName);
  if (!ix || !binding) return undefined;
  const r = await runTool(actionsCommand(binding, ix.layout.root), undefined,
    { gate: () => host.gate.canRunWorkspaceCode(), maxStderr: MAX_STDERR_BYTES });
  const parsed = r.kind === 'exited' && r.code === 0 ? parseActionsOutput(r.stdout) : undefined;
  if (parsed?.ok) {
    host.log(`${binding.label} implements ${parsed.value.length} actions: ${parsed.value.join(', ')}`);
    return parsed.value;
  }
  host.log(`Could not ask ${binding.label} which actions it implements (${parsed ? parsed.detail : describe(r)}).`
    + (r.kind === 'cancelled' ? '' : `\n  stderr: ${r.stderrTail.trim()}`));
  return undefined;
}

/** Build the lint tool's program, streaming its output to the channel (B2.4-4). */
export async function buildLintTool(host: CommandHost, bindingName?: string): Promise<boolean> {
  const ix = host.indexers()[0];
  const name = bindingName ?? ix?.layout.settings.lintTool;
  const binding = ix?.layout.bindings.find(b => b.name === name);
  const cmd = binding && buildCommand(binding, ix!.layout.root);
  if (!ix || !binding || !cmd) {
    host.log(`No build command is configured for ${name}.`);
    return false;
  }
  const program = programPath(binding, ix.layout.root);
  if (program) fs.mkdirSync(path.dirname(program), { recursive: true });
  host.show();
  host.log(`Building ${binding.label}: ${cmd.argv[0]} (in ${cmd.cwd})`);
  const r = await runTool({ ...cmd, onOutput: t => host.log(t.trimEnd()) }, undefined,
    { gate: () => host.gate.canRunWorkspaceCode(), maxStderr: MAX_STDERR_BYTES });
  const ok = r.kind === 'exited' && r.code === 0 && (!program || fs.existsSync(program));
  host.log(ok ? `Built ${binding.label}.` : `Building ${binding.label} failed (${describe(r)}).`);
  if (ok) for (const c of host.controllers()) c.lintOpen();
  return ok;
}

async function pickBinding(host: CommandHost, placeHolder: string): Promise<string | undefined> {
  const ix = host.indexers()[0];
  if (!ix) return undefined;
  const pick = await vscode.window.showQuickPick(ix.layout.bindings.map(b => ({ label: b.label, description: b.name })), { placeHolder });
  return pick?.description;
}

export function registerCommands(host: CommandHost): vscode.Disposable[] {
  const setSetting = async (key: string, value: string) =>
    vscode.workspace.getConfiguration('bddSuite').update(key, value,
      vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  return [
    vscode.commands.registerCommand('bddSuite.showActions', async (name?: string) => {
      const binding = name ?? await pickBinding(host, 'Which binding should say what it implements?');
      host.show();
      return binding ? showActions(host, binding) : undefined;
    }),
    vscode.commands.registerCommand('bddSuite.buildLintTool', (name?: string) => buildLintTool(host, name)),
    vscode.commands.registerCommand('bddSuite.chooseLintTool', async () => {
      const b = await pickBinding(host, 'Lint with which binding?');
      if (b) await setSetting('lintTool', b);
    }),
    vscode.commands.registerCommand('bddSuite.chooseTargetBinding', async () => {
      const b = await pickBinding(host, 'Which binding will run these suites?');
      if (b) await setSetting('targetBinding', b);
    }),
    vscode.commands.registerCommand('bddSuite.configureLint', async () => {
      const pick = await vscode.window.showQuickPick(['Choose the lint tool', 'Choose the target binding', 'Build the lint tool']);
      if (pick === 'Choose the lint tool') await vscode.commands.executeCommand('bddSuite.chooseLintTool');
      if (pick === 'Choose the target binding') await vscode.commands.executeCommand('bddSuite.chooseTargetBinding');
      if (pick === 'Build the lint tool') await vscode.commands.executeCommand('bddSuite.buildLintTool');
    }),
    vscode.commands.registerCommand('bddSuite.verifyBindingPrograms', () => host.coverage.verify()),
    vscode.commands.registerCommand('bddSuite.copyBindingTable', async () => {
      const text = toMarkdownTable(host.coverage.rows());
      await vscode.env.clipboard.writeText(text);
      return text;
    }),
  ];
}
