// A disposable git worktree of this repository, for scenarios that change
// files (plan B1.1 item 7). Never inside the main checkout. The session's
// folder is the worktree's samples/workspace; the runtimes it reaches by
// relative path are the worktree's own.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { repo } from './sample';

/** The worktree's sample workspace, the folder the `worktree` session opens. */
export const worktreeSample = (dir: string): string => path.join(dir, 'samples', 'workspace');

/** Create the worktree at HEAD; returns its sample workspace. */
export function createWorktree(): string {
  const dir = path.join(os.tmpdir(), `bdd-suite-wt-${process.pid}-${Date.now()}`);
  execFileSync('git', ['-C', repo, 'worktree', 'add', dir, 'HEAD', '--detach'], { stdio: 'pipe' });
  if (process.env.BDD_WORKTREE_INCLUDE_CHANGES === '1') copyChanges(repo, dir);
  const sample = worktreeSample(dir);
  if (!fs.existsSync(path.join(sample, 'test', 'e2e', 'schema', 'actions.catalog.yaml'))) {
    removeWorktree(sample);
    throw new Error(`HEAD has no samples/workspace; commit it, or set BDD_WORKTREE_INCLUDE_CHANGES=1 to copy the uncommitted tree.`);
  }
  return sample;
}

/**
 * Opt-in: the checkout's uncommitted state, copied over the disposable
 * worktree, for a scenario that must see work not yet committed. Modified and
 * untracked files are copied, deleted ones removed; ignored files
 * (node_modules, build output) are not. No commit or ref is created.
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

/** Remove the worktree that holds `sample` (the folder createWorktree returned). */
export function removeWorktree(sample: string): void {
  const dir = path.resolve(sample, '..', '..');
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', dir], { stdio: 'pipe' });
  } catch (e) {
    console.error(`Could not remove the worktree at ${dir}; it is left for inspection. ${(e as Error).message}`);
  }
}
