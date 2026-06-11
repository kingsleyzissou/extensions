// ── Plan types ──────────────────────────────────────────────────────────

export type Plan = {
  title: string;
  context: string;
  tasks: PlanTask[];
};

export type PlanTask = {
  id: number;
  title: string;
  body: string;
  fields: Record<string, string>;
};

// ── Config types ────────────────────────────────────────────────────────

export type PacifistaConfig = {
  checks: Check[];
  /** Command to run before staging commits (e.g. `npm run format`). */
  format?: string;
  pi: PiConfig;
  hooks: Hooks;
  prompt: PromptConfig;
  review: ReviewConfig;
  gate: GateConfig;
};

export type Check = {
  name: string;
  command: string;
  /** When to run this check.
   *  - `"task"` — after each task
   *  - `"final"` — only in the final check phase
   *  - `"both"` — after each task AND in the final phase (default)
   *  - `"tdd"` — after each task only when `**tdd**: false` is NOT set,
   *    and always in the final phase. Use this for test commands that
   *    should be skipped on config/scaffolding tasks.
   */
  scope?: 'task' | 'final' | 'both' | 'tdd';
  /** Mark this check as flaky. When true, `runChecks` will retry the
   *  check up to `retries` times (default 1) before marking it failed. */
  flaky?: boolean;
  /** Number of retry attempts for flaky checks. Defaults to 1.
   *  Ignored when `flaky` is not true. */
  retries?: number;
};

export type PiConfig = {
  sandbox: boolean;
  noSandbox: boolean;
};

export type Hooks = {
  beforeRun?: (ctx: RunContext) => Promise<void>;
  beforeTask?: (task: PlanTask, ctx: RunContext) => Promise<void>;
  afterTask?: (task: PlanTask, result: TaskResult, ctx: RunContext) => Promise<void>;
  beforeChecks?: (task: PlanTask, ctx: RunContext) => Promise<void>;
  onApprove?: (task: PlanTask, ctx: RunContext) => Promise<void>;
};

export type PromptConfig = {
  preamble?: string;
  rules?: string[];
};

export type ReviewConfig = {
  enabled: boolean;
  baseBranch?: string;
  reviewsDir?: string;
};

export type GateConfig = {
  autoApprove: boolean | ((task: PlanTask, result: ChecksResult) => boolean);
};

// ── Journal event types ─────────────────────────────────────────────────

export type JournalEvent =
  | {
      type: 'run:started';
      planPath: string;
      worktreePath: string;
      ts: string;
      tasks: { id: number; title: string }[];
    }
  | { type: 'task:started'; taskId: number; attempt: number; sessionId?: string; ts: string }
  | { type: 'task:session'; taskId: number; attempt: number; sessionId: string; ts: string }
  | {
      type: 'task:checked';
      taskId: number;
      attempt: number;
      checksResult: ChecksResult;
      changedFiles: string[];
      ts: string;
    }
  | { type: 'task:approved'; taskId: number; attempt: number; commitSha?: string; ts: string }
  | { type: 'task:revised'; taskId: number; attempt: number; feedback: string; ts: string }
  | {
      type: 'checks:auto-retry';
      taskId: number;
      attempt: number;
      retriesRemaining: number;
      checksResult: ChecksResult;
      ts: string;
    }
  | { type: 'task:rejected'; taskId: number; attempt: number; stop: boolean; ts: string }
  | { type: 'task:skipped'; taskId: number; ts: string }
  | {
      type: 'review:completed';
      reviewData: ReviewData;
      verdicts: TriageVerdict[];
      reviewSessionId?: string;
      triageSessionId?: string;
      ts: string;
    }
  | { type: 'run:paused'; ts: string }
  | { type: 'run:completed'; ts: string };

// ── State types (derived from journal replay) ───────────────────────────

export type RunState = {
  planPath: string;
  worktreePath: string;
  startedAt: string;
  currentTask: number;
  tasks: TaskState[];
  /** Session ID from the review (quorum) agent, if review completed. */
  reviewSessionId?: string;
  /** Session ID from the triage agent, if review completed. */
  triageSessionId?: string;
};

export type TaskState = {
  id: number;
  title: string;
  status: 'pending' | 'in_progress' | 'approved' | 'rejected' | 'skipped';
  attempts: Attempt[];
};

export type Attempt = {
  startedAt: string;
  completedAt?: string;
  checks?: ChecksResult;
  changedFiles?: string[];
  outcome?: 'approved' | 'revise' | 'rejected';
  revision?: string;
  sessionId?: string;
};

export type CheckResult = {
  name: string;
  status: 'pass' | 'fail';
  output?: string;
  /** True when the check definition has `flaky: true`. Useful for
   *  downstream rendering (e.g. showing a warning badge in the gate). */
  flaky?: boolean;
};

export type ChecksResult = {
  checks: CheckResult[];
  passed: boolean;
};

// ── Runner types ────────────────────────────────────────────────────────

export type RunOptions = {
  planPath: string;
  worktreePath: string;
  startFromTask?: number;
  commitPerTask?: boolean;
  skipReview?: boolean;
  /** Maximum revision attempts per task before aborting. Defaults to 5. */
  maxAttempts?: number;
  /** Maximum auto-retries on check failure before presenting the gate.
   *  Distinct from `maxAttempts` which caps total attempts. Defaults to 2. */
  maxAutoRetries?: number;
  configOverrides?: DeepPartial<PacifistaConfig>;
};

export type RunResult = {
  completed: number;
  total: number;
  tasks: TaskState[];
};

export type TaskResult = {
  exitCode: number;
  changedFiles: string[];
  checksResult?: ChecksResult;
};

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type RunContext = {
  worktreePath: string;
  config: PacifistaConfig;
  state: RunState;
  /** Run a shell command with captured output. Output is emitted
   *  to the TUI as subtle, padded text. */
  exec: (command: string, opts?: { cwd?: string }) => Promise<ExecResult>;
};

// ── Pi types ────────────────────────────────────────────────────────────

export type PiResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type PiCaptureResult = PiResult & {
  sessionId?: string;
};

export type PiExecOptions = {
  sandbox?: boolean;
  noSandbox?: boolean;
  noTools?: boolean;
};

// ── Gate types ──────────────────────────────────────────────────────────

export type GateAction =
  | { action: 'approve' }
  | { action: 'revise'; feedback: string }
  | { action: 'reject'; stop: boolean }
  | { action: 'quit' };

// ── Event types (for TUI/extension consumers) ──────────────────────────

export type PacifistaEvent =
  | { type: 'plan:loaded'; plan: Plan }
  | { type: 'setup:start'; command: string }
  | { type: 'setup:output'; text: string }
  | { type: 'setup:done'; ok: boolean }
  | { type: 'task:start'; task: PlanTask; attempt: number }
  | { type: 'task:complete'; task: PlanTask; exitCode: number }
  | { type: 'tool:start'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool:end'; toolName: string; isError: boolean }
  | { type: 'agent:thinking' }
  | { type: 'checks:start' }
  | { type: 'checks:done'; result: ChecksResult }
  | {
      type: 'checks:auto-retry';
      taskId: number;
      attempt: number;
      retriesRemaining: number;
      checksResult: ChecksResult;
    }
  | {
      type: 'gate:needed';
      task: PlanTask;
      attempt: number;
      changedFiles: string[];
      checksResult: ChecksResult;
    }
  | { type: 'task:approved'; task: PlanTask }
  | { type: 'task:rejected'; task: PlanTask }
  | { type: 'task:skipped'; task: PlanTask }
  | { type: 'run:summary'; result: RunResult }
  | { type: 'final-checks:start' }
  | { type: 'final-checks:done'; result: ChecksResult }
  | { type: 'final-checks:failed'; result: ChecksResult }
  | { type: 'review:start' }
  | { type: 'review:reviewing'; message?: string }
  | { type: 'review:triage' }
  | { type: 'review:verdicts'; verdicts: TriageVerdict[] }
  | { type: 'review:applying'; total: number }
  | { type: 'review:fix'; current: number; total: number; description: string }
  | { type: 'review:done'; fixes: number }
  | { type: 'state:saved' }
  | { type: 'error'; message: string };

export type EventHandler = (event: PacifistaEvent) => void;

// ── Utility types ───────────────────────────────────────────────────────

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// ── Review types ────────────────────────────────────────────────────────

export type ReviewData = {
  baseBranch: string;
  projectType: string;
  commitCount: number;
  reviewers: {
    name: string;
    label: string;
    output: string;
    exitCode: number;
    error?: string;
  }[];
};

export type TriageVerdict = {
  id: number;
  verdict: 'fix' | 'defer' | 'pushback';
  sha?: string;
  description: string;
};

/**
 * Handler that lets the user filter triage verdicts before fixes
 * are applied. Returns the subset of verdicts to actually fix.
 * If not provided, all "fix" verdicts are applied automatically.
 */
export type TriageGateHandler = (verdicts: TriageVerdict[]) => Promise<TriageVerdict[]>;
