import type { Plan, PlanTask, PromptConfig } from "./types.ts";

export function buildTaskPrompt(
  plan: Plan,
  task: PlanTask,
  options: {
    revision?: string;
    commitPerTask?: boolean;
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

  // Commit instructions
  if (options.commitPerTask) {
    sections.push(
      [
        "## Commit",
        "",
        "When done, commit all changes following these conventions:",
        "",
        "- **Format**: `Component: short description`",
        "- Prefix with the component or area the change primarily touches, followed by a colon and space",
        "- Use sentence case after the prefix (lowercase unless proper noun)",
        "- Keep the subject under 72 characters",
        "- Use imperative mood (\"add\", \"fix\", \"remove\" — not \"added\", \"fixes\", \"removed\")",
        "- Do NOT use semantic prefixes (feat, fix, chore, etc.)",
        "- Do NOT mention any plan, task number, or orchestration system",
        "",
        "If a body is needed, explain **why** (not what), wrap at 72 chars,",
        "and leave a blank line between subject and body. Skip the body for",
        "self-explanatory changes.",
        "",
        "Add a `Co-authored-by` trailer for AI attribution:",
        "",
        "```",
        "Component: short description",
        "",
        "Optional body.",
        "",
        "Co-authored-by: <Model Full Name> <email>",
        "```",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

/**
 * Build a triage prompt for evaluating review findings.
 */
export function buildTriagePrompt(reviewPath: string): string {
  return [
    `Read the review document at ${reviewPath}.`,
    "",
    "For each finding, evaluate it against the actual code and render a verdict:",
    '- **fix**: The finding is valid and should be fixed. Include the target commit SHA.',
    '- **defer**: The finding is valid but can be addressed later.',
    '- **pushback**: The finding is incorrect or not applicable.',
    "",
    "Return your response as a JSON array:",
    "```json",
    '[{ "id": 1, "verdict": "fix", "sha": "abc123", "description": "..." }, ...]',
    "```",
  ].join("\n");
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
