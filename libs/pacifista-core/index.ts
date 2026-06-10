// Core logic
export { runPlan } from './runner.ts';
export { parsePlan } from './plan.ts';
export { loadConfig } from './config.ts';
export { appendEvent, replayState, journalExists, getJournalPath } from './state.ts';
export { piStream, piCapture, piCaptureWithSession, piReview } from './pi.ts';
export { buildTaskPrompt, buildTriagePrompt, buildFixPrompt } from './prompt.ts';
export { runChecks } from './checks.ts';
export { runReviewStage } from './review.ts';
export { detectBareRepoRoot, getHead, getChangedFiles, stageAndCommit, autosquash } from './git.ts';

// Types
export type {
  Plan,
  PlanTask,
  PacifistaConfig,
  Check,
  PiConfig,
  Hooks,
  PromptConfig,
  ReviewConfig,
  GateConfig,
  RunState,
  TaskState,
  Attempt,
  CheckResult,
  ChecksResult,
  ExecResult,
  JournalEvent,
  RunOptions,
  RunResult,
  TaskResult,
  RunContext,
  PiResult,
  PiCaptureResult,
  PiExecOptions,
  GateAction,
  PacifistaEvent,
  EventHandler,
  DeepPartial,
  ReviewData,
  TriageVerdict,
  TriageGateHandler,
} from './types.ts';

export type { GateHandler } from './runner.ts';
