export type RuntimeKind = 'apple' | 'podman';

export interface Runtime {
  kind: RuntimeKind;
  /** Runtime executable, used for container exec. */
  bin: string;
  run(args: RunArgs): Promise<string>;
  stop(name: string): void;
  remove(name: string): void;
  containerState(name: string): Promise<string | null>;
  imageExists(image: string): Promise<boolean>;
  imageDigest(image: string): Promise<string | null>;
  pullImage(image: string, timeoutMs: number): Promise<boolean>;
  smokeTest(name: string, image: string, timeoutMs: number): Promise<string | null>;
  start(name: string): Promise<boolean>;
  createVolume(name: string): Promise<boolean>;
}

export interface MountSpec {
  /** Absolute path on the host. */
  source: string;
  /** Absolute path inside the container. */
  target: string;
}

export interface RunArgs {
  name: string;
  image: string;
  workspaceRoot: string;
  /** Mount the bare repo at its host-absolute path so Git worktree pointers resolve. */
  mountHostPathAlias?: boolean;
  allowNetwork: boolean;
  /** Extra read-only bind mounts (e.g. skill directories). */
  extraMounts?: MountSpec[];
  /** Resource limits; Apple Containers only applies memory and CPU. */
  resources?: {
    memory?: string;
    cpus?: string;
    pidsLimit?: number;
    swap?: string;
    disk?: string;
  };
  /** Optional volume to mount at /cache for persistent caching. */
  cacheVolume?: string;
}
