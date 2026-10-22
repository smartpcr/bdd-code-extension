// The command line for each verb and binding (plan 2.4 item 3, B2.1). Pure:
// every function returns a ToolCommand and starts nothing.
import * as path from 'path';
import { ResolvedBinding } from '../config/layout';
import {
  ACTIONS_TIMEOUT_MS, BUILD_TIMEOUT_MS, LINT_TIMEOUT_MS, LIST_TIMEOUT_MS, MAX_TOOL_OUTPUT_BYTES,
} from '../limits';
import { ToolCommand } from './runTool';

const BINDING_NAME = /^[a-z][a-z0-9]*$/;

/** `--schema-root <catalog folder>` for a catalog outside test/e2e/schema (ResolvedBinding.schemaRoot); nothing otherwise. */
const schemaRootArgs = (binding: ResolvedBinding): string[] => (binding.schemaRoot ? ['--schema-root', binding.schemaRoot] : []);

/** argv[0] made absolute when it is a path (has a separator), so cwd never decides which program runs. */
function program(binding: ResolvedBinding, root: string): string[] {
  const [first, ...rest] = binding.tool;
  if (first === undefined) return [];
  return [/[\\/]/.test(first) && !path.isAbsolute(first) ? path.resolve(root, first) : first, ...rest];
}

export function lintCommand(binding: ResolvedBinding, root: string, rel: string, target: string): ToolCommand {
  if (!BINDING_NAME.test(target)) throw new Error(`Not a binding name: ${target}`);
  const argv = [...program(binding, root), 'lint', '--path', rel, '--json', '--binding-check', '--binding', target, ...schemaRootArgs(binding)];
  return { argv, cwd: root, timeoutMs: LINT_TIMEOUT_MS, maxStdout: MAX_TOOL_OUTPUT_BYTES };
}

export function actionsCommand(binding: ResolvedBinding, root: string): ToolCommand {
  return { argv: [...program(binding, root), 'actions', '--json', ...schemaRootArgs(binding)], cwd: root, timeoutMs: ACTIONS_TIMEOUT_MS, maxStdout: MAX_TOOL_OUTPUT_BYTES };
}

/** `--test-name <case>` when the binding runs one case by name and one is chosen; nothing otherwise. */
const oneCase = (binding: ResolvedBinding, testName: string | undefined): string[] =>
  (binding.selectsOneCase && testName ? ['--test-name', testName] : []);

/**
 * The cases a run will start, for a lab run's confirmation. `testName` is the
 * one case a binding that selects one case runs (as `runCommand`), so the list
 * shows only it.
 */
export function listCommand(binding: ResolvedBinding, root: string, rel: string, tags: string[], testName?: string): ToolCommand {
  const argv = [...program(binding, root), 'list', '--path', rel, ...(tags.length ? ['--tags', tags.join(',')] : []), ...oneCase(binding, testName), ...schemaRootArgs(binding)];
  return { argv, cwd: root, timeoutMs: LIST_TIMEOUT_MS, maxStdout: MAX_TOOL_OUTPUT_BYTES };
}

export interface LabValues {
  apiUrl?: string;
  labId?: string;
  connectionFile?: string;
}

export interface RunOptions {
  traceFile: string;
  resultsFile: string;
  dryRun?: boolean;
  tags?: string[];
  /** One case by name; passed only to a binding with `selectsOneCase` (B6.2 item 3). */
  testName?: string;
  /** Set for a lab suite (B6.4); each value is passed when it is given. */
  lab?: LabValues;
}

/** A suite run: no timeout (plan 2.6), output streamed and never capped. */
export function runCommand(binding: ResolvedBinding, root: string, rel: string, o: RunOptions): ToolCommand {
  // An offline run passes no lab flags (DEC-S11): the program needs none to run offline actions.
  const lab = o.lab ?? {};
  const argv = [...program(binding, root), 'run', '--path', rel, '--trace-file', o.traceFile, '--results', o.resultsFile, '--format', 'nunit3',
    ...(o.tags?.length ? ['--tags', o.tags.join(',')] : []), ...oneCase(binding, o.testName), ...(o.dryRun ? ['--dry-run'] : []),
    ...(lab.apiUrl ? ['--api-url', lab.apiUrl] : []), ...(lab.labId ? ['--lab-id', lab.labId] : []),
    ...(lab.connectionFile ? ['--connection-file', lab.connectionFile] : []), ...schemaRootArgs(binding)];
  return { argv, cwd: root, timeoutMs: 0, maxStdout: MAX_TOOL_OUTPUT_BYTES, streamOnly: true };
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

/**
 * The file a binding runs, resolved: its program, or the script its program
 * runs (`node dist/cli.js`, `pwsh -File scripts/e2e/suiterun.ps1`). Used to
 * tell "not built" apart, to create its folder before a build, and to check a
 * run's runner before a run asks anything. Undefined when the program is a
 * bare command found on PATH, which only starting it can check.
 */
export function programPath(binding: ResolvedBinding, root: string): string | undefined {
  const p = program(binding, root);
  const candidate = p.find(a => /[\\/]/.test(a) && !a.startsWith('-'));
  return candidate && path.resolve(root, candidate);
}
