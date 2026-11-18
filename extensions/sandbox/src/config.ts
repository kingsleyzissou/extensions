import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { type Runtime, spawnWithTimeout } from './runtime';

// Per-project sandbox config (.pi/agent/sandbox.json)
// ---------------------------------------------------------------------------

export interface GitIdentity {
  user: {
    name: string;
    email: string;
  };
}

export interface SandboxProjectConfig {
  image: string;
  tag: string;
  pinned: boolean;
  lastDigest: string | null;
  lastCheckedAt: number | null;
  git: GitIdentity | null;
}

export const DEFAULT_SANDBOX_PROJECT_CONFIG: SandboxProjectConfig = {
  image: 'pi-sandbox',
  tag: 'latest',
  pinned: false,
  lastDigest: null,
  lastCheckedAt: null,
  git: null,
};

/**
 * Read git user.name and user.email from the host's git config.
 * Returns null if either value is not configured.
 */
export async function detectHostGitIdentity(): Promise<GitIdentity | null> {
  const name = await spawnWithTimeout('git', ['config', 'user.name'], 3000);
  const email = await spawnWithTimeout('git', ['config', 'user.email'], 3000);
  const userName = name.stdout.trim();
  const userEmail = email.stdout.trim();
  if (!userName || !userEmail) return null;
  return { user: { name: userName, email: userEmail } };
}

export function getSandboxConfigPath(hostCwd: string): string {
  return resolvePath(hostCwd, '.pi', 'agent', 'sandbox.json');
}

export function loadSandboxProjectConfig(hostCwd: string): SandboxProjectConfig {
  const configPath = getSandboxConfigPath(hostCwd);
  if (!existsSync(configPath)) {
    return { ...DEFAULT_SANDBOX_PROJECT_CONFIG };
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    let git: GitIdentity | null = null;
    if (parsed.git?.user?.name && parsed.git?.user?.email) {
      git = { user: { name: parsed.git.user.name, email: parsed.git.user.email } };
    } else if (parsed.git !== undefined) {
      console.warn(
        `sandbox: ignoring malformed "git" field in ${configPath} — expected { user: { name, email } }`,
      );
    }
    return {
      image: parsed.image ?? DEFAULT_SANDBOX_PROJECT_CONFIG.image,
      tag: parsed.tag ?? DEFAULT_SANDBOX_PROJECT_CONFIG.tag,
      pinned: parsed.pinned ?? DEFAULT_SANDBOX_PROJECT_CONFIG.pinned,
      lastDigest: parsed.lastDigest ?? null,
      lastCheckedAt: parsed.lastCheckedAt ?? null,
      git,
    };
  } catch {
    return { ...DEFAULT_SANDBOX_PROJECT_CONFIG };
  }
}

export function saveSandboxProjectConfig(hostCwd: string, config: SandboxProjectConfig): void {
  const configPath = getSandboxConfigPath(hostCwd);
  const dir = resolvePath(configPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = configPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  renameSync(tmpPath, configPath);
}

export function imageRefForTag(image: string, tag: string): string {
  return `${image}:${tag}`;
}

export async function inspectLocalImageDigest(
  runtime: Runtime,
  imageRef: string,
): Promise<string | null> {
  const result = await spawnWithTimeout(
    runtime.bin,
    ['image', 'inspect', imageRef, '--format', '{{json .RepoDigests}}'],
    10000,
  );
  if (result.code !== 0 || result.timedOut) return null;
  try {
    const digests = JSON.parse(result.stdout.trim()) as string[];
    const digest = digests.find(d => d.includes('@sha256:')) ?? null;
    return digest?.split('@', 2)[1] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registry version checker
// ---------------------------------------------------------------------------

export interface TagInfo {
  name: string;
  digest: string | null;
  lastUpdated: string | null;
}

/**
 * Fetch tag info from Docker Hub v2 API for a public repository.
 * Returns null on network error or if the image repo isn't on Docker Hub.
 * Podman pulls from docker.io by default for short-name images.
 */
export async function fetchTagDigest(image: string, tag: string): Promise<TagInfo | null> {
  try {
    const url = `https://hub.docker.com/v2/repositories/${image}/tags/${tag}`;
    const r = await spawnWithTimeout('curl', ['-s', '-f', '-L', url], 10000);
    if (r.code !== 0 || r.timedOut) return null;
    const data = JSON.parse(r.stdout);
    const digest = data?.images?.[0]?.digest ?? null;
    return {
      name: tag,
      digest,
      lastUpdated: data?.last_updated ?? null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
