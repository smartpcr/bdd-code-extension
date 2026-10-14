// A disposable git worktree of os-context, for scenarios that change files
// (plan B1.1 item 7). Never inside the main checkout.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function osContextRoot(): string {
  const root = process.env.OS_CONTEXT_ROOT;
  if (!root || !fs.existsSync(path.join(root, 'test', 'e2e', 'schema'))) {
    throw new Error(`OS_CONTEXT_ROOT must name an os-context checkout (got ${root ?? 'nothing'}).`);
  }
  return root;
}

export function createWorktree(): string {
  const dir = path.join(os.tmpdir(), `bdd-suite-wt-${process.pid}-${Date.now()}`);
  execFileSync('git', ['-C', osContextRoot(), 'worktree', 'add', dir, 'HEAD', '--detach'], { stdio: 'pipe' });
  return dir;
}

export function removeWorktree(dir: string): void {
  try {
    execFileSync('git', ['-C', osContextRoot(), 'worktree', 'remove', '--force', dir], { stdio: 'pipe' });
  } catch (e) {
    console.error(`Could not remove the worktree at ${dir}; it is left for inspection. ${(e as Error).message}`);
  }
}
