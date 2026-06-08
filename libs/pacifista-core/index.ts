// Core logic
export { runPlan } from "./runner.ts";
export { parsePlan } from "./plan.ts";
export { loadConfig } from "./config.ts";
export { loadState, saveState, createState, getStatePath } from "./state.ts";
export { piStream, piCapture, piReview } from "./pi.ts";
export { buildTaskPrompt, buildTriagePrompt, buildFixPrompt } from "./prompt.ts";
export { runQualityChecks, detectTests, runScopedTests } from "./qc.ts";
export { runReviewStage } from "./review.ts";

// Types
export type {
  Plan,
  PlanTask,
  PacifistaConfig,
  QcConfig,
  PiConfig,
  Hooks,
  PromptConfig,
  ReviewConfig,
  GateConfig,
  RunState,
  TaskState,
  Attempt,
  QcResult,
  RunOptions,
  RunResult,
  TaskResult,
  RunContext,
  PiResult,
  PiExecOptions,
  GateAction,
  PacifistaEvent,
  EventHandler,
  DeepPartial,
} from "./types.ts";

export type { GateHandler } from "./runner.ts";
export type { TriageVerdict } from "./review.ts";
