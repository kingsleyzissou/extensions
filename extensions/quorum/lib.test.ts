import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  detectBaseBranch,
  detectProjectType,
  gitArgs,
  isBareRepo,
  parseWorktreePorcelain,
  runWithConcurrency,
} from "./lib.ts";
import type { ExecFn } from "./types.ts";

// --- Test helpers ---

function mockExec(stdout: string, code = 0, stderr = ""): ExecFn {
  return (async () => ({ stdout, stderr, code, killed: false })) as ExecFn;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- gitArgs ---

describe("gitArgs", () => {
  test("prepends -C and cwd", () => {
    expect(gitArgs("/repo", ["status"])).toEqual(["-C", "/repo", "status"]);
  });

  test("handles multiple args", () => {
    expect(gitArgs("/repo", ["log", "--oneline", "-n", "5"])).toEqual([
      "-C",
      "/repo",
      "log",
      "--oneline",
      "-n",
      "5",
    ]);
  });

  test("handles empty args", () => {
    expect(gitArgs("/repo", [])).toEqual(["-C", "/repo"]);
  });
});

// --- detectProjectType ---

describe("detectProjectType", () => {
  test('returns "go" when go.mod exists', async () => {
    fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/foo");
    expect(await detectProjectType(tmpDir)).toBe("go");
  });

  test('returns "frontend" when package.json has react dependency', async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "^18.0.0", axios: "^1.0.0" } }),
    );
    expect(await detectProjectType(tmpDir)).toBe("frontend");
  });

  test('returns "backend-ts" for package.json without react', async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.0.0" } }),
    );
    expect(await detectProjectType(tmpDir)).toBe("backend-ts");
  });

  test('returns "backend-ts" for package.json with no dependencies', async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "my-lib" }),
    );
    expect(await detectProjectType(tmpDir)).toBe("backend-ts");
  });

  test('returns "backend-ts" for malformed package.json', async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{{{bad json");
    expect(await detectProjectType(tmpDir)).toBe("backend-ts");
  });

  test("returns null when no go.mod or package.json", async () => {
    expect(await detectProjectType(tmpDir)).toBeNull();
  });

  test("prefers go.mod over package.json", async () => {
    fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/foo");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
    );
    expect(await detectProjectType(tmpDir)).toBe("go");
  });
});

// --- detectBaseBranch ---

describe("detectBaseBranch", () => {
  test("returns upstream/main when upstream remote exists", async () => {
    const exec = mockExec("origin\nupstream\n");
    expect(await detectBaseBranch(exec, "/repo")).toBe("upstream/main");
  });

  test("returns kingsley/main when kingsley remote exists", async () => {
    const exec = mockExec("origin\nkingsley\n");
    expect(await detectBaseBranch(exec, "/repo")).toBe("kingsley/main");
  });

  test("prefers upstream over kingsley", async () => {
    const exec = mockExec("origin\nupstream\nkingsley\n");
    expect(await detectBaseBranch(exec, "/repo")).toBe("upstream/main");
  });

  test("returns null when no matching remote", async () => {
    const exec = mockExec("origin\n");
    expect(await detectBaseBranch(exec, "/repo")).toBeNull();
  });

  test("returns null when git command fails", async () => {
    const exec = mockExec("", 128, "fatal: not a git repo");
    expect(await detectBaseBranch(exec, "/repo")).toBeNull();
  });
});

// --- isBareRepo ---

describe("isBareRepo", () => {
  test("returns true for bare repo", async () => {
    const exec = mockExec("true\n");
    expect(await isBareRepo(exec)).toBe(true);
  });

  test("returns false for non-bare repo", async () => {
    const exec = mockExec("false\n");
    expect(await isBareRepo(exec)).toBe(false);
  });

  test("returns false when git command fails", async () => {
    const exec = mockExec("", 128);
    expect(await isBareRepo(exec)).toBe(false);
  });
});

// --- parseWorktreePorcelain ---

describe("parseWorktreePorcelain", () => {
  test("parses multiple worktrees", () => {
    const output = [
      "worktree /repo/main",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/feature",
      "HEAD def456",
      "branch refs/heads/feature/cool-thing",
      "",
    ].join("\n");

    expect(parseWorktreePorcelain(output)).toEqual([
      { path: "/repo/main", branch: "main" },
      { path: "/repo/feature", branch: "feature/cool-thing" },
    ]);
  });

  test("strips refs/heads/ prefix from branch", () => {
    const output = [
      "worktree /repo/work",
      "HEAD abc123",
      "branch refs/heads/my-branch",
      "",
    ].join("\n");

    expect(parseWorktreePorcelain(output)).toEqual([
      { path: "/repo/work", branch: "my-branch" },
    ]);
  });

  test("skips bare repo entry (no branch line)", () => {
    const output = [
      "worktree /repo/bare",
      "HEAD abc123",
      "bare",
      "",
      "worktree /repo/feature",
      "HEAD def456",
      "branch refs/heads/feature",
      "",
    ].join("\n");

    expect(parseWorktreePorcelain(output)).toEqual([
      { path: "/repo/feature", branch: "feature" },
    ]);
  });

  test("handles last entry without trailing newline", () => {
    const output = [
      "worktree /repo/work",
      "HEAD abc123",
      "branch refs/heads/main",
    ].join("\n");

    expect(parseWorktreePorcelain(output)).toEqual([
      { path: "/repo/work", branch: "main" },
    ]);
  });

  test("returns empty array for empty output", () => {
    expect(parseWorktreePorcelain("")).toEqual([]);
  });
});

// --- runWithConcurrency ---

describe("runWithConcurrency", () => {
  test("processes all items", async () => {
    const results: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      results.push(item);
    });
    expect(results.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test("respects concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;

    await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });

    expect(maxActive).toBe(2);
  });

  test("handles empty array", async () => {
    const results: number[] = [];
    await runWithConcurrency([], 4, async (item) => {
      results.push(item);
    });
    expect(results).toEqual([]);
  });

  test("handles concurrency greater than item count", async () => {
    const results: number[] = [];
    await runWithConcurrency([1, 2], 10, async (item) => {
      results.push(item);
    });
    expect(results.sort()).toEqual([1, 2]);
  });

  test("preserves index argument", async () => {
    const indices: number[] = [];
    await runWithConcurrency(["a", "b", "c"], 1, async (_, index) => {
      indices.push(index);
    });
    expect(indices).toEqual([0, 1, 2]);
  });

  test("propagates errors", async () => {
    expect(
      runWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
