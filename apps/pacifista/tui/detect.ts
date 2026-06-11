import * as p from '@clack/prompts';
import {
  isBareRepo as isBareRepoSync,
  listWorktrees as listWorktreesSync,
} from '@kingsleyzissou/core';

type Worktree = {
  path: string;
  branch: string;
};

/**
 * Detect if cwd is a bare git repo.
 */
export function isBareRepo(cwd: string): boolean {
  return isBareRepoSync(cwd);
}

/**
 * List git worktrees for a bare repo.
 */
export function listWorktrees(cwd: string): Worktree[] {
  return listWorktreesSync(cwd).map(wt => ({
    path: wt.path,
    branch: wt.branch ?? '',
  }));
}

/**
 * Check if the sandbox extension is available.
 */
export async function isSandboxAvailable(): Promise<boolean> {
  try {
    const resolved = import.meta.resolve('@kingsleyzissou/sandbox');
    return !!resolved;
  } catch {
    return false;
  }
}

/**

 * Prompt user to select a worktree.
 */
export async function selectWorktree(worktrees: Worktree[]): Promise<string | null> {
  const result = await p.select({
    message: 'Select a worktree',
    options: worktrees.map(w => ({
      value: w.path,
      label: w.path.split('/').pop() ?? w.path,
      hint: w.branch,
    })),
  });

  if (p.isCancel(result)) return null;
  return result;
}
