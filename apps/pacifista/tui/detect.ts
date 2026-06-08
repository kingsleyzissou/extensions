import * as p from '@clack/prompts';

type Worktree = {
  path: string;
  branch: string;
  bare: boolean;
};

/**
 * Detect if cwd is a bare git repo.
 */
export async function isBareRepo(cwd: string): Promise<boolean> {
  const proc = Bun.spawn(['git', 'rev-parse', '--is-bare-repository'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim() === 'true';
}

/**
 * List git worktrees for a bare repo.
 */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const proc = Bun.spawn(['git', 'worktree', 'list', '--porcelain'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> = {};

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) {
        worktrees.push(current as Worktree);
      }
      current = { path: line.slice(9), branch: '', bare: false };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    }
  }
  if (current.path) {
    worktrees.push(current as Worktree);
  }

  return worktrees.filter(w => !w.bare);
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
