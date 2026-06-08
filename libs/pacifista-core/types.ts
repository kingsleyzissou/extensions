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
  qc: QcConfig;
  pi: PiConfig;
  hooks: Hooks;
  prompt: PromptConfig;
  review: ReviewConfig;
  gate: GateConfig;
};

export type QcConfig = {
  lint: string;
  typecheck: string;
  testCmd: string;
};

export type PiConfig = {
  sandbox: boolean;
  noSandbox: boolean;
};

export type Hooks = {
  beforeTask?: (task: PlanTask, ctx: RunContext) => Promise<void>;
  afterTask?: (task: PlanTask, result: TaskResult, ctx: RunContext) => Promise<void>;
  beforeQc?: (task: PlanTask, ctx: RunContext) => Promise<void>;
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
  autoApprove: boolean | ((task: PlanTask, qc: QcResult) => boolean);
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
  qc?: QcResult;
  changedFiles?: string[];
  outcome?: "approved" | "revise" | "rejected";
  revision?: string;
};

export type QcResult = {
  lint: "pass" | "fail";
  typecheck: "pass" | "fail";
  tests: { status: "pass" | "fail" | "skipped"; files: number };
  missingTests?: string[];
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
  qc?: QcResult;
};

export type RunContext = {
  worktreePath: string;
  config: PacifistaConfig;
  state: RunState;
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
  | { type: "task:start"; task: PlanTask; attempt: number }
  | { type: "task:complete"; task: PlanTask; exitCode: number }
  | { type: "tool:start"; toolName: string; args: Record<string, unknown> }
  | { type: "tool:end"; toolName: string; isError: boolean }
  | { type: "agent:thinking" }
  | { type: "qc:start" }
  | { type: "qc:done"; result: QcResult }
  | { type: "gate:needed"; task: PlanTask; attempt: number; changedFiles: string[]; qc: QcResult }
  | { type: "task:approved"; task: PlanTask }
  | { type: "task:rejected"; task: PlanTask }
  | { type: "task:skipped"; task: PlanTask }
  | { type: "run:summary"; result: RunResult }
  | { type: "review:start" }
  | { type: "review:done"; fixes: number }
  | { type: "state:saved" }
  | { type: "error"; message: string };

export type EventHandler = (event: PacifistaEvent) => void;

// ── Utility types ───────────────────────────────────────────────────────

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
