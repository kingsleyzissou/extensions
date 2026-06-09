import type { Plan, PlanTask, PromptConfig } from "./types.ts";

export function buildTaskPrompt(
  plan: Plan,
  task: PlanTask,
  options: {
    revision?: string;
    promptConfig?: PromptConfig;
  } = {},
): string {
  const sections: string[] = [];

  // Config preamble
  if (options.promptConfig?.preamble) {
    sections.push(options.promptConfig.preamble);
  }

  // Config rules
  if (options.promptConfig?.rules?.length) {
    sections.push(
      "Rules:\n" +
        options.promptConfig.rules.map((r) => `- ${r}`).join("\n"),
    );
  }

  // Plan context
  if (plan.context) {
    sections.push(plan.context);
  }

  // Task description
  sections.push(`# ${task.title}\n\n${task.body}`);

  // Acceptance criteria
  if (task.fields["acceptance"]) {
    sections.push(`## Acceptance Criteria\n\n${task.fields["acceptance"]}`);
  }

  // File hints
  if (task.fields["files"]) {
    sections.push(`## Files\n\n${task.fields["files"]}`);
  }

  // TDD instructions
  sections.push(
    [
      "## Approach",
      "",
      "1. Write tests first (colocated `.test.ts` files next to source)",
      "2. Implement until tests pass",
      "3. Run the typechecker to verify",
      "4. Ensure linting passes",
    ].join("\n"),
  );

  // Revision feedback
  if (options.revision) {
    sections.push(
      `## Revision Required\n\nThe previous attempt needs changes:\n\n${options.revision}`,
    );
  }

  // Explicit instruction: do NOT commit
  sections.push(
    [
      "## Important",
      "",
      "Do NOT run `git commit`. The orchestrator will handle committing",
      "your changes after they pass quality checks.",
    ].join("\n"),
  );

  return sections.join("\n\n");
}

/**
 * Build a triage prompt for evaluating review findings.
 *
 * Accepts either structured reviewer outputs (from quorum --output)
 * or a file path to a review document (legacy fallback).
 */
export function buildTriagePrompt(
  reviewData: { reviewers: { label: string; output: string; exitCode: number }[] } | string,
): string {
  const header = [
    "The following review findings were produced by an ensemble of specialized reviewers.",
    "",
    "For each finding, evaluate it against the actual code and render a verdict:",
    '- **fix**: The finding is valid and should be fixed. Include the target commit SHA.',
    '- **defer**: The finding is valid but can be addressed later.',
    '- **pushback**: The finding is incorrect or not applicable.',
    "",
    "IMPORTANT: Be concise. Keep descriptions to one sentence.",
    "Do NOT read source files or verify findings against the code —",
    "triage based solely on the reviewer output provided below.",
    "",
    "Return ONLY a JSON array, no other text:",
    "```json",
    '[{ "id": 1, "verdict": "fix", "sha": "abc123", "description": "one-sentence summary" }, ...]',
    "```",
  ];

  if (typeof reviewData === "string") {
    // Legacy: file path
    return [`Read the review document at ${reviewData}.`, "", ...header].join("\n");
  }

  // Structured: inline reviewer outputs
  const sections = reviewData.reviewers
    .filter((r) => r.exitCode === 0)
    .map((r) => `### ${r.label} Review\n\n${r.output}`);

  return [...header, "", "---", "", ...sections].join("\n");
}

/**
 * Build a fix prompt for applying a single review fix.
 */
export function buildFixPrompt(
  description: string,
  sha: string,
): string {
  return [
    `Fix the following issue:\n\n${description}`,
    "",
    "After fixing, commit with:",
    `  git commit --fixup=${sha}`,
    "",
    "Do NOT rebase — the orchestrator will handle autosquash.",
  ].join("\n");
}
