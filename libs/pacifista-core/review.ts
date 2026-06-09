import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import type { EventHandler, PacifistaConfig, ReviewData, TriageVerdictData } from "./types.ts";
import type { GateHandler } from "./runner.ts";
import { piCapture, piCaptureWithSession, piReview } from "./pi.ts";
import { buildFixPrompt, buildTriagePrompt } from "./prompt.ts";
import { runChecks } from "./checks.ts";
import { appendEvent } from "./state.ts";

/**
 * Review and triage run without a sandbox.
 *
 * The review stage writes structured JSON to a temp file on the host.
 * If pi spawns inside a container, the file lands in the container's
 * `/tmp` and the host can't read it. Force `--no-container` so quorum
 * and triage both read from the host filesystem.
 */
const REVIEW_PI_OPTS = { sandbox: false, noSandbox: true } as const;

export type TriageVerdict = {
  id: number;
  verdict: "fix" | "defer" | "pushback";
  sha?: string;
  description: string;
};

/**
 * Check whether the quorum extension (@kingsleyzissou/quorum) is available.
 */
async function isQuorumAvailable(worktreePath: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["pi", "--list-extensions"], {
      cwd: worktreePath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.includes("quorum");
  } catch {
    try {
      const resolved = import.meta.resolve("@kingsleyzissou/quorum");
      return !!resolved;
    } catch {
      return false;
    }
  }
}

/**
 * Run the ensemble review stage.
 */
export async function runReviewStage(
  worktreePath: string,
  config: PacifistaConfig,
  journalPath: string | undefined,
  onEvent?: EventHandler,
  onGate?: GateHandler,
): Promise<{ reviewed: boolean; fixes: number }> {
  if (!config.review.enabled) {
    return { reviewed: false, fixes: 0 };
  }

  const baseBranch = config.review.baseBranch;
  const hasQuorum = await isQuorumAvailable(worktreePath);

  onEvent?.({ type: "review:start" });
  onEvent?.({ type: "review:reviewing" });

  // Write structured JSON output to a temp file via quorum's --output flag
  const outputPath = join(tmpdir(), `kuma-review-${Date.now()}.json`);

  const reviewResult = await piReview(baseBranch, worktreePath, {
    ...REVIEW_PI_OPTS,
    outputPath,
  }, onEvent);

  if (reviewResult.exitCode !== 0) {
    onEvent?.({ type: "error", message: `Review failed: ${reviewResult.stderr}` });
    return { reviewed: false, fixes: 0 };
  }

  // Read structured review data
  let reviewData: ReviewData;
  try {
    const outputFile = Bun.file(outputPath);
    reviewData = await outputFile.json() as ReviewData;
  } catch {
    onEvent?.({ type: "error", message: "Failed to read review output" });
    return { reviewed: false, fixes: 0 };
  } finally {
    await unlink(outputPath).catch(() => {});
  }

  // Triage
  onEvent?.({ type: "review:triage" });

  const triageResult = await piCaptureWithSession(
    buildTriagePrompt(reviewData),
    worktreePath,
    { ...REVIEW_PI_OPTS, noTools: true },
  );

  if (triageResult.exitCode !== 0) {
    onEvent?.({ type: "error", message: `Triage failed: ${triageResult.stderr}` });
    return { reviewed: true, fixes: 0 };
  }

  const verdicts = parseVerdicts(triageResult.stdout);
  const fixes = verdicts.filter((v) => v.verdict === "fix");

  // Save review data and verdicts to journal (if one exists)
  if (journalPath) {
    await appendEvent(journalPath, {
      type: "review:completed",
      reviewData,
      verdicts: verdicts as TriageVerdictData[],
      reviewSessionId: reviewResult.sessionId,
      triageSessionId: triageResult.sessionId,
      ts: new Date().toISOString(),
    });
  }

  if (fixes.length === 0) {
    onEvent?.({ type: "review:done", fixes: 0 });
    return { reviewed: true, fixes: 0 };
  }

  // Apply fixes
  let appliedFixes = 0;

  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i]!;
    if (!fix.sha) continue;

    onEvent?.({ type: "review:fix", current: i + 1, total: fixes.length, description: fix.description });

    const fixResult = await piCapture(
      buildFixPrompt(fix.description, fix.sha),
      worktreePath,
      REVIEW_PI_OPTS,
    );

    if (fixResult.exitCode !== 0) {
      onEvent?.({ type: "error", message: `Fix #${fix.id} failed: ${fixResult.stderr}` });
      continue;
    }

    const checksResult = await runChecks(worktreePath, config.checks, "task");

    if (onGate) {
      const action = await onGate(
        { id: fix.id, title: fix.description, body: "", fields: {} },
        1,
        [],
        checksResult,
        config.gate,
      );
      if (action.action === "approve") {
        appliedFixes++;
      }
    } else {
      appliedFixes++;
    }
  }

  // Autosquash
  if (appliedFixes > 0) {
    const squashCmd = `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash ${baseBranch ?? "HEAD~10"}`;
    const squash = Bun.spawn(["sh", "-c", squashCmd], {
      cwd: worktreePath,
      stdout: "pipe",
      stderr: "pipe",
    });
    await squash.exited;
  }

  void hasQuorum; // used for future messaging
  onEvent?.({ type: "review:done", fixes: appliedFixes });
  return { reviewed: true, fixes: appliedFixes };
}

/**
 * Extract the outer JSON array from triage output.
 *
 * Uses a bracket-depth counter instead of regex to correctly handle
 * nested arrays/objects (e.g. `"tags": []`) that would cause a
 * non-greedy regex `\[...*?\]` to stop at the first `]`.
 */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;

    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return null; // unbalanced brackets
}

function parseVerdicts(output: string): TriageVerdict[] {
  // Strip markdown code fences before matching
  const stripped = output.replace(/```(?:json)?\s*\n?/g, "");

  const jsonStr = extractJsonArray(stripped);
  if (!jsonStr) {
    console.warn("[pacifista] parseVerdicts: no JSON array found in triage output");
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      console.warn("[pacifista] parseVerdicts: parsed value is not an array");
      return [];
    }
    return parsed as TriageVerdict[];
  } catch (err) {
    console.warn(`[pacifista] parseVerdicts: JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
