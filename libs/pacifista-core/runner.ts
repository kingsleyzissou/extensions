import type {
  Attempt,
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
} from "./types.ts";
import { loadConfig } from "./config.ts";
import { parsePlan } from "./plan.ts";
import { createState, getStatePath, loadState, saveState } from "./state.ts";
import { piStream } from "./pi.ts";
import { buildTaskPrompt } from "./prompt.ts";
import { runChecks } from "./checks.ts";
import { runReviewStage } from "./review.ts";

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
): Promise<RunResult> {
  const config = await loadConfig(
    options.worktreePath,
    options.configOverrides,
    options.projectRoot,
  );

  const planMarkdown = await Bun.file(options.planPath).text();
  const plan: Plan = parsePlan(planMarkdown);

  onEvent({ type: "plan:loaded", plan });

  // State lives at project root, not inside the worktree
  const stateRoot = options.projectRoot ?? options.worktreePath;
  const statePath = getStatePath(stateRoot);
  const state = await loadOrCreateState(statePath, options, plan);

  const ctx: RunContext = {
    worktreePath: options.worktreePath,
    config,
    state,
    exec: async (command, opts) => {
      const result = await execCapture(
        command,
        opts?.cwd ?? options.worktreePath,
      );
      const output = (result.stdout + result.stderr).trim();
      if (output) {
        onEvent({ type: "setup:output", text: output });
      }
      return result;
    },
  };

  // Run setup command once before the first task (e.g. npm ci).
  // Skipped on resume when tasks have already been completed.
  const startFrom = options.startFromTask ?? 1;
  const hasCompletedTasks = state.tasks.some(
    (t) => t.status === "approved" || t.status === "skipped",
  );

  if (config.hooks.beforeRun && !hasCompletedTasks) {
    onEvent({ type: "setup:start", command: "beforeRun" });
    try {
      await config.hooks.beforeRun(ctx);
      onEvent({ type: "setup:done", ok: true });
    } catch (err) {
      onEvent({ type: "setup:done", ok: false });
      onEvent({
        type: "error",
        message: `beforeRun hook failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return buildResult(state);
    }
  }

  for (const task of plan.tasks) {
    if (task.id < startFrom) continue;

    const taskState = state.tasks.find((t) => t.id === task.id);
    if (!taskState) continue;
    if (taskState.status === "approved" || taskState.status === "skipped") {
      continue;
    }

    state.currentTask = task.id;
    taskState.status = "in_progress";
    await saveState(statePath, state);

    let approved = false;
    let revision: string | undefined;
    const maxAttempts = options.maxAttempts ?? 5;

    while (!approved) {
      if (taskState.attempts.length >= maxAttempts) {
        taskState.status = "rejected";
        onEvent({
          type: "error",
          message: `Task ${task.id} exceeded maximum attempts (${maxAttempts})`,
        });
        await saveState(statePath, state);
        break;
      }

      const attempt: Attempt = { startedAt: new Date().toISOString() };
      taskState.attempts.push(attempt);

      // Hook: beforeTask
      if (config.hooks.beforeTask) {
        await config.hooks.beforeTask(task, ctx);
      }

      const prompt = buildTaskPrompt(plan, task, {
        revision,
        promptConfig: config.prompt,
      });

      onEvent({
        type: "task:start",
        task,
        attempt: taskState.attempts.length,
      });

      const result = await piStream(
        prompt,
        options.worktreePath,
        { sandbox: config.pi.sandbox, noSandbox: config.pi.noSandbox },
        onEvent,
      );

      onEvent({
        type: "task:complete",
        task,
        exitCode: result.exitCode,
      });

      // Detect changed files
      const changedFiles = await getChangedFiles(options.worktreePath);
      attempt.changedFiles = changedFiles;

      // Hook: beforeChecks
      if (config.hooks.beforeChecks) {
        await config.hooks.beforeChecks(task, ctx);
      }

      // Checks
      onEvent({ type: "checks:start" });
      const checksResult = await runChecks(options.worktreePath, config.checks, "task");
      attempt.checks = checksResult;
      attempt.completedAt = new Date().toISOString();
      await saveState(statePath, state);

      onEvent({ type: "checks:done", result: checksResult });

      // Gate
      onEvent({
        type: "gate:needed",
        task,
        attempt: taskState.attempts.length,
        changedFiles,
        checksResult,
      });

      const action = await onGate(
        task,
        taskState.attempts.length,
        changedFiles,
        checksResult,
        config.gate,
      );

      switch (action.action) {
        case "approve":
          attempt.outcome = "approved";
          taskState.status = "approved";
          approved = true;

          // Commit on the host (not inside sandbox)
          if (options.commitPerTask) {
            const commitMsg = buildCommitMessage(task);
            await commitChanges(options.worktreePath, commitMsg);
          }

          onEvent({ type: "task:approved", task });
          if (config.hooks.onApprove) {
            await config.hooks.onApprove(task, ctx);
          }
          break;

        case "revise":
          attempt.outcome = "revise";
          attempt.revision = action.feedback;
          revision = action.feedback;
          break;

        case "reject":
          attempt.outcome = "rejected";
          taskState.status = "rejected";
          approved = true;
          onEvent({ type: "task:rejected", task });
          if (action.stop) {
            await saveState(statePath, state);
            return buildResult(state);
          }
          break;

        case "quit":
          await saveState(statePath, state);
          onEvent({ type: "state:saved" });
          return buildResult(state);
      }

      // Hook: afterTask
      if (config.hooks.afterTask) {
        await config.hooks.afterTask(
          task,
          { exitCode: result.exitCode, changedFiles, checksResult },
          ctx,
        );
      }

      await saveState(statePath, state);
    }
  }

  // Final checks — run all checks scoped to "final" or "both".
  onEvent({ type: "final-checks:start" });
  const finalChecks = await runChecks(options.worktreePath, config.checks, "final");
  if (finalChecks.passed) {
    onEvent({ type: "final-checks:done", result: finalChecks });
  } else {
    onEvent({ type: "final-checks:failed", result: finalChecks });
  }

  // Review stage
  if (!options.skipReview) {
    await runReviewStage(
      options.worktreePath,
      config,
      plan.title,
      onEvent,
      onGate,
    );
  }

  const result = buildResult(state);
  onEvent({ type: "run:summary", result });
  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function loadOrCreateState(
  statePath: string,
  options: RunOptions,
  plan: Plan,
) {
  const stateFile = Bun.file(statePath);
  if (await stateFile.exists()) {
    return loadState(statePath);
  }
  return createState(options.planPath, options.worktreePath, plan.tasks);
}

async function getChangedFiles(workdir: string): Promise<string[]> {
  const proc = Bun.spawn(
    ["git", "diff", "--name-only", "HEAD"],
    { cwd: workdir, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  return stdout
    .split("\n")
    .map((f) => f.trim())
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
  if (task.fields["commit"]) {
    // Strip surrounding backticks if present
    msg = task.fields["commit"].replace(/^`|`$/g, "");
  } else {
    // Fall back to the task title as-is — the plan-feature skill
    // should produce titles that work as commit subjects.
    msg = task.title;
  }

  // Sanitize: take only the first line to prevent trailer injection
  // via embedded newlines (e.g. injecting Co-authored-by).
  return msg.split("\n")[0]!.trim();
}

/**
 * Stage all changes and commit on the host.
 *
 * Runs outside the sandbox so the user's git config, GPG keys,
 * and signing preferences are all available.
 */
async function commitChanges(
  workdir: string,
  message: string,
): Promise<void> {
  const add = Bun.spawn(["git", "add", "-A"], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const addStderr = await new Response(add.stderr).text();
  const addExit = await add.exited;

  if (addExit !== 0) {
    throw new Error(`git add failed (exit ${addExit}): ${addStderr}`);
  }

  const commit = Bun.spawn(["git", "commit", "-m", message], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Read stderr before awaiting exit — the pipe data can be
  // lost if the process exits before we start reading.
  const [stderr, exitCode] = await Promise.all([
    new Response(commit.stderr).text(),
    commit.exited,
  ]);

  if (exitCode !== 0) {
    // "nothing to commit" is not an error — the agent may not
    // have changed anything (e.g. on a revision that was a no-op).
    if (!stderr.includes("nothing to commit")) {
      throw new Error(`git commit failed (exit ${exitCode}): ${stderr}`);
    }
  }
}

async function execCapture(
  command: string,
  cwd: string,
): Promise<ExecResult> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
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
    completed: state.tasks.filter((t) => t.status === "approved").length,
    total: state.tasks.length,
    tasks: state.tasks,
  };
}
