import type { EventHandler, PiExecOptions, PiCaptureResult, PiResult } from './types.ts';

function buildBaseArgs(options?: PiExecOptions): string[] {
  // Always trust project-local files — kuma is the orchestrator and
  // has already been invoked from within the project. Without this,
  // non-interactive pi (-p) ignores project extensions (e.g. quorum)
  // unless the user has a saved trust decision.
  const args: string[] = ['--approve'];

  if (options?.noSandbox) {
    args.push('--no-container');
  } else if (options?.sandbox) {
    args.push('--sandbox-persist');
  }

  if (options?.noTools) {
    args.push('--no-tools');
  }

  return args;
}

type StreamEvent = {
  type: string;
  id?: string;
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
 * Read a ReadableStream line-by-line and parse each line as JSON.
 * Calls `onEvent` for every successfully parsed event.
 */
async function readJsonStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as StreamEvent);
      } catch {
        // Skip non-JSON lines
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    try {
      onEvent(JSON.parse(buffer) as StreamEvent);
    } catch {
      // Skip
    }
  }
}

/** Extract session ID from a stream event. */
function extractSessionId(event: StreamEvent): string | undefined {
  return event.type === 'session' && event.id ? event.id : undefined;
}

/**
 * Read a ReadableStream line-by-line as plain text.
 * Calls `onLine` for every non-empty line.
 */
async function readLineStream(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line) onLine(line);
    }
  }

  if (buffer.trim()) onLine(buffer);
}

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
): Promise<{ exitCode: number; sessionId?: string }> {
  const args = ['pi', '--mode', 'json', '-p', prompt, ...buildBaseArgs(options)];

  const proc = Bun.spawn(args, {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let sessionId: string | undefined;

  await readJsonStream(proc.stdout, event => {
    sessionId ??= extractSessionId(event);
    emitFromStreamEvent(event, onEvent);
  });

  const exitCode = await proc.exited;
  return { exitCode, sessionId };
}

function emitFromStreamEvent(event: StreamEvent, onEvent?: EventHandler): void {
  if (!onEvent) return;

  switch (event.type) {
    case 'tool_execution_start':
      if (event.toolName && event.args) {
        onEvent({
          type: 'tool:start',
          toolName: event.toolName,
          args: event.args,
        });
      }
      break;

    case 'tool_execution_end':
      if (event.toolName) {
        onEvent({
          type: 'tool:end',
          toolName: event.toolName,
          isError: event.isError ?? false,
        });
      }
      break;

    case 'message_update':
      if (event.assistantMessageEvent?.type === 'text_start') {
        onEvent({ type: 'agent:thinking' });
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
  const args = ['pi', '-p', prompt, ...buildBaseArgs(options)];

  const proc = Bun.spawn(args, {
    cwd: workdir,
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

/**
 * Execute a prompt via `pi --mode json -p` and capture both the
 * session ID (from the JSON stream) and the assistant's text output
 * (reassembled from `text_delta` events).
 *
 * Use this when you need to parse the agent's text response AND
 * record the session ID for later replay (e.g. flashback).
 */
export async function piCaptureWithSession(
  prompt: string,
  workdir: string,
  options?: PiExecOptions,
): Promise<PiCaptureResult> {
  const args = ['pi', '--mode', 'json', '-p', prompt, ...buildBaseArgs(options)];

  const proc = Bun.spawn(args, {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let sessionId: string | undefined;
  let textOutput = '';

  await readJsonStream(proc.stdout, event => {
    sessionId ??= extractSessionId(event);
    // Reassemble text output from text_delta events
    if (
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'text_delta' &&
      event.assistantMessageEvent.delta
    ) {
      textOutput += event.assistantMessageEvent.delta;
    }
  });

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { exitCode, stdout: textOutput, stderr, sessionId };
}

const KUMA_PROGRESS_PREFIX = '[kuma:progress] ';

/**
 * Run the ensemble review via `pi -p "/review <baseBranch>"`.
 *
 * When `outputPath` is provided, passes `--output <path>` to the
 * quorum extension so it writes structured JSON instead of
 * triggering agent synthesis.
 *
 * Streams stderr in real-time to pick up `[kuma:progress]` lines
 * from the quorum extension and emit them as `review:reviewing`
 * events for TUI progress updates.
 */
export async function piReview(
  baseBranch: string | undefined,
  workdir: string,
  options?: PiExecOptions & { outputPath?: string },
  onEvent?: EventHandler,
): Promise<PiCaptureResult> {
  const parts = ['/review'];
  if (options?.outputPath) {
    parts.push(`--output ${options.outputPath}`);
  }
  if (baseBranch) {
    parts.push(baseBranch);
  }
  const prompt = parts.join(' ');
  const args = ['pi', '--mode', 'json', '-p', prompt, ...buildBaseArgs(options)];

  const proc = Bun.spawn(args, {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let sessionId: string | undefined;

  // Stream stderr for progress lines, collect the rest
  const stderrLines: string[] = [];

  // Read both streams concurrently
  await Promise.all([
    readJsonStream(proc.stdout, event => {
      sessionId ??= extractSessionId(event);
    }),
    readLineStream(proc.stderr, line => {
      if (line.startsWith(KUMA_PROGRESS_PREFIX) && onEvent) {
        onEvent({
          type: 'review:reviewing',
          message: line.slice(KUMA_PROGRESS_PREFIX.length),
        });
      } else {
        stderrLines.push(line);
      }
    }),
  ]);

  const exitCode = await proc.exited;
  return { exitCode, stdout: '', stderr: stderrLines.join('\n'), sessionId };
}
