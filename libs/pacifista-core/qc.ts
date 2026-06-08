import type { QcConfig, QcResult } from "./types.ts";

/**
 * Run all quality checks: lint, typecheck, and scoped tests.
 *
 * Lint and typecheck run sequentially (not in parallel) because
 * type-aware ESLint rules spin up their own TypeScript program.
 * Running two tsc instances concurrently over the same project
 * causes .tsbuildinfo and cache contention, leading to spurious
 * failures.
 */
export async function runQualityChecks(
  workdir: string,
  config: QcConfig,
): Promise<QcResult> {
  const typecheck = await runShell(workdir, config.typecheck);
  const lint = await runShell(workdir, config.lint);

  const { testFiles, missingTests } = await detectTests(workdir);

  let tests: QcResult["tests"];
  if (testFiles.length > 0) {
    const testResult = await runScopedTests(workdir, testFiles, config);
    tests = { status: testResult.status, files: testFiles.length };
  } else {
    tests = { status: "skipped", files: 0 };
  }

  return {
    lint: lint.ok ? "pass" : "fail",
    typecheck: typecheck.ok ? "pass" : "fail",
    tests,
    missingTests: missingTests.length > 0 ? missingTests : undefined,
  };
}

/**
 * Detect changed source files and find colocated tests.
 */
export async function detectTests(workdir: string): Promise<{
  testFiles: string[];
  missingTests: string[];
}> {
  const diff = await runShell(
    workdir,
    'git diff --name-only HEAD~1 -- "*.ts" "*.tsx"',
  );

  const changedFiles = diff.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  const sourceFiles = changedFiles.filter(
    (f) => !f.includes(".test.") && !f.includes(".spec."),
  );

  const testFiles: string[] = [];
  const missingTests: string[] = [];

  for (const src of sourceFiles) {
    const ext = src.slice(src.lastIndexOf("."));
    const base = src.slice(0, src.lastIndexOf("."));
    const testPath = `${base}.test${ext}`;

    const testFile = Bun.file(`${workdir}/${testPath}`);
    if (await testFile.exists()) {
      testFiles.push(testPath);
    } else {
      missingTests.push(src);
    }
  }

  // Also include any changed test files directly
  for (const f of changedFiles) {
    if (
      (f.includes(".test.") || f.includes(".spec.")) &&
      !testFiles.includes(f)
    ) {
      testFiles.push(f);
    }
  }

  return { testFiles, missingTests };
}

/**
 * Run specific test files.
 */
export async function runScopedTests(
  workdir: string,
  testFiles: string[],
  config: QcConfig,
): Promise<{ status: "pass" | "fail"; output: string }> {
  const cmd = `${config.testCmd} ${testFiles.join(" ")}`;
  const result = await runShell(workdir, cmd);
  return {
    status: result.ok ? "pass" : "fail",
    output: result.stdout + result.stderr,
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
