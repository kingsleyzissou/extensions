import { stat } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Detect the bare repo root from a worktree path.
 *
 * In a bare repo + worktree setup, the worktree's `.git` is a file
 * (not a directory) containing `gitdir: <path>`. We follow the
 * reference to find the common git dir, which is the bare repo root.
 *
 * Returns undefined if not in a worktree or detection fails.
 */
export async function detectBareRepoRoot(
  worktreePath: string,
): Promise<string | undefined> {
  const gitPath = `${worktreePath}/.git`;

  let gitStat;
  try {
    gitStat = await stat(gitPath);
  } catch {
    return undefined;
  }

  // If .git is a directory, it's a regular repo — no parent to search
  if (gitStat.isDirectory()) return undefined;

  const content = await Bun.file(gitPath).text();
  if (!content.startsWith("gitdir:")) return undefined;

  const gitdir = content.replace("gitdir:", "").trim();

  try {
    const proc = Bun.spawn(
      ["git", `--git-dir=${gitdir}`, "rev-parse", "--git-common-dir"],
      { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
    );
    const commonDir = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || !commonDir || commonDir === ".") return undefined;

    return resolve(worktreePath, gitdir, commonDir);
  } catch {
    return undefined;
  }
}
