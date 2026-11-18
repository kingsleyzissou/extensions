import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { RunArgs, Runtime } from '../types/index';
import { buildCommonRunArgs, spawnWithTimeout, type RuntimeMount } from './shared';

// shortcut: Mount options cannot escape commas in paths; revisit if Apple's CLI adds escaping.
function mountOption({ type, source, target, mode }: RuntimeMount): string {
  if (source.includes(',') || target.includes(',')) {
    throw new Error('Apple Container mount paths cannot contain commas.');
  }
  return `type=${type},source=${source},target=${target}${mode === 'ro' ? ',readonly' : ''}`;
}

export function buildContainerRunArgs(
  run: RunArgs,
  internalNetwork?: string,
  memoryFilePath?: string,
): string[] {
  if (!run.allowNetwork && !internalNetwork) {
    throw new Error('An internal network is required when sandbox networking is disabled.');
  }

  const args = buildCommonRunArgs(run, memoryFilePath, {
    mount: mount => ['--mount', mountOption(mount)],
    environment: value => ['--env', value],
    workdir: path => ['--workdir', path],
  });
  if (process.env.SSH_AUTH_SOCK) args.push('--ssh');
  if (internalNetwork) args.push('--network', internalNetwork);
  args.push(run.image, 'sleep', 'infinity');
  return args;
}

export function imageDigestFromInspect(output: string): string | null {
  try {
    const parsed = JSON.parse(output);
    const image = Array.isArray(parsed) ? parsed[0] : parsed;
    const digest = image?.configuration?.descriptor?.digest ?? image?.variants?.[0]?.digest ?? null;
    return typeof digest === 'string' ? digest : null;
  } catch {
    return null;
  }
}

export function containerStateFromList(output: string, name: string): string | null {
  const containers: unknown = JSON.parse(output);
  if (!Array.isArray(containers)) throw new Error('Unexpected container list response.');
  const container = containers.find(entry => entry?.id === name);
  return typeof container?.status?.state === 'string' ? container.status.state : null;
}

const INTERNAL_NETWORK_LABEL = 'com.kingsleyzissou.pi-sandbox.internal';

export function isManagedInternalNetwork(output: string, name: string): boolean {
  try {
    const parsed = JSON.parse(output);
    const networks = Array.isArray(parsed) ? parsed : [parsed];
    const network = networks.find(
      entry => entry?.id === name || entry?.configuration?.name === name,
    );
    return (
      network?.configuration?.mode === 'hostOnly' &&
      network.configuration.labels?.[INTERNAL_NETWORK_LABEL] === 'true'
    );
  } catch {
    return false;
  }
}

function networkNameForContainer(name: string): string {
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 12);
  return `pi-sandbox-internal-${hash}`;
}

async function ensureInternalNetwork(name: string): Promise<void> {
  const inspect = await spawnWithTimeout('container', ['network', 'inspect', name], 5000);
  if (inspect.code === 0 && !inspect.timedOut) {
    if (isManagedInternalNetwork(inspect.stdout, name)) return;
    throw new Error(
      `Refusing to use existing network ${name}; it is not the sandbox internal network.`,
    );
  }

  const create = await spawnWithTimeout(
    'container',
    ['network', 'create', '--internal', '--label', `${INTERNAL_NETWORK_LABEL}=true`, name],
    10000,
  );
  const verify = await spawnWithTimeout('container', ['network', 'inspect', name], 5000);
  if (verify.code === 0 && !verify.timedOut && isManagedInternalNetwork(verify.stdout, name))
    return;
  if (create.code !== 0 || create.timedOut) {
    throw new Error(
      `Failed to create an internal Apple Container network: ${create.stderr || create.stdout}`,
    );
  }
  throw new Error(`Could not verify internal Apple Container network ${name}.`);
}

function deleteInternalNetwork(name: string): void {
  const inspect = spawnSync('container', ['network', 'inspect', name], { encoding: 'utf8' });
  if (inspect.status !== 0 || !isManagedInternalNetwork(inspect.stdout, name)) return;
  spawnSync('container', ['network', 'delete', name], { stdio: 'ignore' });
}

export function appleContainerRuntime(): Runtime {
  const bin = 'container';
  return {
    kind: 'apple',
    bin,
    containerState: async name => {
      const result = await spawnWithTimeout(bin, ['list', '--all', '--format', 'json'], 5000);
      if (result.code !== 0 || result.timedOut) {
        throw new Error(`Failed to list Apple Containers: ${result.stderr || result.stdout}`);
      }
      return containerStateFromList(result.stdout, name);
    },
    imageExists: async image => {
      const result = await spawnWithTimeout(bin, ['image', 'inspect', image], 10000);
      return result.code === 0 && !result.timedOut;
    },
    imageDigest: async image => {
      const result = await spawnWithTimeout(bin, ['image', 'inspect', image], 10000);
      if (result.code !== 0 || result.timedOut) return null;
      return imageDigestFromInspect(result.stdout);
    },
    pullImage: async (image, timeoutMs) => {
      const result = await spawnWithTimeout(bin, ['image', 'pull', image], timeoutMs);
      return result.code === 0 && !result.timedOut;
    },
    smokeTest: async (name, image, timeoutMs) => {
      const result = await spawnWithTimeout(
        bin,
        ['run', '--rm', '--name', name, image, 'sh', '-c', 'id -un && pwd'],
        timeoutMs,
      );
      if (result.code !== 0 || result.timedOut) return null;
      return result.stdout.trim();
    },
    stop: name => {
      spawnSync(bin, ['stop', name], { stdio: 'ignore' });
    },
    remove: name => {
      spawnSync(bin, ['delete', '--force', name], { stdio: 'ignore' });
      deleteInternalNetwork(networkNameForContainer(name));
    },
    start: async name => {
      const result = await spawnWithTimeout(bin, ['start', name], 10000);
      return result.code === 0 && !result.timedOut;
    },
    createVolume: async name => {
      const result = await spawnWithTimeout(bin, ['volume', 'create', name], 10000);
      return result.code === 0 && !result.timedOut;
    },
    run: async args => {
      const internalNetwork = args.allowNetwork ? undefined : networkNameForContainer(args.name);
      if (internalNetwork) await ensureInternalNetwork(internalNetwork);
      const result = await spawnWithTimeout(
        bin,
        buildContainerRunArgs(args, internalNetwork, process.env.MEMORY_FILE_PATH),
        60000,
      );
      if (result.timedOut) {
        if (internalNetwork) deleteInternalNetwork(internalNetwork);
        throw new Error(`Apple Container run timed out after 60s (container: ${args.name})`);
      }
      if (result.code !== 0) {
        if (internalNetwork) deleteInternalNetwork(internalNetwork);
        throw new Error(`Apple Container run failed: ${result.stderr || result.stdout}`);
      }
      return args.name;
    },
  };
}
