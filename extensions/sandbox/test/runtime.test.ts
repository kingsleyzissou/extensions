import { describe, expect, test } from 'bun:test';
import {
  buildContainerRunArgs,
  buildPodmanRunArgs,
  containerStateFromList,
  imageDigestFromInspect,
  isManagedInternalNetwork,
} from '../src/runtime';

describe('Podman runtime helpers', () => {
  test('preserves Linux resource limits, mounts, and disconnected networking', () => {
    const args = buildPodmanRunArgs(
      {
        name: 'pi-sbx-test',
        image: 'pi-sandbox:latest',
        workspaceRoot: '/repo',
        mountHostPathAlias: true,
        allowNetwork: false,
        extraMounts: [{ source: '/skills', target: '/skills' }],
        resources: {
          memory: '4g',
          cpus: '2',
          pidsLimit: 256,
          swap: '2g',
          disk: '10g',
        },
        cacheVolume: 'cache',
      },
      '/tmp/memory.jsonl',
    );

    expect(args).toEqual([
      'run',
      '-d',
      '--name',
      'pi-sbx-test',
      '--user',
      '1000:1000',
      '--memory',
      '4g',
      '--cpus',
      '2',
      '--cap-drop',
      'ALL',
      '-v',
      '/repo:/workspace',
      '-w',
      '/workspace',
      '-v',
      '/repo:/repo',
      '-v',
      '/skills:/skills:ro',
      '-e',
      'MEMORY_FILE_PATH=/memory/memory.jsonl',
      '-v',
      '/tmp:/memory:rw',
      '-v',
      'cache:/cache',
      ...(process.env.SSH_AUTH_SOCK
        ? [
            '--userns=keep-id:uid=1000,gid=1000',
            '--mount',
            `type=bind,src=${process.env.SSH_AUTH_SOCK},target=/run/ssh-agent.sock`,
            '-e',
            'SSH_AUTH_SOCK=/run/ssh-agent.sock',
          ]
        : []),
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '256',
      '--storage-opt',
      'size=10g',
      '--memory-swap',
      '6g',
      '--network',
      'none',
      'pi-sandbox:latest',
      'sleep',
      'infinity',
    ]);
  });
});

test('forwards an available SSH agent without requiring it', () => {
  const sshAuthSock = process.env.SSH_AUTH_SOCK;
  const run = {
    name: 'pi-sbx-test',
    image: 'pi-sandbox:latest',
    workspaceRoot: '/repo',
    allowNetwork: true,
  };

  try {
    delete process.env.SSH_AUTH_SOCK;
    expect(buildContainerRunArgs(run)).not.toContain('--ssh');
    expect(buildPodmanRunArgs(run, '')).not.toContain('SSH_AUTH_SOCK=/run/ssh-agent.sock');

    process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock';
    expect(buildContainerRunArgs(run)).toContain('--ssh');
    expect(buildPodmanRunArgs(run, '')).toContain('--userns=keep-id:uid=1000,gid=1000');
    expect(buildPodmanRunArgs(run, '')).toContain(
      'type=bind,src=/tmp/ssh-agent.sock,target=/run/ssh-agent.sock',
    );
    expect(buildPodmanRunArgs(run, '')).toContain('SSH_AUTH_SOCK=/run/ssh-agent.sock');
  } finally {
    if (sshAuthSock === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = sshAuthSock;
  }
});

describe('Apple Container runtime helpers', () => {
  test('builds run arguments with resource limits, mounts, and isolated networking', () => {
    const args = buildContainerRunArgs(
      {
        name: 'pi-sbx-test',
        image: 'pi-sandbox:latest',
        workspaceRoot: '/repo',
        mountHostPathAlias: true,
        allowNetwork: false,
        extraMounts: [{ source: '/skills', target: '/skills' }],
        resources: { memory: '4g', cpus: '2' },
        cacheVolume: 'cache',
      },
      'pi-sandbox-internal-test',
      '/tmp/memory.jsonl',
    );

    expect(args).toEqual([
      'run',
      '-d',
      '--name',
      'pi-sbx-test',
      '--user',
      '1000:1000',
      '--memory',
      '4g',
      '--cpus',
      '2',
      '--cap-drop',
      'ALL',
      '--mount',
      'type=bind,source=/repo,target=/workspace',
      '--workdir',
      '/workspace',
      '--mount',
      'type=bind,source=/repo,target=/repo',
      '--mount',
      'type=bind,source=/skills,target=/skills,readonly',
      '--env',
      'MEMORY_FILE_PATH=/memory/memory.jsonl',
      '--mount',
      'type=bind,source=/tmp,target=/memory',
      '--mount',
      'type=volume,source=cache,target=/cache',
      ...(process.env.SSH_AUTH_SOCK ? ['--ssh'] : []),
      '--network',
      'pi-sandbox-internal-test',
      'pi-sandbox:latest',
      'sleep',
      'infinity',
    ]);
  });

  test('does not select an implicit network when networking is enabled', () => {
    const args = buildContainerRunArgs({
      name: 'pi-sbx-test',
      image: 'pi-sandbox:latest',
      workspaceRoot: '/repo',
      allowNetwork: true,
    });

    expect(args).not.toContain('--network');
  });

  test('requires an internal network when networking is disabled', () => {
    expect(() =>
      buildContainerRunArgs({
        name: 'pi-sbx-test',
        image: 'pi-sandbox:latest',
        workspaceRoot: '/repo',
        allowNetwork: false,
      }),
    ).toThrow('An internal network is required');
  });

  test('rejects comma-separated mount paths rather than changing their interpretation', () => {
    expect(() =>
      buildContainerRunArgs({
        name: 'pi-sbx-test',
        image: 'pi-sandbox:latest',
        workspaceRoot: '/repo,other',
        allowNetwork: true,
      }),
    ).toThrow('mount paths cannot contain commas');
  });

  test('reads the image digest from Apple Container inspect output', () => {
    const output = JSON.stringify([
      { configuration: { descriptor: { digest: 'sha256:manifest' } } },
    ]);

    expect(imageDigestFromInspect(output)).toBe('sha256:manifest');
    expect(imageDigestFromInspect('not json')).toBeNull();
  });

  test('reads container state from list output', () => {
    const output = JSON.stringify([
      { id: 'pi-sbx-test', status: { state: 'running' } },
      { id: 'pi-sbx-stopped', status: { state: 'stopped' } },
    ]);

    expect(containerStateFromList(output, 'pi-sbx-test')).toBe('running');
    expect(containerStateFromList(output, 'pi-sbx-stopped')).toBe('stopped');
    expect(containerStateFromList(output, 'missing')).toBeNull();
    expect(() => containerStateFromList('{}', 'missing')).toThrow(
      'Unexpected container list response',
    );
  });

  test('reuses only the named host-only network created for the sandbox', () => {
    const inspection = JSON.stringify([
      {
        id: 'pi-sandbox-internal-test',
        configuration: {
          name: 'pi-sandbox-internal-test',
          mode: 'hostOnly',
          labels: { 'com.kingsleyzissou.pi-sandbox.internal': 'true' },
        },
      },
    ]);

    expect(isManagedInternalNetwork(inspection, 'pi-sandbox-internal-test')).toBe(true);
    expect(isManagedInternalNetwork(inspection, 'another-name')).toBe(false);
    expect(isManagedInternalNetwork('not json', 'pi-sandbox-internal-test')).toBe(false);
  });
});
