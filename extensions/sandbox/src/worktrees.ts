import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import {
  detectBareRepoRoot,
  isBareRepo,
  listWorktrees,
  type WorktreeInfo,
} from '@kingsleyzissou/core';

export const SANDBOX_WORKSPACE_ROOT = '/workspace';

export interface SandboxWorktree extends WorktreeInfo {
  relPath: string;
}

export interface SandboxWorkspace {
  root: string;
  remoteCwd: string;
  isBareRepo: boolean;
}

function isWithinPath(root: string, path: string): boolean {
  const relPath = relative(root, path);
  return (
    relPath === '' || (!isAbsolute(relPath) && relPath !== '..' && !relPath.startsWith(`..${sep}`))
  );
}

function findBareRepoRoot(hostCwd: string): string | null {
  for (let current = resolvePath(hostCwd); ; current = dirname(current)) {
    const worktreeRoot = detectBareRepoRoot(current);
    if (worktreeRoot) return resolvePath(worktreeRoot);
    if (isBareRepo(current)) return current;
    if (dirname(current) === current) return null;
  }
}

export function listSandboxWorktrees(bareRoot: string): SandboxWorktree[] {
  return listWorktrees(bareRoot).flatMap(worktree => {
    const worktreePath = resolvePath(worktree.path);
    if (!isWithinPath(bareRoot, worktreePath) || !existsSync(resolvePath(worktreePath, '.git'))) {
      return [];
    }

    return [
      {
        ...worktree,
        path: worktreePath,
        relPath: relative(bareRoot, worktreePath).split(sep).join('/'),
      },
    ];
  });
}

export function sandboxPathForHostPath(root: string, hostPath: string): string {
  const workspaceRoot = resolvePath(root);
  const relPath = relative(workspaceRoot, resolvePath(hostPath));
  if (!isWithinPath(workspaceRoot, resolvePath(hostPath))) {
    throw new Error(
      `sandbox: refusing to map ${hostPath}: outside repository root ${workspaceRoot}`,
    );
  }

  const posixPath = relPath.split(sep).join('/');
  return posixPath ? `${SANDBOX_WORKSPACE_ROOT}/${posixPath}` : SANDBOX_WORKSPACE_ROOT;
}

export function isPathWithin(root: string, path: string): boolean {
  return isWithinPath(resolvePath(root), resolvePath(path));
}

export function resolveSandboxWorkspace(hostCwd: string): SandboxWorkspace {
  const cwd = resolvePath(hostCwd);
  const bareRoot = findBareRepoRoot(cwd);
  if (!bareRoot || !isWithinPath(bareRoot, cwd)) {
    return {
      root: cwd,
      remoteCwd: SANDBOX_WORKSPACE_ROOT,
      isBareRepo: false,
    };
  }

  return {
    root: bareRoot,
    remoteCwd: sandboxPathForHostPath(bareRoot, cwd),
    isBareRepo: true,
  };
}
