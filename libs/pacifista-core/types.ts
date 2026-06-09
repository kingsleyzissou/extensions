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
  pi: PiConfig;
  hooks: Hooks;
  prompt: PromptConfig;
  review: ReviewConfig;
  gate: GateConfig;
};

export type Check = {
  name: string;
  command: string;
  scope?: "task" | "final" | "both";
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

// ── State types ─────────────────────────────────────────────────────────

export type RunState = {
  planPath: string;
  worktreePath: string;
  startedAt: string;
  currentTask: number;
  tasks: TaskState[];
};

export type TaskState = {
  id: number;
  title: string;
  status: "pending" | "in_progress" | "approved" | "rejected" | "skipped";
  attempts: Attempt[];
};

export type Attempt = {
  startedAt: string;
  completedAt?: string;
  checks?: ChecksResult;
  changedFiles?: string[];
  outcome?: "approved" | "revise" | "rejected";
  revision?: string;
};

export type CheckResult = {
  name: string;
  status: "pass" | "fail";
  output?: string;
};

export type ChecksResult = {
  checks: CheckResult[];
  passed: boolean;
};

// ── Runner types ────────────────────────────────────────────────────────

export type RunOptions = {
  planPath: string;
  worktreePath: string;
  projectRoot?: string;
  startFromTask?: number;
  commitPerTask?: boolean;
  skipReview?: boolean;
  /** Maximum revision attempts per task before aborting. Defaults to 5. */
  maxAttempts?: number;
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

export type PiExecOptions = {
  sandbox?: boolean;
  noSandbox?: boolean;
};

// ── Gate types ──────────────────────────────────────────────────────────

export type GateAction =
  | { action: "approve" }
  | { action: "revise"; feedback: string }
  | { action: "reject"; stop: boolean }
  | { action: "quit" };

// ── Event types (for TUI/extension consumers) ──────────────────────────

export type PacifistaEvent =
  | { type: "plan:loaded"; plan: Plan }
  | { type: "setup:start"; command: string }
  | { type: "setup:output"; text: string }
  | { type: "setup:done"; ok: boolean }
  | { type: "task:start"; task: PlanTask; attempt: number }
  | { type: "task:complete"; task: PlanTask; exitCode: number }
  | { type: "tool:start"; toolName: string; args: Record<string, unknown> }
  | { type: "tool:end"; toolName: string; isError: boolean }
  | { type: "agent:thinking" }
  | { type: "checks:start" }
  | { type: "checks:done"; result: ChecksResult }
  | { type: "gate:needed"; task: PlanTask; attempt: number; changedFiles: string[]; checksResult: ChecksResult }
  | { type: "task:approved"; task: PlanTask }
  | { type: "task:rejected"; task: PlanTask }
  | { type: "task:skipped"; task: PlanTask }
  | { type: "run:summary"; result: RunResult }
  | { type: "final-checks:start" }
  | { type: "final-checks:done"; result: ChecksResult }
  | { type: "final-checks:failed"; result: ChecksResult }
  | { type: "review:start" }
  | { type: "review:done"; fixes: number }
  | { type: "state:saved" }
  | { type: "error"; message: string };

export type EventHandler = (event: PacifistaEvent) => void;

// ── Utility types ───────────────────────────────────────────────────────

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
