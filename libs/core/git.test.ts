import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { isBareRepo, detectBareRepoRoot, listWorktrees } from './git.ts';

/**
 * Create a minimal bare repo structure on disk for testing.
 * Does NOT use `git init` — purely filesystem-based, matching what the
 * detection functions inspect.
 */
function createFakeBareRepo(root: string): void {
  mkdirSync(resolve(root, 'objects'), { recursive: true });
  mkdirSync(resolve(root, 'refs'), { recursive: true });
  writeFileSync(resolve(root, 'HEAD'), 'ref: refs/heads/main\n');
}

/**
 * Register a fake worktree in the bare repo's worktrees/ directory
 * and create the worktree directory with a .git pointer file.
 */
function addFakeWorktree(bareRoot: string, name: string, worktreePath: string): void {
  const metaDir = resolve(bareRoot, 'worktrees', name);
  mkdirSync(metaDir, { recursive: true });

  // worktrees/<name>/gitdir → points to the worktree's .git file
  writeFileSync(resolve(metaDir, 'gitdir'), `${worktreePath}/.git\n`);
  // worktrees/<name>/commondir → relative path back to bare root
  writeFileSync(resolve(metaDir, 'commondir'), '../..\n');
  writeFileSync(resolve(metaDir, 'HEAD'), 'ref: refs/heads/main\n');

  // Create the worktree directory with a .git pointer file
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(resolve(worktreePath, '.git'), `gitdir: ${bareRoot}/worktrees/${name}\n`);
}

describe('isBareRepo', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'core-git-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns true for a directory with HEAD, objects/, and refs/', () => {
    createFakeBareRepo(tmp);
    expect(isBareRepo(tmp)).toBe(true);
  });

  test('returns false when HEAD is missing', () => {
    mkdirSync(resolve(tmp, 'objects'), { recursive: true });
    mkdirSync(resolve(tmp, 'refs'), { recursive: true });
    expect(isBareRepo(tmp)).toBe(false);
  });

  test('returns false when objects/ is missing', () => {
    mkdirSync(resolve(tmp, 'refs'), { recursive: true });
    writeFileSync(resolve(tmp, 'HEAD'), 'ref: refs/heads/main\n');
    expect(isBareRepo(tmp)).toBe(false);
  });

  test('returns false when HEAD has invalid content', () => {
    mkdirSync(resolve(tmp, 'objects'), { recursive: true });
    mkdirSync(resolve(tmp, 'refs'), { recursive: true });
    writeFileSync(resolve(tmp, 'HEAD'), 'not-a-valid-head\n');
    expect(isBareRepo(tmp)).toBe(false);
  });

  test('returns true when HEAD is a raw SHA', () => {
    mkdirSync(resolve(tmp, 'objects'), { recursive: true });
    mkdirSync(resolve(tmp, 'refs'), { recursive: true });
    writeFileSync(resolve(tmp, 'HEAD'), 'a'.repeat(40) + '\n');
    expect(isBareRepo(tmp)).toBe(true);
  });

  test('returns false for a non-existent directory', () => {
    expect(isBareRepo(resolve(tmp, 'nope'))).toBe(false);
  });
});

describe('detectBareRepoRoot', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'core-git-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('resolves bare root from a worktree directory', () => {
    const bareRoot = resolve(tmp, 'repo.git');
    const worktree = resolve(tmp, 'repo.git', 'main');
    createFakeBareRepo(bareRoot);
    addFakeWorktree(bareRoot, 'main', worktree);

    expect(detectBareRepoRoot(worktree)).toBe(bareRoot);
  });

  test('returns null for a regular .git directory', () => {
    mkdirSync(resolve(tmp, '.git'), { recursive: true });
    expect(detectBareRepoRoot(tmp)).toBe(null);
  });

  test('returns null when .git file has no gitdir', () => {
    writeFileSync(resolve(tmp, '.git'), 'garbage content\n');
    expect(detectBareRepoRoot(tmp)).toBe(null);
  });

  test('returns null when commondir is missing', () => {
    const bareRoot = resolve(tmp, 'repo.git');
    const metaDir = resolve(bareRoot, 'worktrees', 'test');
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(resolve(metaDir, 'gitdir'), `${tmp}/.git\n`);
    // No commondir file
    writeFileSync(resolve(tmp, '.git'), `gitdir: ${metaDir}\n`);

    expect(detectBareRepoRoot(tmp)).toBe(null);
  });

  test('returns null when no .git exists', () => {
    expect(detectBareRepoRoot(tmp)).toBe(null);
  });
});

describe('listWorktrees', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'core-git-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('enumerates worktrees under a bare repo', () => {
    createFakeBareRepo(tmp);
    addFakeWorktree(tmp, 'main', resolve(tmp, 'main'));
    addFakeWorktree(tmp, 'feature', resolve(tmp, 'feature'));

    const result = listWorktrees(tmp);
    expect(result).toHaveLength(2);

    const names = result.map(w => w.name).sort();
    expect(names).toEqual(['feature', 'main']);

    const mainWt = result.find(w => w.name === 'main');
    expect(mainWt?.path).toBe(resolve(tmp, 'main'));
    expect(mainWt?.branch).toBe('main');
  });

  test('returns null branch for detached HEAD', () => {
    createFakeBareRepo(tmp);
    addFakeWorktree(tmp, 'detached', resolve(tmp, 'detached'));
    // Overwrite HEAD with a raw SHA (detached)
    writeFileSync(resolve(tmp, 'worktrees', 'detached', 'HEAD'), 'a'.repeat(40) + '\n');

    const result = listWorktrees(tmp);
    const wt = result.find(w => w.name === 'detached');
    expect(wt?.branch).toBeNull();
  });

  test('returns empty array when no worktrees/ directory exists', () => {
    createFakeBareRepo(tmp);
    expect(listWorktrees(tmp)).toEqual([]);
  });

  test('skips worktree entries without a gitdir file', () => {
    createFakeBareRepo(tmp);
    mkdirSync(resolve(tmp, 'worktrees', 'orphan'), { recursive: true });
    // No gitdir file in this entry

    expect(listWorktrees(tmp)).toEqual([]);
  });

  test('skips worktrees whose directory does not exist', () => {
    createFakeBareRepo(tmp);
    // Create worktree metadata but NOT the actual worktree directory
    const metaDir = resolve(tmp, 'worktrees', 'ghost');
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(resolve(metaDir, 'gitdir'), `${resolve(tmp, 'ghost')}/.git\n`);

    expect(listWorktrees(tmp)).toEqual([]);
  });
});
