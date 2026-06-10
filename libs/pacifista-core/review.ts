import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import type { EventHandler, PacifistaConfig, ReviewData, TriageVerdictData } from './types.ts';
import type { GateHandler } from './runner.ts';
import { piCaptureWithSession, piReview, piStream } from './pi.ts';
import { buildFixPrompt, buildTriagePrompt } from './prompt.ts';
import { runChecks } from './checks.ts';
import { appendEvent } from './state.ts';

/**
 * Review and triage run without a sandbox.
 *
 * The review stage writes structured JSON to a temp file on the host.
 * If pi spawns inside a container, the file lands in the container's
 * `/tmp` and the host can't read it. Force `--no-container` so quorum
 * and triage both read from the host filesystem.
 */
const REVIEW_PI_OPTS = { sandbox: false, noSandbox: true } as const;

export type TriageVerdict = {
  id: number;
  verdict: 'fix' | 'defer' | 'pushback';
  sha?: string;
  description: string;
};

/**
 * Check whether the quorum extension (@kingsleyzissou/quorum) is available.
 */
async function isQuorumAvailable(worktreePath: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['pi', '--list-extensions'], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.includes('quorum');
  } catch {
    try {
      const resolved = import.meta.resolve('@kingsleyzissou/quorum');
      return !!resolved;
    } catch {
      return false;
    }
  }
}

/**
 * Handler that lets the user filter triage verdicts before fixes
 * are applied. Returns the subset of verdicts to actually fix.
 * If not provided, all "fix" verdicts are applied automatically.
 */
export type TriageGateHandler = (verdicts: TriageVerdict[]) => Promise<TriageVerdict[]>;

/**
 * Run the ensemble review stage.
 */
export async function runReviewStage(
  worktreePath: string,
  config: PacifistaConfig,
  journalPath: string | undefined,
  onEvent?: EventHandler,
  onGate?: GateHandler,
  onTriageGate?: TriageGateHandler,
): Promise<{ reviewed: boolean; fixes: number }> {
  if (!config.review.enabled) {
    return { reviewed: false, fixes: 0 };
  }

  const baseBranch = config.review.baseBranch;
  const hasQuorum = await isQuorumAvailable(worktreePath);

  onEvent?.({ type: 'review:start' });
  onEvent?.({ type: 'review:reviewing' });

  // Write structured JSON output to a temp file via quorum's --output flag
  const outputPath = join(tmpdir(), `kuma-review-${Date.now()}.json`);

  const reviewResult = await piReview(
    baseBranch,
    worktreePath,
    {
      ...REVIEW_PI_OPTS,
      outputPath,
    },
    onEvent,
  );

  if (reviewResult.exitCode !== 0) {
    onEvent?.({ type: 'error', message: `Review failed: ${reviewResult.stderr}` });
    return { reviewed: false, fixes: 0 };
  }

  // Read structured review data
  let reviewData: ReviewData;
  try {
    const outputFile = Bun.file(outputPath);
    reviewData = (await outputFile.json()) as ReviewData;
  } catch {
    onEvent?.({ type: 'error', message: 'Failed to read review output' });
    return { reviewed: false, fixes: 0 };
  } finally {
    await unlink(outputPath).catch(() => {});
  }

  // Triage
  onEvent?.({ type: 'review:triage' });

  const triageResult = await piCaptureWithSession(buildTriagePrompt(reviewData), worktreePath, {
    ...REVIEW_PI_OPTS,
    noTools: true,
  });

  if (triageResult.exitCode !== 0) {
    onEvent?.({ type: 'error', message: `Triage failed: ${triageResult.stderr}` });
    return { reviewed: true, fixes: 0 };
  }

  const verdicts = parseVerdicts(triageResult.stdout);

  // Save review data and verdicts to journal (if one exists)
  if (journalPath) {
    await appendEvent(journalPath, {
      type: 'review:completed',
      reviewData,
      verdicts: verdicts as TriageVerdictData[],
      reviewSessionId: reviewResult.sessionId,
      triageSessionId: triageResult.sessionId,
      ts: new Date().toISOString(),
    });
  }

  // Present all verdicts so the TUI can display the full triage result
  onEvent?.({ type: 'review:verdicts', verdicts: verdicts as TriageVerdictData[] });

  // Gate: let the user decide which fixes to apply.
  // Without a triage gate, all "fix" verdicts are applied automatically.
  const candidateFixes = verdicts.filter(v => v.verdict === 'fix');
  const fixes = onTriageGate ? await onTriageGate(candidateFixes) : candidateFixes;

  if (fixes.length === 0) {
    onEvent?.({ type: 'review:done', fixes: 0 });
    return { reviewed: true, fixes: 0 };
  }

  // Apply fixes
  onEvent?.({ type: 'review:applying', total: fixes.length });
  let appliedFixes = 0;

  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i]!;
    if (!fix.sha) continue;

    onEvent?.({
      type: 'review:fix',
      current: i + 1,
      total: fixes.length,
      description: fix.description,
    });

    // Use piStream so tool calls are visible in the TUI, with a
    // timeout to prevent the agent from hanging indefinitely.
    const fixResult = await withTimeout(
      piStream(buildFixPrompt(fix.description, fix.sha), worktreePath, REVIEW_PI_OPTS, onEvent),
      2 * 60_000, // 2 minute timeout per fix
    );

    if (!fixResult) {
      onEvent?.({ type: 'error', message: `Fix #${fix.id} timed out after 2 minutes` });
      continue;
    }

    if (fixResult.exitCode !== 0) {
      onEvent?.({ type: 'error', message: `Fix #${fix.id} failed (exit ${fixResult.exitCode})` });
      continue;
    }

    const checksResult = await runChecks(worktreePath, config.checks, 'task');

    if (onGate) {
      const fixChangedFiles = await getChangedFiles(worktreePath);
      const action = await onGate(
        { id: fix.id, title: fix.description, body: '', fields: {} },
        1,
        fixChangedFiles,
        checksResult,
        config.gate,
      );
      if (action.action !== 'approve') continue;
    }

    // Commit the fix on the host with --fixup so autosquash can
    // fold it into the original commit. This mirrors how the normal
    // task flow commits — the agent never runs git commit itself.
    const commitSha = await commitFixup(worktreePath, fix, config.format);
    if (commitSha) {
      appliedFixes++;
    }
  }

  // Autosquash all fixup commits into their targets.
  if (appliedFixes > 0) {
    const squashOk = await autosquash(worktreePath, baseBranch);
    if (!squashOk) {
      onEvent?.({
        type: 'error',
        message:
          'Autosquash failed — fixup commits are preserved. Run `git rebase -i --autosquash` manually.',
      });
    }
  }

  void hasQuorum; // used for future messaging
  onEvent?.({ type: 'review:done', fixes: appliedFixes });
  return { reviewed: true, fixes: appliedFixes };
}

// ── Git helpers for fix application ─────────────────────────────────────

async function getChangedFiles(workdir: string): Promise<string[]> {
  // Modified/deleted tracked files
  const diff = Bun.spawn(['git', 'diff', '--name-only', 'HEAD'], {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const diffOut = await new Response(diff.stdout).text();
  await diff.exited;

  // New untracked files (e.g. dotfiles like .prettierrc)
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
 * Stage all changes and create a fixup commit targeting the original SHA.
 * Returns the new commit SHA on success, undefined if nothing to commit.
 */
async function commitFixup(
  workdir: string,
  fix: TriageVerdict,
  formatCmd?: string,
): Promise<string | undefined> {
  // Run formatter before staging so commit hooks have nothing to change
  if (formatCmd) {
    Bun.spawnSync(['sh', '-c', formatCmd], {
      cwd: workdir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  const add = Bun.spawn(['git', 'add', '-A'], {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const addStderr = await new Response(add.stderr).text();
  const addExit = await add.exited;

  if (addExit !== 0) {
    console.warn(`[pacifista] git add failed: ${addStderr}`);
    return undefined;
  }

  const message = fix.sha ? `fixup! ${fix.sha}` : `review: ${fix.description}`;

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
    if (stderr.includes('nothing to commit')) return undefined;
    console.warn(`[pacifista] fixup commit failed: ${stderr}`);
    return undefined;
  }

  const shaMatch = stdout.match(/\[\S+\s+([a-f0-9]+)\]/);
  return shaMatch?.[1];
}

/**
 * Run autosquash rebase to fold fixup commits into their targets.
 * Returns true on success, false on failure (e.g. conflicts).
 */
async function autosquash(workdir: string, baseBranch?: string): Promise<boolean> {
  const target = baseBranch ?? 'HEAD~10';
  const squash = Bun.spawn(
    ['sh', '-c', `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash ${target}`],
    { cwd: workdir, stdout: 'pipe', stderr: 'pipe' },
  );

  const stderr = await new Response(squash.stderr).text();
  const exitCode = await squash.exited;

  if (exitCode !== 0) {
    // Abort the failed rebase so the worktree isn't left in a broken state
    const abort = Bun.spawn(['git', 'rebase', '--abort'], {
      cwd: workdir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await abort.exited;

    console.warn(`[pacifista] autosquash failed: ${stderr}`);
    return false;
  }

  return true;
}

/**
 * Extract the outer JSON array from triage output.
 *
 * Uses a bracket-depth counter instead of regex to correctly handle
 * nested arrays/objects (e.g. `"tags": []`) that would cause a
 * non-greedy regex `\[...*?\]` to stop at the first `]`.
 */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;

    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return null; // unbalanced brackets
}

function parseVerdicts(output: string): TriageVerdict[] {
  // Strip markdown code fences before matching
  const stripped = output.replace(/```(?:json)?\s*\n?/g, '');

  const jsonStr = extractJsonArray(stripped);
  if (!jsonStr) {
    console.warn('[pacifista] parseVerdicts: no JSON array found in triage output');
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      console.warn('[pacifista] parseVerdicts: parsed value is not an array');
      return [];
    }
    return parsed as TriageVerdict[];
  } catch (err) {
    console.warn(
      `[pacifista] parseVerdicts: JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// ── Timeout helper ──────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
