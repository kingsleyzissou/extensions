import { spawnSync } from 'node:child_process';
import type { RunArgs, Runtime } from '../types/index';
import { buildCommonRunArgs, formatBytes, parseBytesToBytes, spawnWithTimeout } from './shared';

export function buildPodmanRunArgs(
  run: RunArgs,
  memoryFilePath = process.env.MEMORY_FILE_PATH,
): string[] {
  const memory = run.resources?.memory ?? '2g';
  const swap = run.resources?.swap;
  const args = buildCommonRunArgs(run, memoryFilePath, {
    mount: mount => ['-v', `${mount.source}:${mount.target}${mount.mode ? `:${mount.mode}` : ''}`],
    environment: value => ['-e', value],
    workdir: path => ['-w', path],
  });
  const sshAuthSock = process.env.SSH_AUTH_SOCK;
  if (sshAuthSock) {
    args.push(
      '--userns=keep-id:uid=1000,gid=1000',
      '--mount',
      `type=bind,src=${sshAuthSock},target=/run/ssh-agent.sock`,
      '-e',
      'SSH_AUTH_SOCK=/run/ssh-agent.sock',
    );
  }
  args.push(
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(run.resources?.pidsLimit ?? 512),
  );
  if (run.resources?.disk) args.push('--storage-opt', `size=${run.resources.disk}`);
  if (swap !== undefined) {
    if (swap === '0') {
      args.push('--memory-swap', '0');
    } else {
      const totalSwap = parseBytesToBytes(memory) + parseBytesToBytes(swap);
      args.push('--memory-swap', formatBytes(totalSwap));
    }
  }
  if (!run.allowNetwork) args.push('--network', 'none');
  args.push(run.image, 'sleep', 'infinity');
  return args;
}

function podmanImageDigestFromInspect(output: string): string | null {
  try {
    const digests = JSON.parse(output.trim()) as string[];
    const digest = digests.find(value => value.includes('@sha256:')) ?? null;
    return digest?.split('@', 2)[1] ?? null;
  } catch {
    return null;
  }
}

export function podmanRuntime(): Runtime {
  const bin = 'podman';
  return {
    kind: 'podman',
    bin,
    containerState: async name => {
      const result = await spawnWithTimeout(
        bin,
        ['inspect', '--format', '{{.State.Status}}', name],
        5000,
      );
      if (result.code !== 0 || result.timedOut) return null;
      return result.stdout.trim() || null;
    },
    imageExists: async image => {
      const result = await spawnWithTimeout(bin, ['image', 'inspect', image], 10000);
      return result.code === 0 && !result.timedOut;
    },
    imageDigest: async image => {
      const result = await spawnWithTimeout(
        bin,
        ['image', 'inspect', image, '--format', '{{json .RepoDigests}}'],
        10000,
      );
      if (result.code !== 0 || result.timedOut) return null;
      return podmanImageDigestFromInspect(result.stdout);
    },
    pullImage: async (image, timeoutMs) => {
      const result = await spawnWithTimeout(bin, ['pull', image], timeoutMs);
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
      spawnSync(bin, ['rm', '-f', name], { stdio: 'ignore' });
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
      const result = await spawnWithTimeout(bin, buildPodmanRunArgs(args), 60000);
      if (result.timedOut) {
        throw new Error(`podman run timed out after 60s (command: podman run ${args.name})`);
      }
      if (result.code !== 0) {
        throw new Error(`podman run failed: ${result.stderr || result.stdout}`);
      }
      return args.name;
    },
  };
}
