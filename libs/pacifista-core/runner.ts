import type {
  EventHandler,
  ExecResult,
  ChecksResult,
  GateAction,
  GateConfig,
  Plan,
  PlanTask,
  RunContext,
  RunOptions,
  RunResult,
  RunState,
} from './types.ts';
import { loadConfig } from './config.ts';
import { parsePlan } from './plan.ts';
import { appendEvent, getJournalPath, journalExists, replayState } from './state.ts';
import { piStream } from './pi.ts';
import { buildTaskPrompt } from './prompt.ts';
import { runChecks } from './checks.ts';
import { runReviewStage } from './review.ts';
import { getHead, getChangedFiles, stageAndCommit } from './git.ts';
import type { TriageGateHandler } from './types.ts';

export type GateHandler = (
  task: PlanTask,
  attempt: number,
  changedFiles: string[],
  checksResult: ChecksResult,
  config: GateConfig,
) => Promise<GateAction>;

/**
 * Main orchestration loop.
 *
 * All UI is handled externally via `onEvent` and `onGate` callbacks.
 * The runner emits events and waits for gate decisions — it never
 * writes to stdout/stderr.
 */
export async function runPlan(
  options: RunOptions,
  onEvent: EventHandler,
  onGate: GateHandler,
  onTriageGate?: TriageGateHandler,
): Promise<RunResult> {
  const config = await loadConfig(options.worktreePath, options.configOverrides);

  const planMarkdown = await Bun.file(options.planPath).text();
  const plan: Plan = parsePlan(planMarkdown);

  onEvent({ type: 'plan:loaded', plan });

  const journalPath = await getJournalPath(options.worktreePath);
  const state = await loadOrCreateState(journalPath, options, plan);

  const ctx: RunContext = {
    worktreePath: options.worktreePath,
    config,
    state,
    exec: async (command, opts) => {
      const result = await execCapture(command, opts?.cwd ?? options.worktreePath);
      const output = (result.stdout + result.stderr).trim();
      if (output) {
        onEvent({ type: 'setup:output', text: output });
      }
      return result;
    },
  };

  // Run setup command once before the first task (e.g. npm ci).
  // Skipped on resume when tasks have already been completed.
  const startFrom = options.startFromTask ?? 1;
  const hasCompletedTasks = state.tasks.some(
    t => t.status === 'approved' || t.status === 'skipped',
  );

  if (config.hooks.beforeRun && !hasCompletedTasks) {
    onEvent({ type: 'setup:start', command: 'beforeRun' });
    try {
      await config.hooks.beforeRun(ctx);
      onEvent({ type: 'setup:done', ok: true });
    } catch (err) {
      onEvent({ type: 'setup:done', ok: false });
      onEvent({
        type: 'error',
        message: `beforeRun hook failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return buildResult(state);
    }
  }

  for (const task of plan.tasks) {
    if (task.id < startFrom) continue;

    const taskState = state.tasks.find(t => t.id === task.id);
    if (!taskState) continue;
    if (taskState.status === 'approved' || taskState.status === 'skipped') {
      continue;
    }

    let approved = false;
    let revision: string | undefined;
    const maxAttempts = options.maxAttempts ?? 5;

    while (!approved) {
      // Re-resolve after replays from prior iterations
      const currentTask = state.tasks.find(t => t.id === task.id)!;
      const attemptNum = currentTask.attempts.length + 1;

      if (attemptNum > maxAttempts) {
        onEvent({
          type: 'error',
          message: `Task ${task.id} exceeded maximum attempts (${maxAttempts})`,
        });
        await appendEvent(journalPath, {
          type: 'task:rejected',
          taskId: task.id,
          attempt: attemptNum - 1,
          stop: false,
          ts: new Date().toISOString(),
        });
        break;
      }

      const ts = new Date().toISOString();

      // Hook: beforeTask
      if (config.hooks.beforeTask) {
        await config.hooks.beforeTask(task, ctx);
      }

      const prompt = buildTaskPrompt(plan, task, {
        revision,
        promptConfig: config.prompt,
      });

      onEvent({
        type: 'task:start',
        task,
        attempt: attemptNum,
      });

      await appendEvent(journalPath, {
        type: 'task:started',
        taskId: task.id,
        attempt: attemptNum,
        ts,
      });

      // Replay to keep in-memory state current
      Object.assign(state, await replayState(journalPath));

      const result = await piStream(
        prompt,
        options.worktreePath,
        { sandbox: config.pi.sandbox, noSandbox: config.pi.noSandbox },
        onEvent,
      );

      // Backfill session ID now that we have it from pi's JSON stream
      if (result.sessionId) {
        await appendEvent(journalPath, {
          type: 'task:session',
          taskId: task.id,
          attempt: attemptNum,
          sessionId: result.sessionId,
          ts: new Date().toISOString(),
        });
      }

      onEvent({
        type: 'task:complete',
        task,
        exitCode: result.exitCode,
      });

      // Detect changed files
      const changedFiles = await getChangedFiles(options.worktreePath);

      // Hook: beforeChecks
      if (config.hooks.beforeChecks) {
        await config.hooks.beforeChecks(task, ctx);
      }

      // Checks
      onEvent({ type: 'checks:start' });
      const checksResult = await runChecks(options.worktreePath, config.checks, 'task');

      await appendEvent(journalPath, {
        type: 'task:checked',
        taskId: task.id,
        attempt: attemptNum,
        checksResult,
        changedFiles,
        ts: new Date().toISOString(),
      });

      onEvent({ type: 'checks:done', result: checksResult });

      // Gate
      onEvent({
        type: 'gate:needed',
        task,
        attempt: attemptNum,
        changedFiles,
        checksResult,
      });

      const action = await onGate(task, attemptNum, changedFiles, checksResult, config.gate);

      switch (action.action) {
        case 'approve': {
          // Commit on the host (not inside sandbox)
          let commitSha: string | undefined;
          if (options.commitPerTask) {
            const commitMsg = buildCommitMessage(task);
            commitSha = await commitChanges(options.worktreePath, commitMsg);
          }

          await appendEvent(journalPath, {
            type: 'task:approved',
            taskId: task.id,
            attempt: attemptNum,
            commitSha,
            ts: new Date().toISOString(),
          });

          approved = true;
          onEvent({ type: 'task:approved', task });
          if (config.hooks.onApprove) {
            await config.hooks.onApprove(task, ctx);
          }
          break;
        }

        case 'revise':
          await appendEvent(journalPath, {
            type: 'task:revised',
            taskId: task.id,
            attempt: attemptNum,
            feedback: action.feedback,
            ts: new Date().toISOString(),
          });
          revision = action.feedback;
          break;

        case 'reject':
          await appendEvent(journalPath, {
            type: 'task:rejected',
            taskId: task.id,
            attempt: attemptNum,
            stop: action.stop,
            ts: new Date().toISOString(),
          });

          approved = true;
          onEvent({ type: 'task:rejected', task });
          if (action.stop) {
            return buildResult(await replayState(journalPath));
          }
          break;

        case 'quit':
          await appendEvent(journalPath, {
            type: 'run:paused',
            ts: new Date().toISOString(),
          });
          onEvent({ type: 'state:saved' });
          return buildResult(await replayState(journalPath));
      }

      // Hook: afterTask
      if (config.hooks.afterTask) {
        // Replay to get latest state for the hook
        Object.assign(state, await replayState(journalPath));
        await config.hooks.afterTask(
          task,
          { exitCode: result.exitCode, changedFiles, checksResult },
          ctx,
        );
      }
    }
  }

  // Final checks — run all checks scoped to "final" or "both".
  onEvent({ type: 'final-checks:start' });
  const finalChecks = await runChecks(options.worktreePath, config.checks, 'final');
  if (finalChecks.passed) {
    onEvent({ type: 'final-checks:done', result: finalChecks });
  } else {
    onEvent({ type: 'final-checks:failed', result: finalChecks });
  }

  // Review stage
  if (!options.skipReview) {
    await runReviewStage(options.worktreePath, config, journalPath, onEvent, onGate, onTriageGate);
  }

  await appendEvent(journalPath, {
    type: 'run:completed',
    ts: new Date().toISOString(),
  });

  const finalState = await replayState(journalPath);
  const result = buildResult(finalState);
  onEvent({ type: 'run:summary', result });
  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function loadOrCreateState(
  journalPath: string,
  options: RunOptions,
  plan: Plan,
): Promise<RunState> {
  if (await journalExists(journalPath)) {
    return replayState(journalPath);
  }

  // New run — write the initial event
  await appendEvent(journalPath, {
    type: 'run:started',
    planPath: options.planPath,
    worktreePath: options.worktreePath,
    ts: new Date().toISOString(),
    tasks: plan.tasks.map(t => ({ id: t.id, title: t.title })),
  });

  return replayState(journalPath);
}

async function getChangedFiles(workdir: string): Promise<string[]> {
  const proc = Bun.spawn(['git', 'diff', '--name-only', 'HEAD'], {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  return stdout
    .split('\n')
    .map(f => f.trim())
    .filter(Boolean);
}

/**
 * Build a commit message from a task.
 *
 * Uses the `commit` field from the plan if present, otherwise
 * falls back to the task title.
 */
function buildCommitMessage(task: PlanTask): string {
  let msg: string;
  if (task.fields['commit']) {
    // Strip surrounding backticks if present
    msg = task.fields['commit'].replace(/^`|`$/g, '');
  } else {
    // Fall back to the task title as-is — the plan-feature skill
    // should produce titles that work as commit subjects.
    msg = task.title;
  }

  // Sanitize: take only the first line to prevent trailer injection
  // via embedded newlines (e.g. injecting Co-authored-by).
  return msg.split('\n')[0]!.trim();
}

/**
 * Stage all changes and commit on the host.
 *
 * Runs outside the sandbox so the user's git config, GPG keys,
 * and signing preferences are all available.
 *
 * Returns the commit SHA on success, undefined if nothing to commit.
 */
async function commitChanges(workdir: string, message: string): Promise<string | undefined> {
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

  // Read stderr before awaiting exit — the pipe data can be
  // lost if the process exits before we start reading.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(commit.stdout).text(),
    new Response(commit.stderr).text(),
    commit.exited,
  ]);

  if (exitCode !== 0) {
    // "nothing to commit" is not an error — the agent may not
    // have changed anything (e.g. on a revision that was a no-op).
    if (!stderr.includes('nothing to commit')) {
      throw new Error(`git commit failed (exit ${exitCode}): ${stderr}`);
    }
    return undefined;
  }

  // Extract short SHA from commit output, e.g. "[branch abc1234] message"
  const shaMatch = stdout.match(/\[\S+\s+([a-f0-9]+)\]/);
  return shaMatch?.[1];
}

async function execCapture(command: string, cwd: string): Promise<ExecResult> {
  const proc = Bun.spawn(['sh', '-c', command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function buildResult(state: RunState): RunResult {
  return {
    completed: state.tasks.filter(t => t.status === 'approved').length,
    total: state.tasks.length,
    tasks: state.tasks,
  };
}
