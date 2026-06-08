import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventHandler, PacifistaConfig, PiResult } from "./types.ts";
import type { GateHandler } from "./runner.ts";
import { piCapture, piReview } from "./pi.ts";
import { buildFixPrompt, buildTriagePrompt } from "./prompt.ts";
import { runQualityChecks } from "./qc.ts";

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
  planName: string,
  onEvent?: EventHandler,
  onGate?: GateHandler,
): Promise<{ reviewed: boolean; fixes: number }> {
  if (!config.review.enabled) {
    return { reviewed: false, fixes: 0 };
  }

  const baseBranch = config.review.baseBranch;
  const piOpts = { sandbox: config.pi.sandbox, noSandbox: config.pi.noSandbox };
  const hasQuorum = await isQuorumAvailable(worktreePath);

  onEvent?.({ type: "review:start" });

  const reviewResult: PiResult = await piReview(baseBranch, worktreePath, piOpts);

  if (reviewResult.exitCode !== 0) {
    onEvent?.({ type: "error", message: `Review failed: ${reviewResult.stderr}` });
    return { reviewed: false, fixes: 0 };
  }

  // Save review output
  const reviewsDir = config.review.reviewsDir ?? "docs/reviews";
  const date = new Date().toISOString().slice(0, 10);
  const slug = planName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  const reviewPath = `${reviewsDir}/${date}-${slug}-review.md`;

  await mkdir(dirname(`${worktreePath}/${reviewPath}`), { recursive: true });
  await Bun.write(`${worktreePath}/${reviewPath}`, reviewResult.stdout);

  // Triage
  const triageResult = await piCapture(
    buildTriagePrompt(reviewPath),
    worktreePath,
    piOpts,
  );

  if (triageResult.exitCode !== 0) {
    onEvent?.({ type: "error", message: `Triage failed: ${triageResult.stderr}` });
    return { reviewed: true, fixes: 0 };
  }

  const verdicts = parseVerdicts(triageResult.stdout);
  const fixes = verdicts.filter((v) => v.verdict === "fix");

  if (fixes.length === 0) {
    onEvent?.({ type: "review:done", fixes: 0 });
    return { reviewed: true, fixes: 0 };
  }

  // Apply fixes
  let appliedFixes = 0;

  for (const fix of fixes) {
    if (!fix.sha) continue;

    const fixResult = await piCapture(
      buildFixPrompt(fix.description, fix.sha),
      worktreePath,
      piOpts,
    );

    if (fixResult.exitCode !== 0) {
      onEvent?.({ type: "error", message: `Fix #${fix.id} failed: ${fixResult.stderr}` });
      continue;
    }

    const qc = await runQualityChecks(worktreePath, config.qc);

    if (onGate) {
      const action = await onGate(
        { id: fix.id, title: fix.description, body: "", fields: {} },
        1,
        [],
        qc,
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

function parseVerdicts(output: string): TriageVerdict[] {
  const jsonMatch = output.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    return JSON.parse(jsonMatch[0]) as TriageVerdict[];
  } catch {
    return [];
  }
}
