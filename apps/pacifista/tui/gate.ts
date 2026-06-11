import * as p from '@clack/prompts';
import { pager } from './pager.ts';
import type {
  ChecksResult,
  GateAction,
  GateConfig,
  PlanTask,
  TriageVerdict,
} from '@kingsleyzissou/pacifista-core';

/**
 * Create a gate handler bound to a specific worktree path.
 *
 * The worktree path is needed to run `git diff` for the diff viewer.
 * Closing over it here keeps the GateHandler signature unchanged.
 */
export function createGate(worktreePath: string) {
  return (
    task: PlanTask,
    attempt: number,
    changedFiles: string[],
    checksResult: ChecksResult,
    gateConfig: GateConfig,
  ): Promise<GateAction> => {
    return presentGate(task, attempt, changedFiles, checksResult, gateConfig, worktreePath);
  };
}

/**
 * Present the user gate using clack prompts.
 */
export async function presentGate(
  task: PlanTask,
  attempt: number,
  changedFiles: string[],
  checksResult: ChecksResult,
  gateConfig: GateConfig,
  worktreePath?: string,
): Promise<GateAction> {
  // Auto-approve check
  if (shouldAutoApprove(gateConfig, task, checksResult)) {
    p.log.success(`Auto-approved: Task ${task.id}: ${task.title}`);
    return { action: 'approve' };
  }

  // Display results
  p.log.info(`Task ${task.id}: ${task.title} — Attempt ${attempt}`);

  // Changed files
  if (changedFiles.length > 0) {
    p.log.message('Changed files:\n' + changedFiles.map(f => `  ${f}`).join('\n'));
  } else {
    p.log.warn('No files changed');
  }

  // Check results
  const checkSummary = checksResult.checks
    .map(c => `  ${c.name}: ${fmtStatus(c.status)}`)
    .join('\n');
  p.log.message(`Check Results:\n${checkSummary}`);

  // Show error output for failures
  for (const check of checksResult.checks) {
    if (check.output) {
      p.log.error(`${check.name} errors:\n${check.output}`);
    }
  }

  // Loop so the user can view the diff, then come back to decide
  for (;;) {
    const hasDiff = worktreePath && changedFiles.length > 0;

    const action = await p.select({
      message: 'What would you like to do?',
      options: [
        ...(hasDiff ? [{ value: 'diff' as const, label: 'View diff', hint: 'open in pager' }] : []),
        { value: 'approve' as const, label: 'Approve', hint: 'accept and continue' },
        { value: 'revise' as const, label: 'Revise', hint: 'retry with feedback' },
        { value: 'reject' as const, label: 'Reject', hint: 'reject this task' },
        { value: 'quit' as const, label: 'Quit', hint: 'save and exit' },
      ],
    });

    if (p.isCancel(action)) {
      return { action: 'quit' };
    }

    if (action === 'diff') {
      await showDiff(worktreePath!);
      continue;
    }

    switch (action) {
      case 'approve':
        return { action: 'approve' };

      case 'revise': {
        const feedback = await p.text({
          message: 'Revision feedback:',
          placeholder: 'Describe what needs to change...',
          validate: v => {
            if (!v?.trim()) return 'Feedback is required';
          },
        });
        if (p.isCancel(feedback)) return { action: 'quit' };
        return { action: 'revise', feedback: String(feedback).trim() };
      }

      case 'reject': {
        const stop = await p.confirm({
          message: 'Stop execution entirely?',
          initialValue: false,
        });
        if (p.isCancel(stop)) return { action: 'quit' };
        return { action: 'reject', stop: !!stop };
      }

      case 'quit':
        return { action: 'quit' };

      default:
        return { action: 'quit' };
    }
  }
}

/**
 * Capture the diff and show it in the clack pager.
 *
 * Untracked files are temporarily marked as intent-to-add so they
 * appear in the diff. If the working tree is clean (agent may have
 * committed), falls back to showing the last commit's diff.
 */
async function showDiff(worktreePath: string): Promise<void> {
  // Mark untracked files as intent-to-add so they appear in the diff
  const untracked = Bun.spawnSync(['git', 'ls-files', '--others', '--exclude-standard'], {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
  })
    .stdout.toString()
    .trim();

  const untrackedFiles = untracked ? untracked.split('\n').filter(f => f.trim()) : [];

  if (untrackedFiles.length > 0) {
    Bun.spawnSync(['git', 'add', '-N', '--', ...untrackedFiles], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  try {
    let diffText = '';

    const hasDiff =
      Bun.spawnSync(['git', 'diff', '--quiet', 'HEAD'], {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
      }).exitCode !== 0;

    if (hasDiff) {
      diffText = captureDiff(worktreePath, ['HEAD']);
    } else {
      // Agent may have committed — show the last commit's diff
      const hasCommitDiff =
        Bun.spawnSync(['git', 'diff', '--quiet', 'HEAD~1', 'HEAD'], {
          cwd: worktreePath,
          stdout: 'pipe',
          stderr: 'pipe',
        }).exitCode !== 0;

      if (hasCommitDiff) {
        diffText = captureDiff(worktreePath, ['HEAD~1', 'HEAD']);
      }
    }

    if (!diffText.trim()) {
      p.log.warn('No diff to show');
      return;
    }

    await pager(diffText, 'Diff');
  } finally {
    // Undo intent-to-add so untracked files stay untracked
    if (untrackedFiles.length > 0) {
      Bun.spawnSync(['git', 'reset', '--', ...untrackedFiles], {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    }
  }
}

/**
 * Run git diff with color forced on, even when stdout is piped.
 * Sets --color=always for git's built-in diff and DFT_COLOR=always
 * for difftastic (when configured as diff.external).
 */
function captureDiff(cwd: string, args: string[]): string {
  return Bun.spawnSync(['git', 'diff', '--color=always', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // Set COLUMNS so tools that can't detect width from a pipe
    // (e.g. diff viewers) size their output to fit the pager viewport.
    env: { ...process.env, COLUMNS: String(process.stdout.columns - 4) },
  }).stdout.toString();
}

function shouldAutoApprove(
  config: GateConfig,
  task: PlanTask,
  checksResult: ChecksResult,
): boolean {
  if (typeof config.autoApprove === 'function') {
    return config.autoApprove(task, checksResult);
  }
  if (config.autoApprove === true) {
    return checksResult.passed;
  }
  return false;
}

/**
 * Present triage verdicts and let the user select which fixes to apply.
 *
 * All "fix" verdicts are pre-selected. The user can deselect false
 * positives or items they want to defer. Returns the filtered list.
 */
export async function presentTriageGate(verdicts: TriageVerdict[]): Promise<TriageVerdict[]> {
  if (verdicts.length === 0) return [];

  if (verdicts.length === 1) {
    const v = verdicts[0]!;
    const apply = await p.confirm({
      message: `Apply fix: ${v.description}${v.sha ? ` (${v.sha})` : ''}?`,
    });
    if (p.isCancel(apply)) return [];
    return apply ? [v] : [];
  }

  const selected = await p.multiselect({
    message: 'Select fixes to apply (space to toggle, enter to confirm)',
    options: verdicts.map((v, i) => ({
      value: i,
      label: v.description,
      hint: v.sha ? `fixup → ${v.sha}` : undefined,
    })),
    initialValues: verdicts.map((_, i) => i),
    required: false,
  });

  if (p.isCancel(selected)) return [];

  return (selected as number[]).map(i => verdicts[i]!);
}

function fmtStatus(status: 'pass' | 'fail'): string {
  switch (status) {
    case 'pass':
      return '✓ pass';
    case 'fail':
      return '✗ fail';
    default: {
      const _exhaustive: never = status;
      return String(_exhaustive);
    }
  }
}
