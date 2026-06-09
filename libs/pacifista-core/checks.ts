import type { Check, CheckResult, ChecksResult } from "./types.ts";

/**
 * Allowlist pattern for check commands.
 *
 * Only permits commands that start with common task-runner prefixes.
 * Rejects raw shell operators, path traversals, and arbitrary binaries
 * to limit the blast radius of a malicious config file.
 */
const ALLOWED_CMD_PREFIXES = [
  "npm ", "npm ", "npx ", "pnpm ", "yarn ", "bun ", "bunx ",
  "make ", "node ", "tsc", "eslint", "prettier", "vitest", "jest",
];

const DANGEROUS_PATTERNS = /[;&|`$(){}]|\.\.\//;

function validateCommand(command: string): void {
  const trimmed = command.trim();
  const isAllowed = ALLOWED_CMD_PREFIXES.some((p) => trimmed.startsWith(p));
  if (!isAllowed) {
    throw new Error(
      `Check command rejected — not in allowlist: ${JSON.stringify(trimmed)}. ` +
      `Allowed prefixes: ${ALLOWED_CMD_PREFIXES.map((p) => p.trim()).join(", ")}`,
    );
  }
  if (DANGEROUS_PATTERNS.test(trimmed)) {
    throw new Error(
      `Check command rejected — contains dangerous shell characters: ${JSON.stringify(trimmed)}`,
    );
  }
}

/**
 * Run quality checks for a given scope.
 *
 * Filters the check list by scope, then runs each sequentially.
 * Sequential execution avoids contention between tools that share
 * caches or project state (e.g. tsc and type-aware ESLint).
 */
export async function runChecks(
  workdir: string,
  checks: Check[],
  scope: "task" | "final",
): Promise<ChecksResult> {
  const applicable = checks.filter(
    (c) => !c.scope || c.scope === "both" || c.scope === scope,
  );

  const results: CheckResult[] = [];

  for (const check of applicable) {
    validateCommand(check.command);
    const result = await runShell(workdir, check.command);
    results.push({
      name: check.name,
      status: result.ok ? "pass" : "fail",
      ...(result.ok ? {} : { output: (result.stdout + result.stderr).trim() }),
    });
  }

  return {
    checks: results,
    passed: results.every((r) => r.status === "pass"),
  };
}

// ── Shell helper ────────────────────────────────────────────────────────

type ShellResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runShell(workdir: string, command: string): Promise<ShellResult> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  return { ok: exitCode === 0, exitCode, stdout, stderr };
}
