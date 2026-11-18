import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import type { Runtime } from './types/index';

// Size tier configuration
// ---------------------------------------------------------------------------

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

/** Parse a human-readable size string (e.g., "2g", "512m") to bytes */
function parseBytesToBytes(s: string): number {
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(b|k|m|g|t)?$/i);
  if (!match?.[1]) return 0;
  const val = parseFloat(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    k: 1024,
    m: 1024 ** 2,
    g: 1024 ** 3,
    t: 1024 ** 4,
  };
  return Math.round(val * (multipliers[unit] ?? 1));
}

/** Format bytes back to the largest whole unit (e.g., 3221225472 → "3g") */
function formatBytes(bytes: number): string {
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

// ---------------------------------------------------------------------------
// Runtime selection and Podman implementation
// ---------------------------------------------------------------------------

export function randomSuffix(): string {
  return randomBytes(4).toString('hex');
}

/**
 * Derive a deterministic container name from the shared workspace root.
 * Format: pi-sbx-<dirname>-<hash6>
 */
export function deriveContainerName(workspaceRoot: string): string {
  const basename = workspaceRoot.split('/').filter(Boolean).pop() || 'project';
  const hash = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 6);
  return `pi-sbx-${basename}-${hash}`;
}

function which(bin: string): boolean {
  const r = spawnSync('which', [bin], { stdio: 'ignore' });
  return r.status === 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function detectRuntime(ctx?: any): Promise<Runtime | null> {
  const havePodman = which('podman');

  if (!havePodman) {
    return null;
  }

  const runtime = podmanRuntime();

  // Test the runtime with a quick 3s smoke test
  const testName = `pi-test-${randomSuffix()}`;
  try {
    const r = await spawnWithTimeout(
      runtime.bin,
      [
        'run',
        '-d',
        '--rm',
        '--name',
        testName,
        'registry.fedoraproject.org/fedora-minimal:44',
        'sleep',
        'infinity',
      ],
      3000,
    );
    if (r.code === 0 && !r.timedOut) {
      // Clean up test container
      runtime.stop(testName);
      if (ctx?.ui) {
        ctx.ui.notify(`Using podman runtime (3s smoke test passed)`, 'info');
      }
      return runtime;
    }
    if (r.timedOut) {
      if (ctx?.ui) {
        ctx.ui.notify(`podman runtime timed out (3s)`, 'warning');
      }
    }
  } catch {
    // Fall through
  }

  return null;
}

/** Spawn a command with a timeout. Returns {code, stdout, stderr, timedOut} */
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

    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
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

export function podmanRuntime(): Runtime {
  const bin = 'podman';
  return {
    kind: 'podman',
    bin,
    exists: async image => {
      const r = await spawnWithTimeout(bin, ['image', 'inspect', image], 10000);
      return r.code === 0 && !r.timedOut;
    },
    stop: name => {
      spawnSync(bin, ['stop', name], { stdio: 'ignore' });
    },
    remove: name => {
      spawnSync(bin, ['rm', '-f', name], { stdio: 'ignore' });
    },
    isRunning: async (name: string) => {
      const r = await spawnWithTimeout(
        bin,
        ['inspect', '--format', '{{.State.Running}}', name],
        5000,
      );
      return r.code === 0 && r.stdout.trim() === 'true';
    },
    start: async (name: string) => {
      const r = await spawnWithTimeout(bin, ['start', name], 10000);
      return r.code === 0 && !r.timedOut;
    },
    createVolume: async (name: string) => {
      const r = await spawnWithTimeout(bin, ['volume', 'create', name], 10000);
      return r.code === 0 && !r.timedOut;
    },
    run: async ({
      name,
      image,
      workspaceRoot,
      mountHostPathAlias,
      allowNetwork,
      extraMounts,
      resources,
      cacheVolume,
    }) => {
      const memory = resources?.memory ?? '2g';
      const cpus = resources?.cpus ?? '2';
      const pidsLimit = resources?.pidsLimit ?? 512;
      const swap = resources?.swap;
      const disk = resources?.disk;

      const args: string[] = [
        'run',
        '-d',
        '--name',
        name,
        '--user',
        '1000:1000',
        '--memory',
        memory,
        '--cpus',
        cpus,
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        String(pidsLimit),
        '-v',
        `${workspaceRoot}:/workspace`,
        '-w',
        '/workspace',
      ];
      if (mountHostPathAlias && workspaceRoot !== '/workspace') {
        args.push('-v', `${workspaceRoot}:${workspaceRoot}`);
      }
      if (extraMounts) {
        for (const m of extraMounts) {
          args.push('-v', `${m.source}:${m.target}:ro`);
        }
      }
      const memoryFilePath = process.env.MEMORY_FILE_PATH;
      if (memoryFilePath) {
        args.push(
          '-e',
          'MEMORY_FILE_PATH=/memory/memory.jsonl',
          '-v',
          `${dirname(memoryFilePath)}:/memory:rw`,
        );
      }
      // Mount cache volume if provided
      if (cacheVolume) {
        args.push('-v', `${cacheVolume}:/cache`);
      }
      // Add storage/disk limit if provided (supported on some storage drivers)
      if (disk) {
        args.push('--storage-opt', `size=${disk}`);
      }
      if (swap !== undefined) {
        if (swap === '0') {
          args.push('--memory-swap', '0'); // 0 = unlimited swap
        } else {
          // --memory-swap = RAM + swap (total), tier spec stores swap-only portion
          const totalSwap = parseBytesToBytes(memory) + parseBytesToBytes(swap);
          args.push('--memory-swap', formatBytes(totalSwap));
        }
      }
      if (!allowNetwork) args.push('--network', 'none');
      args.push(image, 'sleep', 'infinity');
      const r = await spawnWithTimeout(bin, args, 60000);
      if (r.timedOut) {
        throw new Error(`podman run timed out after 60s (command: podman run ${name})`);
      }
      if (r.code !== 0) {
        throw new Error(`podman run failed: ${r.stderr || r.stdout}`);
      }
      return name;
    },
  };
}

// ---------------------------------------------------------------------------
