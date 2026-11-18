export type RuntimeKind = 'podman';

export interface Runtime {
  kind: RuntimeKind;
  bin: string;
  /** Returns the container name actually used (may differ from args.name on collision). */
  run(args: RunArgs): Promise<string>;
  stop(name: string): void;
  /** Remove a container forcefully (podman rm -f). */
  remove(name: string): void;
  exists(image: string): Promise<boolean>;
  /** Check if a container with the given name is running. */
  isRunning(name: string): Promise<boolean>;
  /** Start an existing stopped container. */
  start(name: string): Promise<boolean>;
  /** Create a volume if it doesn't exist. */
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
  /** Resource limits (undefined = use runtime default). */
  resources?: {
    memory?: string; // e.g., "2g", "512m", "10gb"
    cpus?: string; // e.g., "2", "0.5", "4.0"
    pidsLimit?: number; // e.g., 512
    swap?: string; // e.g., "1g", "0" to disable
    disk?: string; // disk/storage limit (e.g., "10g", "20gb")
  };
  /** Optional volume to mount at /cache for persistent caching. */
  cacheVolume?: string;
}
