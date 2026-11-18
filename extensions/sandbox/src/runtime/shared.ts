import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import type { RunArgs } from '../types/index';

export type SizeTier = 'xs' | 'sm' | 'md' | 'lg' | 'xlg' | 'xxlg';

export interface TierSpec {
  memory: string;
  swap: string;
  cpus: string;
  disk: string;
}

export const TIER_SPECS: Record<SizeTier, TierSpec> = {
  xs: { memory: '512m', swap: '512m', cpus: '0.5', disk: '2g' },
  sm: { memory: '2g', swap: '1g', cpus: '1', disk: '5g' },
  md: { memory: '4g', swap: '2g', cpus: '2', disk: '10g' },
  lg: { memory: '8g', swap: '4g', cpus: '4', disk: '20g' },
  xlg: { memory: '16g', swap: '4g', cpus: '8', disk: '40g' },
  xxlg: { memory: '32g', swap: '4g', cpus: '16', disk: '80g' },
};

export function parseBytesToBytes(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(b|k|m|g|t)?$/i);
  if (!match?.[1]) return 0;
  const unit = (match[2] ?? 'b').toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    k: 1024,
    m: 1024 ** 2,
    g: 1024 ** 3,
    t: 1024 ** 4,
  };
  return Math.round(parseFloat(match[1]) * (multipliers[unit] ?? 1));
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0) return `${bytes / 1024 ** 3}g`;
  if (bytes >= 1024 ** 2 && bytes % 1024 ** 2 === 0) return `${bytes / 1024 ** 2}m`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}k`;
  return `${bytes}b`;
}

export function parseSizeTier(tier: string): SizeTier | null {
  if (tier in TIER_SPECS) return tier as SizeTier;
  return null;
}

export interface SandboxConfig {
  size?: SizeTier;
  persist?: boolean;
  cacheVolume?: string;
}

export function loadSandboxConfig(hostCwd: string): SandboxConfig | null {
  const configPath = resolvePath(hostCwd, '.pi', 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);
    if (parsed?.sandbox && typeof parsed.sandbox === 'object') {
      return parsed.sandbox as SandboxConfig;
    }
  } catch {
    // Invalid JSON or missing sandbox key
  }
  return null;
}

export function randomSuffix(): string {
  return randomBytes(4).toString('hex');
}

/** Derive a deterministic container name from the shared workspace root. */
export function deriveContainerName(workspaceRoot: string): string {
  const basename = workspaceRoot.split('/').filter(Boolean).pop() || 'project';
  const hash = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 6);
  return `pi-sbx-${basename}-${hash}`;
}

export interface RuntimeMount {
  type: 'bind' | 'volume';
  source: string;
  target: string;
  mode?: 'ro' | 'rw';
}

export interface RuntimeArgFormatters {
  mount(mount: RuntimeMount): string[];
  environment(value: string): string[];
  workdir(path: string): string[];
}

export function buildCommonRunArgs(
  run: RunArgs,
  memoryFilePath: string | undefined,
  format: RuntimeArgFormatters,
): string[] {
  const args = [
    'run',
    '-d',
    '--name',
    run.name,
    '--user',
    '1000:1000',
    '--memory',
    run.resources?.memory ?? '2g',
    '--cpus',
    run.resources?.cpus ?? '2',
    '--cap-drop',
    'ALL',
  ];
  args.push(...format.mount({ type: 'bind', source: run.workspaceRoot, target: '/workspace' }));
  args.push(...format.workdir('/workspace'));

  if (run.mountHostPathAlias && run.workspaceRoot !== '/workspace') {
    args.push(
      ...format.mount({ type: 'bind', source: run.workspaceRoot, target: run.workspaceRoot }),
    );
  }
  if (run.extraMounts) {
    for (const mount of run.extraMounts) {
      args.push(
        ...format.mount({
          type: 'bind',
          source: mount.source,
          target: mount.target,
          mode: 'ro',
        }),
      );
    }
  }
  if (memoryFilePath) {
    args.push(...format.environment('MEMORY_FILE_PATH=/memory/memory.jsonl'));
    args.push(
      ...format.mount({
        type: 'bind',
        source: dirname(memoryFilePath),
        target: '/memory',
        mode: 'rw',
      }),
    );
  }
  if (run.cacheVolume) {
    args.push(...format.mount({ type: 'volume', source: run.cacheVolume, target: '/cache' }));
  }
  return args;
}

/** Spawn a command with a timeout. Returns {code, stdout, stderr, timedOut}. */
export function spawnWithTimeout(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', data => out.push(data));
    child.stderr.on('data', data => err.push(data));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: 'spawn error', timedOut: false });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
        timedOut,
      });
    });
  });
}

export function which(bin: string): boolean {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}
