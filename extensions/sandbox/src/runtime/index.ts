import type { Runtime } from '../types/index';
import { appleContainerRuntime } from './apple';
import { podmanRuntime } from './podman';
import { spawnWithTimeout, which } from './shared';

export type { SandboxConfig, SizeTier, TierSpec } from './shared';
export {
  deriveContainerName,
  loadSandboxConfig,
  parseSizeTier,
  randomSuffix,
  spawnWithTimeout,
  TIER_SPECS,
} from './shared';
export {
  buildContainerRunArgs,
  containerStateFromList,
  imageDigestFromInspect,
  isManagedInternalNetwork,
} from './apple';
export { buildPodmanRunArgs } from './podman';

export async function detectRuntime(): Promise<Runtime | null> {
  if (process.platform === 'darwin') {
    if (!which('container')) return null;
    const result = await spawnWithTimeout(
      'container',
      ['system', 'status', '--format', 'json'],
      3000,
    );
    if (result.code !== 0 || result.timedOut) return null;
    try {
      const status = JSON.parse(result.stdout);
      if (status.status !== 'running' || status.host?.architecture !== 'arm64') return null;
    } catch {
      return null;
    }
    return appleContainerRuntime();
  }

  if (process.platform !== 'linux' || !which('podman')) return null;
  const result = await spawnWithTimeout('podman', ['info', '--format', 'json'], 5000);
  if (result.code !== 0 || result.timedOut) return null;
  return podmanRuntime();
}
