import type { EventHandler, PiExecOptions, PiResult } from "./types.ts";

function buildBaseArgs(options?: PiExecOptions): string[] {
  // Always trust project-local files — kuma is the orchestrator and
  // has already been invoked from within the project. Without this,
  // non-interactive pi (-p) ignores project extensions (e.g. quorum)
  // unless the user has a saved trust decision.
  const args: string[] = ["--approve"];

  if (options?.noSandbox) {
    args.push("--no-container");
  } else if (options?.sandbox) {
    args.push("--sandbox-persist");
  }

  return args;
}

type StreamEvent = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
  result?: unknown;
  isError?: boolean;
};

/**
 * Execute a prompt via `pi --mode json` and emit events for each
 * tool call, text chunk, etc. Consumers (TUI, extension) decide
 * how to render progress.
 */
export async function piStream(
  prompt: string,
  workdir: string,
  options?: PiExecOptions,
  onEvent?: EventHandler,
): Promise<{ exitCode: number }> {
  const args = ["pi", "--mode", "json", "-p", prompt, ...buildBaseArgs(options)];

  const proc = Bun.spawn(args, {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as StreamEvent;
        emitFromStreamEvent(event, onEvent);
      } catch {
        // Skip non-JSON lines
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer) as StreamEvent;
      emitFromStreamEvent(event, onEvent);
    } catch {
      // Skip
    }
  }

  const exitCode = await proc.exited;
  return { exitCode };
}

function emitFromStreamEvent(event: StreamEvent, onEvent?: EventHandler): void {
  if (!onEvent) return;

  switch (event.type) {
    case "tool_execution_start":
      if (event.toolName && event.args) {
        onEvent({
          type: "tool:start",
          toolName: event.toolName,
          args: event.args,
        });
      }
      break;

    case "tool_execution_end":
      if (event.toolName) {
        onEvent({
          type: "tool:end",
          toolName: event.toolName,
          isError: event.isError ?? false,
        });
      }
      break;

    case "message_update":
      if (event.assistantMessageEvent?.type === "text_start") {
        onEvent({ type: "agent:thinking" });
      }
      break;
  }
}

/**
 * Execute a prompt via `pi -p` and capture stdout/stderr.
 * Use this for review/triage where we need to parse the output.
 */
export async function piCapture(
  prompt: string,
  workdir: string,
  options?: PiExecOptions,
): Promise<PiResult> {
  const args = ["pi", "-p", prompt, ...buildBaseArgs(options)];

  const proc = Bun.spawn(args, {
    cwd: workdir,
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

/**
 * Run the ensemble review via `pi -p "/review <baseBranch>"`.
 */
export async function piReview(
  baseBranch: string | undefined,
  workdir: string,
  options?: PiExecOptions,
): Promise<PiResult> {
  const reviewCmd = baseBranch ? `/review ${baseBranch}` : "/review";
  return piCapture(reviewCmd, workdir, options);
}
