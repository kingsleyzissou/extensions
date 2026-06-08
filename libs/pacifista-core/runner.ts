import type {
  Attempt,
  EventHandler,
  GateAction,
  GateConfig,
  Plan,
  PlanTask,
  QcResult,
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
import { runQualityChecks } from "./qc.ts";
import { runReviewStage } from "./review.ts";

export type GateHandler = (
  task: PlanTask,
  attempt: number,
  changedFiles: string[],
  qc: QcResult,
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
  };

  const startFrom = options.startFromTask ?? 1;

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

    while (!approved) {
      const attempt: Attempt = { startedAt: new Date().toISOString() };
      taskState.attempts.push(attempt);

      // Hook: beforeTask
      if (config.hooks.beforeTask) {
        await config.hooks.beforeTask(task, ctx);
      }

      const prompt = buildTaskPrompt(plan, task, {
        revision,
        commitPerTask: options.commitPerTask,
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

      // Hook: beforeQc
      if (config.hooks.beforeQc) {
        await config.hooks.beforeQc(task, ctx);
      }

      // QC
      onEvent({ type: "qc:start" });
      const qc = await runQualityChecks(options.worktreePath, config.qc);
      attempt.qc = qc;
      attempt.completedAt = new Date().toISOString();
      await saveState(statePath, state);

      onEvent({ type: "qc:done", result: qc });

      // Gate
      onEvent({
        type: "gate:needed",
        task,
        attempt: taskState.attempts.length,
        changedFiles,
        qc,
      });

      const action = await onGate(
        task,
        taskState.attempts.length,
        changedFiles,
        qc,
        config.gate,
      );

      switch (action.action) {
        case "approve":
          attempt.outcome = "approved";
          taskState.status = "approved";
          approved = true;
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
          { exitCode: result.exitCode, changedFiles, qc },
          ctx,
        );
      }

      await saveState(statePath, state);
    }
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

function buildResult(state: RunState): RunResult {
  return {
    completed: state.tasks.filter((t) => t.status === "approved").length,
    total: state.tasks.length,
    tasks: state.tasks,
  };
}
