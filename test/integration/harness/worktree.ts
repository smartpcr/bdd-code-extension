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
  if (process.env.BDD_WORKTREE_INCLUDE_CHANGES === '1') copyChanges(osContextRoot(), dir);
  return dir;
}

/**
 * Opt-in: the checkout's uncommitted state, copied over the disposable
 * worktree, for a scenario that must see work not yet committed (B7 before
 * the user commits it). Modified and untracked files are copied, deleted
 * ones removed; ignored files (node_modules, build output) are not. No commit
 * or ref is created.
 */
function copyChanges(root: string, dir: string): void {
  const list = (...args: string[]) => execFileSync('git', ['-C', root, 'ls-files', '-z', ...args], { encoding: 'utf8' })
    .split('\0').filter(Boolean);
  const deleted = new Set(list('--deleted'));
  for (const file of list('--modified', '--others', '--exclude-standard')) {
    if (deleted.has(file)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  for (const file of deleted) fs.rmSync(path.join(dir, file), { force: true });
}

export function removeWorktree(dir: string): void {
  try {
    execFileSync('git', ['-C', osContextRoot(), 'worktree', 'remove', '--force', dir], { stdio: 'pipe' });
  } catch (e) {
    console.error(`Could not remove the worktree at ${dir}; it is left for inspection. ${(e as Error).message}`);
  }
}
