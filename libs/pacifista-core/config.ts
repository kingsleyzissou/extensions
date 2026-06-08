import type { DeepPartial, PacifistaConfig } from "./types.ts";

const DEFAULTS: PacifistaConfig = {
  qc: {
    lint: "npm run lint",
    typecheck: "npm run typecheck",
    testCmd: "npm test --",
  },
  pi: {
    sandbox: false,
    noSandbox: false,
  },
  hooks: {},
  prompt: {},
  review: {
    enabled: true,
    reviewsDir: "docs/reviews",
  },
  gate: {
    autoApprove: false,
  },
};

export async function loadConfig(
  worktreePath: string,
  cliOverrides?: DeepPartial<PacifistaConfig>,
): Promise<PacifistaConfig> {
  const jsPath = `${worktreePath}/.pacifista/config.js`;
  const jsonPath = `${worktreePath}/.pacifista/config.json`;

  let fileConfig: DeepPartial<PacifistaConfig> = {};

  const jsFile = Bun.file(jsPath);
  if (await jsFile.exists()) {
    const mod = await import(jsPath);
    fileConfig = mod.default ?? mod;
  } else {
    const jsonFile = Bun.file(jsonPath);
    if (await jsonFile.exists()) {
      fileConfig = await jsonFile.json();
    }
  }

  return deepMerge(DEFAULTS, fileConfig, cliOverrides ?? {});
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(
  ...sources: Array<DeepPartial<PacifistaConfig>>
): PacifistaConfig {
  const result = { ...sources[0] } as Record<string, unknown>;

  for (let i = 1; i < sources.length; i++) {
    const source = sources[i] as Record<string, unknown> | undefined;
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const existing = result[key];
      if (isPlainObject(existing) && isPlainObject(value)) {
        result[key] = { ...existing, ...value };
      } else {
        result[key] = value;
      }
    }
  }

  return result as PacifistaConfig;
}
