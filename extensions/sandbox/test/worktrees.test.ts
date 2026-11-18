import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  listSandboxWorktrees,
  resolveSandboxWorkspace,
  sandboxPathForHostPath,
} from '../src/worktrees';

function createBareRepo(root: string): void {
  mkdirSync(resolve(root, 'objects'), { recursive: true });
  mkdirSync(resolve(root, 'refs'), { recursive: true });
  writeFileSync(resolve(root, 'HEAD'), 'ref: refs/heads/main\n');
}

function addWorktree(root: string, name: string): string {
  const worktreePath = resolve(root, name);
  const metadataPath = resolve(root, 'worktrees', name);
  mkdirSync(metadataPath, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(resolve(metadataPath, 'gitdir'), `${worktreePath}/.git\n`);
  writeFileSync(resolve(metadataPath, 'commondir'), '../..\n');
  writeFileSync(resolve(metadataPath, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(resolve(worktreePath, '.git'), `gitdir: ${metadataPath}\n`);
  return worktreePath;
}

describe('sandbox worktree paths', () => {
  let temp: string;

  beforeEach(() => {
    temp = mkdtempSync(resolve(tmpdir(), 'sandbox-worktrees-'));
  });

  afterEach(() => {
    rmSync(temp, { recursive: true, force: true });
  });

  test('worktrees share their bare repo root and map to distinct container paths', () => {
    const bareRoot = resolve(temp, 'frontend');
    createBareRepo(bareRoot);
    const first = addWorktree(bareRoot, 'worktree1');
    const second = addWorktree(bareRoot, 'worktree2');

    const firstWorkspace = resolveSandboxWorkspace(first);
    const secondWorkspace = resolveSandboxWorkspace(second);

    expect(firstWorkspace.root).toBe(bareRoot);
    expect(secondWorkspace.root).toBe(bareRoot);
    expect(firstWorkspace.remoteCwd).toBe('/workspace/worktree1');
    expect(secondWorkspace.remoteCwd).toBe('/workspace/worktree2');
    expect(
      listSandboxWorktrees(bareRoot)
        .map(worktree => worktree.name)
        .sort(),
    ).toEqual(['worktree1', 'worktree2']);
  });

  test('maps a nested launch directory and worktree switch path under the shared root', () => {
    const bareRoot = resolve(temp, 'frontend');
    createBareRepo(bareRoot);
    const first = addWorktree(bareRoot, 'worktree1');
    const second = addWorktree(bareRoot, 'worktree2');
    mkdirSync(resolve(first, 'src'), { recursive: true });

    expect(resolveSandboxWorkspace(resolve(first, 'src')).remoteCwd).toBe(
      '/workspace/worktree1/src',
    );
    expect(sandboxPathForHostPath(bareRoot, second)).toBe('/workspace/worktree2');
    expect(() => sandboxPathForHostPath(bareRoot, resolve(temp, 'outside'))).toThrow(
      'outside repository root',
    );
  });

  test('uses the current directory as workspace for non-bare-repo projects', () => {
    const project = resolve(temp, 'project');
    mkdirSync(project);

    const workspace = resolveSandboxWorkspace(project);
    expect(workspace.root).toBe(project);
    expect(workspace.remoteCwd).toBe('/workspace');
    expect(workspace.isBareRepo).toBe(false);
  });
});
