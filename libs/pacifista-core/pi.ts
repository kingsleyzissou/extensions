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
  const args = ['pi', '--mode', 'json', '-p', prompt, ...buildBaseArgs(options)];

  const proc = Bun.spawn(args, {
    cwd: workdir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const reader = proc.stdout.getReader();
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

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sessionId: string | undefined;
  let textOutput = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === 'session' && 'id' in event) {
          sessionId = (event as StreamEvent & { id: string }).id;
        }
        // Reassemble text output from text_delta events
        if (
          event.type === 'message_update' &&
          event.assistantMessageEvent?.type === 'text_delta' &&
          event.assistantMessageEvent.delta
        ) {
          textOutput += event.assistantMessageEvent.delta;
        }
      } catch {
        // Skip non-JSON lines
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer) as StreamEvent;
      if (
        event.type === 'message_update' &&
        event.assistantMessageEvent?.type === 'text_delta' &&
        event.assistantMessageEvent.delta
      ) {
        textOutput += event.assistantMessageEvent.delta;
      }
    } catch {
      // Skip
    }
  }

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

  // Stream stdout for session ID (--mode json)
  const stdoutReader = proc.stdout.getReader();
  const stdoutDecoder = new TextDecoder();
  let stdoutBuffer = '';
  let sessionId: string | undefined;

  const parseStdoutLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line) as StreamEvent;
      if (event.type === 'session' && 'id' in event) {
        sessionId = (event as StreamEvent & { id: string }).id;
      }
    } catch {
      // Skip non-JSON lines
    }
  };

  // Stream stderr for progress lines, collect the rest
  const stderrReader = proc.stderr.getReader();
  const stderrDecoder = new TextDecoder();
  let stderrBuffer = '';
  const stderrLines: string[] = [];

  const parseStderrLine = (line: string) => {
    if (line.startsWith(KUMA_PROGRESS_PREFIX) && onEvent) {
      onEvent({
        type: 'review:reviewing',
        message: line.slice(KUMA_PROGRESS_PREFIX.length),
      });
    } else {
      stderrLines.push(line);
    }
  };

  // Read both streams concurrently
  const readStdout = async () => {
    for (;;) {
      const { done, value } = await stdoutReader.read();
      if (done) break;
      stdoutBuffer += stdoutDecoder.decode(value, { stream: true });
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) parseStdoutLine(line);
    }
    if (stdoutBuffer.trim()) parseStdoutLine(stdoutBuffer);
  };

  const readStderr = async () => {
    for (;;) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      stderrBuffer += stderrDecoder.decode(value, { stream: true });
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) parseStderrLine(line);
    }
    if (stderrBuffer.trim()) stderrLines.push(stderrBuffer);
  };

  await Promise.all([readStdout(), readStderr()]);
  const exitCode = await proc.exited;

  return { exitCode, stdout: '', stderr: stderrLines.join('\n'), sessionId };
}
