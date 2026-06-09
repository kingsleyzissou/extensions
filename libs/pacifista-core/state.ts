import { appendFile, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { JournalEvent, RunState, TaskState } from "./types.ts";
import { detectBareRepoRoot } from "./git.ts";

const JOURNAL_FILE = "journal.jsonl";

// ── Path derivation ─────────────────────────────────────────────────────

/**
 * Derive the journal path under XDG_STATE_HOME.
 *
 * Layout:
 *   $XDG_STATE_HOME/kuma/<project>-<hash>/<worktree>/journal.jsonl
 *
 * - project  = basename of projectRoot (e.g. "extensions")
 * - hash     = short hash of the absolute projectRoot for disambiguation
 * - worktree = basename of worktreePath (e.g. "pacifista", "main")
 *
 * If no projectRoot is provided, auto-detects the bare repo root.
 * Falls back to worktreePath as the root if detection fails.
 *
 * Deterministic from the two paths — the same inputs always produce
 * the same journal location.
 */
export async function getJournalPath(
  worktreePath: string,
): Promise<string> {
  const home = process.env.XDG_STATE_HOME ?? (process.env.HOME ? `${process.env.HOME}/.local/state` : null);
  if (!home) {
    throw new Error("Cannot determine state directory: neither XDG_STATE_HOME nor HOME is set");
  }
  const stateHome = home;

  const detectedRoot = await detectBareRepoRoot(worktreePath);
  const root = resolve(detectedRoot ?? worktreePath);
  const projectName = basename(root);
  const shortHash = hashString(root).slice(0, 6);
  const worktreeName = basename(resolve(worktreePath));

  return `${stateHome}/kuma/${projectName}-${shortHash}/${worktreeName}/${JOURNAL_FILE}`;
}

/**
 * Simple deterministic hash for path disambiguation.
 * Returns a hex string.
 */
function hashString(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

// ── Journal operations ──────────────────────────────────────────────────

/**
 * Append a single event to the journal file.
 *
 * Each line is a self-contained JSON object. Append-only writes
 * are crash-safe — at worst we lose the last partial line, which
 * `JSON.parse` will reject on replay.
 *
 * When `state` is provided, the event is applied incrementally to
 * avoid a full journal replay. This turns the O(N²) replay-per-event
 * pattern into O(1) per append during a run. Full `replayState`
 * is reserved for cold-resume only.
 */
export async function appendEvent(
  journalPath: string,
  event: JournalEvent,
  state?: RunState,
): Promise<void> {
  await mkdir(dirname(journalPath), { recursive: true });
  await appendFile(journalPath, JSON.stringify(event) + "\n");

  // Incrementally apply the event to the in-memory state
  if (state) {
    applyEvent(state, event);
  }
}

/**
 * Replay the journal to reconstruct the current (most recent) run state.
 *
 * When a journal contains multiple runs (multiple `run:started` events),
 * only the last run is replayed. Earlier runs are preserved in the file
 * as an audit trail but don't affect the returned state.
 *
 * Invalid lines (e.g. from a crash) are silently skipped.
 */
export async function replayState(journalPath: string): Promise<RunState> {
  const file = Bun.file(journalPath);
  if (!(await file.exists())) {
    throw new Error(`Journal not found: ${journalPath}`);
  }

  const text = await file.text();
  const lines = text.split("\n").filter(Boolean);

  // Find the last run:started to replay only the most recent run
  let startIndex = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!) as JournalEvent;
      if (event.type === "run:started") {
        startIndex = i;
        break;
      }
    } catch {
      continue;
    }
  }

  let state: RunState | null = null;

  for (let i = startIndex; i < lines.length; i++) {
    let event: JournalEvent;
    try {
      event = JSON.parse(lines[i]!) as JournalEvent;
    } catch {
      // Skip corrupted/partial lines
      continue;
    }

    state = applyEvent(state, event);
  }

  if (!state) {
    throw new Error(`Journal is empty or corrupt: ${journalPath}`);
  }

  return state;
}

/**
 * Check whether a journal file exists.
 */
export async function journalExists(journalPath: string): Promise<boolean> {
  return Bun.file(journalPath).exists();
}

// ── Event application ───────────────────────────────────────────────────

function applyEvent(
  state: RunState | null,
  event: JournalEvent,
): RunState | null {
  switch (event.type) {
    case "run:started": {
      return {
        planPath: event.planPath,
        worktreePath: event.worktreePath,
        startedAt: event.ts,
        currentTask: event.tasks[0]?.id ?? 1,
        tasks: event.tasks.map(
          (t): TaskState => ({
            id: t.id,
            title: t.title,
            status: "pending",
            attempts: [],
          }),
        ),
      };
    }

    case "task:started": {
      if (!state) return state;
      const task = state.tasks.find((t) => t.id === event.taskId);
      if (!task) return state;

      task.status = "in_progress";
      state.currentTask = event.taskId;
      task.attempts.push({
        startedAt: event.ts,
        sessionId: event.sessionId,
      });
      return state;
    }

    case "task:session": {
      if (!state) return state;
      const task = state.tasks.find((t) => t.id === event.taskId);
      if (!task) return state;

      const attempt = task.attempts[event.attempt - 1];
      if (attempt) {
        attempt.sessionId = event.sessionId;
      }
      return state;
    }
    case "task:checked": {
      if (!state) return state;
      const task = state.tasks.find((t) => t.id === event.taskId);
      if (!task) return state;

      const attempt = task.attempts[event.attempt - 1];
      if (attempt) {
        attempt.checks = event.checksResult;
        attempt.changedFiles = event.changedFiles;
        attempt.completedAt = event.ts;
      }
      return state;
    }

    case "task:approved": {
      if (!state) return state;
      const task = state.tasks.find((t) => t.id === event.taskId);
      if (!task) return state;

      task.status = "approved";
      const attempt = task.attempts[event.attempt - 1];
      if (attempt) {
        attempt.outcome = "approved";
      }
      return state;
    }

    case "task:revised": {
      if (!state) return state;
      const task = state.tasks.find((t) => t.id === event.taskId);
      if (!task) return state;

      const attempt = task.attempts[event.attempt - 1];
      if (attempt) {
        attempt.outcome = "revise";
        attempt.revision = event.feedback;
      }
      return state;
    }

    case "task:rejected": {
      if (!state) return state;
      const task = state.tasks.find((t) => t.id === event.taskId);
      if (!task) return state;

      task.status = "rejected";
      const attempt = task.attempts[event.attempt - 1];
      if (attempt) {
        attempt.outcome = "rejected";
      }
      return state;
    }

    case "task:skipped": {
      if (!state) return state;
      const task = state.tasks.find((t) => t.id === event.taskId);
      if (!task) return state;

      task.status = "skipped";
      return state;
    }

    case "review:completed": {
      if (!state) return state;
      if (event.reviewSessionId) {
        state.reviewSessionId = event.reviewSessionId;
      }
      if (event.triageSessionId) {
        state.triageSessionId = event.triageSessionId;
      }
      return state;
    }

    case "run:paused":
    case "run:completed":
      return state;

    default: {
      void (event satisfies never);
      return state;
    }
  }
}
