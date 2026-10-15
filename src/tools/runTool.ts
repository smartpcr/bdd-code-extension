// The only code that starts processes (plan 2.4 items 4-6, B2.1, B2.6).
import * as cp from 'child_process';

export interface ToolCommand {
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 0 is no limit: a suite run (plan 2.6) ends when the suite does. */
  timeoutMs: number;
  maxStdout: number;
  /** Output goes to onOutput only, neither kept nor capped: a run must never be killed for printing (B6.2). */
  streamOnly?: boolean;
  /** Only buildCommand() sets this (plan 2.4): a fixed command string from settings. */
  shell?: boolean;
  /** Called once with the child's pid when it starts (a suite run records it, B6.5). */
  onSpawn?: (pid: number) => void;
  /** Called with each chunk of output, for streaming a build to the output channel. */
  onOutput?: (text: string) => void;
}

export type FailureReason = 'not-found' | 'timeout' | 'oversize' | 'spawn' | 'untrusted';

export type ToolResult =
  | { kind: 'exited'; code: number | null; stdout: string; stderrTail: string }
  | { kind: 'failure'; reason: FailureReason; detail: string; stderrTail: string }
  | { kind: 'cancelled' };

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface RunDeps {
  spawn: typeof cp.spawn;
  spawnSync: typeof cp.spawnSync;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  platform: NodeJS.Platform;
  /** INV-11: nothing runs when this says no. */
  gate: () => boolean;
  maxStderr: number;
}

export const defaultDeps: RunDeps = {
  spawn: cp.spawn,
  spawnSync: cp.spawnSync,
  kill: (pid, signal) => process.kill(pid, signal),
  platform: process.platform,
  gate: () => true,
  maxStderr: 64 * 1024,
};

/** Live children, so deactivate() can kill them all (INV-5). */
export const liveChildren = new Set<number>();

/** Kill a process and every process it started. */
export function killTree(pid: number, deps: Pick<RunDeps, 'spawnSync' | 'kill' | 'platform'> = defaultDeps): void {
  if (deps.platform === 'win32') {
    deps.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    deps.kill(-pid, 'SIGKILL');
  } catch {
    try {
      deps.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export function killAll(deps: Pick<RunDeps, 'spawnSync' | 'kill' | 'platform'> = defaultDeps): void {
  for (const pid of [...liveChildren]) killTree(pid, deps);
  liveChildren.clear();
}

export function runTool(cmd: ToolCommand, token?: CancellationLike, partial: Partial<RunDeps> = {}): Promise<ToolResult> {
  const deps: RunDeps = { ...defaultDeps, ...partial };
  if (!deps.gate()) {
    return Promise.resolve({ kind: 'failure', reason: 'untrusted', detail: 'The workspace is not trusted.', stderrTail: '' });
  }
  if (token?.isCancellationRequested) return Promise.resolve({ kind: 'cancelled' });
  return new Promise(resolve => {
    let child: cp.ChildProcess;
    try {
      child = deps.spawn(cmd.argv[0], cmd.argv.slice(1), {
        cwd: cmd.cwd,
        env: cmd.env ?? process.env,
        shell: cmd.shell ?? false,
        windowsHide: true,
        detached: deps.platform !== 'win32',
      });
    } catch (e) {
      resolve({ kind: 'failure', reason: 'spawn', detail: (e as Error).message, stderrTail: '' });
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = '';
    let settled: ToolResult | undefined;
    const pid = child.pid;
    if (pid !== undefined) {
      liveChildren.add(pid);
      cmd.onSpawn?.(pid);
    }
    const stop = (result: ToolResult) => {
      if (settled) return;
      settled = result;
      if (pid !== undefined) killTree(pid, deps);
    };
    const timer = cmd.timeoutMs > 0 ? setTimeout(() => stop({
      kind: 'failure', reason: 'timeout', detail: `exceeded ${cmd.timeoutMs} ms`, stderrTail: stderr,
    }), cmd.timeoutMs) : undefined;
    const sub = token?.onCancellationRequested(() => stop({ kind: 'cancelled' }));
    child.stdout!.on('data', (b: Buffer) => {
      if (cmd.streamOnly) {
        cmd.onOutput?.(b.toString('utf8'));
        return;
      }
      outBytes += b.length;
      if (outBytes > cmd.maxStdout) {
        stop({ kind: 'failure', reason: 'oversize', detail: `more than ${cmd.maxStdout} bytes of output`, stderrTail: stderr });
        return;
      }
      out.push(b);
      cmd.onOutput?.(b.toString('utf8'));
    });
    child.stderr!.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf8')).slice(-deps.maxStderr);
      cmd.onOutput?.(b.toString('utf8'));
    });
    const finish = (result: ToolResult) => {
      clearTimeout(timer);
      sub?.dispose();
      if (pid !== undefined) liveChildren.delete(pid);
      resolve(settled ?? result);
    };
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({ kind: 'failure', reason: e.code === 'ENOENT' ? 'not-found' : 'spawn', detail: e.message, stderrTail: stderr }));
    child.on('close', code => finish({
      kind: 'exited', code, stdout: Buffer.concat(out).toString('utf8'), stderrTail: stderr,
    }));
  });
}
