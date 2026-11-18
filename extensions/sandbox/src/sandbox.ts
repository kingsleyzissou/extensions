import type { SandboxProjectConfig } from './config';
import type { MountSpec, RunArgs, Runtime } from './runtime';

export interface Sandbox {
  runtime: Runtime;
  name: string;
  workspaceRoot: string;
  hostCwd: string;
  remoteCwd: string;
  isBareRepo: boolean;
  keep: boolean;
  /** Mounts applied when the container was created. */
  mounts: MountSpec[];
  /** Host path prefixes allowed for read access from outside the workspace. */
  allowedExternalPrefixes: string[];
  /** Resource limits applied to the container. */
  resources?: RunArgs['resources'];
  /** Image reference used for this sandbox, e.g. pi-sandbox:latest. */
  imageRef: string;
  /** Project image config in effect when the sandbox started. */
  projectConfig: SandboxProjectConfig;
  /** Whether this sandbox is re-usable across sessions. */
  isReusable: boolean;
  /** Whether this sandbox was reattached (vs newly created). */
  isReattached: boolean;
}
