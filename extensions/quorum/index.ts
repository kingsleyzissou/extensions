/**
 * Quorum — Ensemble PR Review Extension
 *
 * Registers a /review command that:
 * 1. Detects project type (React frontend, TypeScript lib, Go)
 * 2. Detects base branch (upstream/main or kingsley/main)
 * 3. Spawns specialized reviewers in parallel
 * 4. Sends combined feedback to the main agent for synthesis
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MAX_CONCURRENCY,
  REVIEWERS,
  detectBaseBranch,
  detectProjectType,
  gitArgs,
  isBareRepo,
  listWorktrees,
  runReviewer,
  runWithConcurrency,
} from "./lib.ts";
import type { ReviewerResult } from "./types.ts";
import { PROJECT_LABELS } from "./types.ts";

export default function (pi: ExtensionAPI) {
  const agentsDir = path.join(import.meta.dirname, "agents");

  pi.registerCommand("review", {
    description: "Run ensemble PR review with specialized reviewers",
    handler: async (args, ctx) => {
      // 1. Detect project type (with bare repo / worktree support)
      let reviewCwd = ctx.cwd;
      let projectType = await detectProjectType(reviewCwd);

      if (!projectType && (await isBareRepo(pi.exec.bind(pi)))) {
        const worktrees = await listWorktrees(pi.exec.bind(pi));
        if (worktrees.length === 0) {
          ctx.ui.notify("Bare repo detected but no worktrees found.", "error");
          return;
        }

        const choices = worktrees.map(
          (w) => `${w.branch} (${path.basename(w.path)})`,
        );
        const choice = await ctx.ui.select(
          "Bare repo detected. Select a worktree to review:",
          choices,
        );
        if (!choice) return;

        const selected = worktrees[choices.indexOf(choice)];
        if (!selected) return;
        reviewCwd = selected.path;
        projectType = await detectProjectType(reviewCwd);
      }

      if (!projectType) {
        ctx.ui.notify(
          "Could not detect project type. Expected go.mod or package.json in the project root.",
          "error",
        );
        return;
      }

      // 2. Detect or use provided base branch
      const baseBranch =
        args?.trim() || (await detectBaseBranch(pi.exec.bind(pi), reviewCwd)); // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- args may be undefined at runtime
      ctx.ui.setStatus("quorum", "Quorum: preparing...");
      if (!baseBranch) {
        ctx.ui.notify(
          "Could not detect base branch. No upstream or kingsley remote found. Pass a branch explicitly: /review upstream/main",
          "error",
        );
        return;
      }

      // 3. Verify there are changes to review
      const diffCheck = await pi.exec(
        "git",
        gitArgs(reviewCwd, ["log", `${baseBranch}..HEAD`, "--oneline"]),
        { timeout: 10000 },
      );
      if (diffCheck.code !== 0) {
        ctx.ui.notify(
          `Failed to get commits: ${diffCheck.stderr.trim()}`,
          "error",
        );
        return;
      }
      const commitCount = diffCheck.stdout
        .trim()
        .split("\n")
        .filter(Boolean).length;
      if (commitCount === 0) {
        ctx.ui.notify(
          `No commits found between ${baseBranch} and HEAD.`,
          "warning",
        );
        return;
      }

      // 4. Gather PR materials to a temp directory
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-"));

      try {
        // Commit log
        const commitLog = await pi.exec(
          "git",
          gitArgs(reviewCwd, [
            "log",
            `${baseBranch}..HEAD`,
            "--reverse",
            "--pretty=format:%H %s",
          ]),
          { timeout: 10000 },
        );
        fs.writeFileSync(path.join(tmpDir, "commits.txt"), commitLog.stdout);

        // Full diff
        const diff = await pi.exec(
          "git",
          gitArgs(reviewCwd, ["diff", baseBranch, "--"]),
          {
            timeout: 30000,
          },
        );
        fs.writeFileSync(path.join(tmpDir, "diff.patch"), diff.stdout);

        // Changed files list
        const files = await pi.exec(
          "git",
          gitArgs(reviewCwd, ["diff", baseBranch, "--name-status"]),
          { timeout: 10000 },
        );
        fs.writeFileSync(path.join(tmpDir, "files.txt"), files.stdout);

        // 5. Show gathered materials and confirm
        const commitLines = commitLog.stdout.trim().split("\n").filter(Boolean);
        const fileLines = files.stdout.trim().split("\n").filter(Boolean);

        const summary = [
          `Commits (${commitLines.length}):`,
          ...commitLines.map((l: string) => `  ${l}`),
          "",
          `Files changed (${fileLines.length}):`,
          ...fileLines.map((l: string) => `  ${l}`),
        ].join("\n");

        ctx.ui.notify(summary, "info");

        const proceed = await ctx.ui.confirm(
          "Proceed with review?",
          `${commitLines.length} commit(s), ${fileLines.length} file(s) changed`,
        );
        if (!proceed) {
          ctx.ui.setStatus("quorum", undefined);
          return;
        }

        // 6. Select reviewers for this project type
        const reviewers = REVIEWERS.filter((r) =>
          r.projectTypes.includes(projectType),
        );

        ctx.ui.notify(
          `Quorum assembling: ${reviewers.length} reviewers for ${PROJECT_LABELS[projectType]}, ${commitCount} commit(s) vs ${baseBranch}`,
          "info",
        );
        ctx.ui.setStatus(
          "quorum",
          `Quorum: 0/${reviewers.length} reviewers complete`,
        );

        // 7. Build the task prompt for reviewers
        const task = [
          `Review the PR changes between ${baseBranch} and HEAD.`,
          "",
          "PR materials have been prepared for you:",
          `  ${tmpDir}/files.txt    — list of changed files with status`,
          `  ${tmpDir}/commits.txt  — commit hashes and messages`,
          `  ${tmpDir}/diff.patch   — full unified diff`,
          "",
          "Start by reading files.txt for an overview, then read diff.patch for the changes.",
          "Use read, grep, and find on the codebase to examine changed files in context.",
          "Provide specific, actionable feedback with file paths and line numbers.",
          "",
          "IMPORTANT: Scope your review strictly to the PR changes. Do NOT flag",
          "pre-existing issues in the codebase unless they are absolutely critical",
          "(e.g., a security vulnerability or data loss risk exposed by the changes).",
          "If you do flag a pre-existing issue, clearly label it as such.",
          "",
          "Format your output as:",
          "",
          "## Critical (must fix)",
          "- Issues that would block merge",
          "",
          "## Warnings (should consider)",
          "- Improvements worth discussing",
          "",
          "## Positive",
          "- Good patterns to acknowledge",
        ].join("\n");

        // 8. Spawn reviewers in parallel
        const results: ReviewerResult[] = new Array(reviewers.length);
        let completed = 0;

        await runWithConcurrency(
          reviewers,
          MAX_CONCURRENCY,
          async (reviewer, index) => {
            const agentPath = path.join(agentsDir, reviewer.agentFile);
            const result = await runReviewer(
              reviewCwd,
              agentPath,
              task,
              ctx.signal,
            );

            results[index] = {
              reviewer: reviewer.name,
              label: reviewer.label,
              output: result.output || "(no output)",
              exitCode: result.exitCode,
              error: result.error,
            };

            completed++;
            ctx.ui.setStatus(
              "quorum",
              `Quorum: ${completed}/${reviewers.length} reviewers complete`,
            );
            ctx.ui.notify(
              `[${completed}/${reviewers.length}] ${reviewer.label} reviewer ${result.exitCode === 0 ? "done" : "failed"}`,
              result.exitCode === 0 ? "info" : "warning",
            );
          },
        );

        // 9. Compile results and send to agent for synthesis
        const successCount = results.filter((r) => r.exitCode === 0).length;
        const sections = results.map((r) => {
          const status = r.exitCode === 0 ? "" : " (FAILED)";
          const content =
            r.exitCode === 0 ? r.output : `Error: ${r.error || r.output}`;
          return `### ${r.label} Review${status}\n\n${content}`;
        });

        const synthesisPrompt = [
          `The following PR review was conducted by ${reviewers.length} specialized reviewers (${successCount} succeeded).`,
          `Project type: ${PROJECT_LABELS[projectType]}. Base branch: ${baseBranch}. Commits: ${commitCount}.`,
          "",
          "Synthesize their feedback into a unified PR review summary with these sections:",
          "",
          "**Critical (must fix):** Issues that would block merge",
          "**Suggestions (should consider):** Improvements worth discussing",
          "**Positive observations:** Good patterns to acknowledge",
          "",
          "Deduplicate overlapping feedback. Format as a PR review comment ready to post.",
          "",
          "---",
          "",
          ...sections,
        ].join("\n");

        ctx.ui.setStatus(
          "quorum",
          `Quorum: ${successCount}/${reviewers.length} succeeded -- synthesizing...`,
        );
        pi.sendUserMessage(synthesisPrompt, { deliverAs: "followUp" });
      } finally {
        // Clean up temp directory and status
        fs.rmSync(tmpDir, { recursive: true, force: true });
        ctx.ui.setStatus("quorum", undefined);
      }
    },
  });
}
