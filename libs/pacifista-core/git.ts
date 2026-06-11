export { detectBareRepoRoot, isBareRepo, listWorktrees } from '@kingsleyzissou/core';
export type { WorktreeInfo } from '@kingsleyzissou/core';

// ── Shared git helpers ──────────────────────────────────────────────────

/**
 * Get the current HEAD commit SHA.
 */
export async function getHead(workdir: string): Promise<string> {
  const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

/**
 * Get the list of changed files relative to a base ref.
 *
 * Includes both tracked changes (via `git diff`) and new untracked
 * files (via `git ls-files`). This ensures dotfiles and other newly
 * created files are not silently omitted.
 */
export async function getChangedFiles(workdir: string, base?: string): Promise<string[]> {
  const ref = base ?? 'HEAD';

  // Modified/deleted tracked files
  const diff = Bun.spawn(['git', 'diff', '--name-only', ref], {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const diffOut = await new Response(diff.stdout).text();
  await diff.exited;

  // New untracked files (e.g. .prettierrc, new source files)
  const untracked = Bun.spawn(['git', 'ls-files', '--others', '--exclude-standard'], {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const untrackedOut = await new Response(untracked.stdout).text();
  await untracked.exited;

  const files = new Set<string>();
  for (const f of diffOut.split('\n')) {
    const trimmed = f.trim();
    if (trimmed) files.add(trimmed);
  }
  for (const f of untrackedOut.split('\n')) {
    const trimmed = f.trim();
    if (trimmed) files.add(trimmed);
  }

  return [...files];
}

/**
 * Stage all changes, optionally run a formatter, and commit.
 *
 * Returns the commit SHA on success, undefined if nothing to commit.
 * Runs on the host (not inside a sandbox) so the user's git config,
 * GPG keys, and signing preferences are available.
 */
export async function stageAndCommit(
  workdir: string,
  message: string,
  formatCmd?: string,
): Promise<string | undefined> {
  // Run formatter before staging so commit hooks have nothing to change
  if (formatCmd) {
    const fmt = Bun.spawnSync(['sh', '-c', formatCmd], {
      cwd: workdir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (fmt.exitCode !== 0) {
      const stderr = fmt.stderr.toString().trim();
      console.warn(
        `[pacifista] formatter exited with code ${fmt.exitCode}${stderr ? `: ${stderr}` : ''}`,
      );
    }
  }

  const add = Bun.spawn(['git', 'add', '-A'], {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const addStderr = await new Response(add.stderr).text();
  const addExit = await add.exited;

  if (addExit !== 0) {
    throw new Error(`git add failed (exit ${addExit}): ${addStderr}`);
  }

  const commit = Bun.spawn(['git', 'commit', '-m', message], {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(commit.stdout).text(),
    new Response(commit.stderr).text(),
    commit.exited,
  ]);

  if (exitCode !== 0) {
    if (!stderr.includes('nothing to commit')) {
      throw new Error(`git commit failed (exit ${exitCode}): ${stderr}`);
    }
    return undefined;
  }

  const shaMatch = stdout.match(/\[\S+\s+([a-f0-9]+)\]/);
  return shaMatch?.[1];
}

/**
 * Run autosquash rebase to fold fixup commits into their targets.
 * Returns true on success, false on failure (aborts automatically).
 */
export async function autosquash(workdir: string, baseBranch?: string): Promise<boolean> {
  const target = baseBranch ?? 'HEAD~10';
  const squash = Bun.spawn(
    ['sh', '-c', `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash ${target}`],
    { cwd: workdir, stdout: 'pipe', stderr: 'pipe' },
  );

  const stderr = await new Response(squash.stderr).text();
  const exitCode = await squash.exited;

  if (exitCode !== 0) {
    const abort = Bun.spawn(['git', 'rebase', '--abort'], {
      cwd: workdir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await abort.exited;
    throw new Error(`autosquash failed: ${stderr}`);
  }

  return true;
}
