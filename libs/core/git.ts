/**
 * Pure filesystem-based git bare repo and worktree detection.
 *
 * These helpers inspect the filesystem directly (no `git` binary needed)
 * and are synchronous so they can be used in any context — startup hooks,
 * CLI argument parsing, or async workflows alike.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  /** Worktree entry name (directory name under `worktrees/`). */
  name: string;
  /** Absolute path to the worktree directory on the host. */
  path: string;
  /** Branch checked out in this worktree (e.g. `main`), or `null` for detached HEAD. */
  branch: string | null;
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a directory is a bare git repo root.
 *
 * Bare repos have `HEAD`, `objects/`, and `refs/` directly in the directory
 * (rather than inside a `.git/` subdirectory). We also validate that `HEAD`
 * contains a plausible ref or SHA.
 */
export function isBareRepo(dir: string): boolean {
  for (const indicator of ['HEAD', 'objects', 'refs']) {
    if (!existsSync(resolvePath(dir, indicator))) return false;
  }

  try {
    const head = readFileSync(resolvePath(dir, 'HEAD'), 'utf-8').trim();
    return head.startsWith('ref:') || /^[0-9a-f]{40}$/i.test(head);
  } catch {
    return false;
  }
}

/**
 * Detect the bare repo root from a worktree directory.
 *
 * In a bare repo + worktree setup the worktree's `.git` is a **file**
 * (not a directory) containing `gitdir: <path>`. We follow the reference,
 * then read the `commondir` file to resolve the bare repo root.
 *
 * Returns the absolute bare repo root path, or `null` if the directory
 * is not a worktree or detection fails.
 */
export function detectBareRepoRoot(worktreePath: string): string | null {
  const dotGit = resolvePath(worktreePath, '.git');
  if (!existsSync(dotGit)) return null;

  try {
    const st = statSync(dotGit);
    if (!st.isFile()) return null; // Regular .git directory, not a worktree

    const content = readFileSync(dotGit, 'utf-8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match?.[1]) return null;

    const gitdir = match[1]; // e.g., /path/to/bare/worktrees/main
    const commondirFile = resolvePath(gitdir, 'commondir');
    if (!existsSync(commondirFile)) return null;

    const commondir = readFileSync(commondirFile, 'utf-8').trim();
    const bareRoot = resolvePath(gitdir, commondir);

    // Sanity-check that it actually looks like a bare repo
    return isBareRepo(bareRoot) ? bareRoot : null;
  } catch {
    return null;
  }
}

/**
 * Enumerate worktrees registered under a bare repo root.
 *
 * Reads the `worktrees/` directory and resolves each entry's `gitdir`
 * file to find the worktree's location on disk. Only returns worktrees
 * whose directories actually exist.
 */
export function listWorktrees(bareRoot: string): WorktreeInfo[] {
  const worktreesDir = resolvePath(bareRoot, 'worktrees');
  if (!existsSync(worktreesDir)) return [];

  const worktrees: WorktreeInfo[] = [];

  try {
    for (const name of readdirSync(worktreesDir)) {
      const gitdirFile = resolvePath(worktreesDir, name, 'gitdir');
      if (!existsSync(gitdirFile)) continue;

      try {
        const gitdirContent = readFileSync(gitdirFile, 'utf-8').trim();
        // gitdir contains the absolute path to the worktree's .git file
        // e.g., /Users/me/projects/repo/main/.git
        const worktreePath = resolvePath(gitdirContent, '..');

        // Only include worktrees whose directories exist
        if (!existsSync(worktreePath)) continue;

        // Read the branch from worktrees/<name>/HEAD
        let branch: string | null = null;
        const headFile = resolvePath(worktreesDir, name, 'HEAD');
        try {
          const headContent = readFileSync(headFile, 'utf-8').trim();
          const refMatch = headContent.match(/^ref:\s*refs\/heads\/(.+)$/);
          if (refMatch?.[1]) branch = refMatch[1];
        } catch {
          // Detached HEAD or missing — leave as null
        }

        worktrees.push({ name, path: worktreePath, branch });
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }

  return worktrees;
}
