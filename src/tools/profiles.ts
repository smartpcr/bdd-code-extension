// The command line for each verb and binding (plan 2.4 item 3, B2.1). Pure:
// every function returns a ToolCommand and starts nothing.
import * as path from 'path';
import { ResolvedBinding } from '../config/layout';
import {
  ACTIONS_TIMEOUT_MS, BUILD_TIMEOUT_MS, LINT_TIMEOUT_MS, LIST_TIMEOUT_MS, MAX_TOOL_OUTPUT_BYTES,
} from '../limits';
import { ToolCommand } from './runTool';

/** A PowerShell single-quoted string literal. */
export const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

const BINDING_NAME = /^[a-z][a-z0-9]*$/;

/** argv[0] made absolute when it is a path (has a separator), so cwd never decides which program runs. */
function program(binding: ResolvedBinding, root: string): string[] {
  const [first, ...rest] = binding.tool;
  if (first === undefined) return [];
  return [/[\\/]/.test(first) && !path.isAbsolute(first) ? path.resolve(root, first) : first, ...rest];
}

function powershell(binding: ResolvedBinding, script: string): string[] {
  return [...binding.tool, '-Command', script];
}

export function lintCommand(binding: ResolvedBinding, root: string, rel: string, target: string): ToolCommand {
  if (!BINDING_NAME.test(target)) throw new Error(`Not a binding name: ${target}`);
  const argv = binding.kind === 'powershell'
    ? powershell(binding, [
      "$ErrorActionPreference = 'Stop'",
      `Import-Module -Force (Join-Path ${psQuote(root)} 'scripts/e2e/SuiteLint.psm1')`,
      `$d = @(Invoke-SuiteLint -Path @(${psQuote(rel)}) -Binding ${psQuote(target)} -BindingCheck -RepositoryRoot ${psQuote(root)})`,
      'ConvertTo-Json -InputObject $d -Depth 5 -Compress',
    ].join('; '))
    : [...program(binding, root), 'lint', '--path', rel, '--json', '--binding-check', '--binding', target];
  return { argv, cwd: root, timeoutMs: LINT_TIMEOUT_MS, maxStdout: MAX_TOOL_OUTPUT_BYTES };
}

export function actionsCommand(binding: ResolvedBinding, root: string): ToolCommand {
  const argv = binding.kind === 'powershell'
    ? powershell(binding, [
      "$ErrorActionPreference = 'Stop'",
      `. (Join-Path ${psQuote(root)} 'scripts/e2e/actions/ActionRegistry.ps1')`,
      'ConvertTo-Json -InputObject @(Get-LabActionNames) -Compress',
    ].join('; '))
    : [...program(binding, root), 'actions', '--json'];
  return { argv, cwd: root, timeoutMs: ACTIONS_TIMEOUT_MS, maxStdout: MAX_TOOL_OUTPUT_BYTES };
}

export function listCommand(binding: ResolvedBinding, root: string, rel: string, tags: string[]): ToolCommand {
  const argv = binding.kind === 'powershell'
    ? powershell(binding, `& (Join-Path ${psQuote(root)} 'scripts/e2e/Invoke-LabTestSuite.ps1') -Path ${psQuote(rel)} -DryRun`
      + (tags.length ? ` -Tags ${psQuote(tags.join(','))}` : ''))
    : [...program(binding, root), 'list', '--path', rel, ...(tags.length ? ['--tags', tags.join(',')] : [])];
  return { argv, cwd: root, timeoutMs: LIST_TIMEOUT_MS, maxStdout: MAX_TOOL_OUTPUT_BYTES };
}

/** A build is a fixed string from settings run by a shell (plan 2.4: npm.cmd needs one on Windows). */
export function buildCommand(binding: ResolvedBinding, root: string): ToolCommand | undefined {
  if (!binding.build) return undefined;
  return {
    argv: [binding.build.command],
    cwd: path.resolve(root, binding.build.cwd),
    shell: true,
    timeoutMs: BUILD_TIMEOUT_MS,
    maxStdout: MAX_TOOL_OUTPUT_BYTES,
  };
}

/** The program a binding runs, resolved; used to tell "not built" apart and to create its folder before a build. */
export function programPath(binding: ResolvedBinding, root: string): string | undefined {
  if (binding.kind === 'powershell') return undefined;
  const p = program(binding, root);
  const candidate = p.find(a => /[\\/]/.test(a) && !a.startsWith('-'));
  return candidate && path.resolve(root, candidate);
}
