import { resolve } from 'node:path';
import type { DeepPartial, PacifistaConfig } from './types.ts';
import { detectBareRepoRoot } from './git.ts';

export const DEFAULTS: PacifistaConfig = {
  checks: [
    { name: 'typecheck', command: 'npm run typecheck' },
    { name: 'lint', command: 'npm run lint' },
    { name: 'tests', command: 'npm test' },
  ],
  pi: {
    sandbox: false,
    noSandbox: false,
  },
  hooks: {},
  prompt: {},
  review: {
    enabled: true,
    reviewsDir: 'docs/reviews',
  },
  gate: {
    autoApprove: false,
  },
};

export async function loadConfig(
  worktreePath: string,
  cliOverrides?: DeepPartial<PacifistaConfig>,
  projectRoot?: string,
): Promise<PacifistaConfig> {
  const root = projectRoot ?? detectBareRepoRoot(worktreePath) ?? undefined;
  const fileConfig = await findAndLoadConfig(worktreePath, root);
  return deepMerge(DEFAULTS, fileConfig, cliOverrides ?? {});
}

/**
 * Search for config in the worktree first, then fall back to the
 * project root (bare repo root).
 *
 * At each location, checks .kuma/ first, then .pacifista/ as a
 * legacy fallback. Accepts both .js and .json formats.
 */
async function findAndLoadConfig(
  worktreePath: string,
  projectRoot?: string,
): Promise<DeepPartial<PacifistaConfig>> {
  const searchPaths = [worktreePath];
  if (projectRoot && projectRoot !== worktreePath) {
    searchPaths.push(projectRoot);
  }

  const configDirs = ['.kuma', '.pacifista'];

  for (const base of searchPaths) {
    for (const dir of configDirs) {
      const jsPath = resolve(base, dir, 'config.js');
      // Ensure the resolved path stays within the expected base directory
      // to prevent path-traversal attacks (e.g. symlinks or ../ segments).
      if (!jsPath.startsWith(resolve(base) + '/')) continue;

      const jsFile = Bun.file(jsPath);
      if (await jsFile.exists()) {
        const mod = await import(jsPath);
        return mod.default ?? mod;
      }

      const jsonPath = resolve(base, dir, 'config.json');
      if (!jsonPath.startsWith(resolve(base) + '/')) continue;

      const jsonFile = Bun.file(jsonPath);
      if (await jsonFile.exists()) {
        return jsonFile.json();
      }
    }
  }

  return {};
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge(...sources: Array<DeepPartial<PacifistaConfig>>): PacifistaConfig {
  const result = { ...sources[0] } as Record<string, unknown>;

  for (let i = 1; i < sources.length; i++) {
    const source = sources[i] as Record<string, unknown> | undefined;
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const existing = result[key];
      if (isPlainObject(existing) && isPlainObject(value)) {
        const filtered = Object.fromEntries(
          Object.entries(value).filter(([, v]) => v !== undefined),
        );
        result[key] = { ...existing, ...filtered };
      } else {
        result[key] = value;
      }
    }
  }

  return result as PacifistaConfig;
}
