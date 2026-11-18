/**
 * pi-container-sandbox
 * --------------------
 * Forked from https://github.com/TheGreatAxios/pi-extensions/tree/main/pi-container-sandbox
 * Original author: Sawyer Cutler (https://github.com/TheGreatAxios)
 * Adapted to use Podman instead of Docker.
 *
 * Run every read/write/edit/bash operation pi performs inside a persistent,
 * repository-scoped Linux container (Podman).
 *
 * Threat model:
 *   - The agent's bash and file tools run in the project workspace mounted at
 *     /workspace. Bare-repo worktrees share that mount and persistent container.
 *   - The agent runs as a non-root user (uid 1000) inside the container.
 *   - No host secrets are mounted (no $HOME, ~/.ssh, ~/.aws, ~/.config, no
 *     SSH agent, no container socket).
 *   - Network is enabled by default; the security proxy gates outbound traffic.
 *     Disable with --no-container-net.
 *     Podman uses --network none (when disabled).
 *   - Resource caps via size tiers (xs, sm, md, lg, xlg, xxlg) limit blast radius.
 *     Override with --container-size or individual --container-memory, --container-cpus, etc.
 *
 * Path safety:
 *   - Tool paths outside the mounted workspace are rejected. For bare repos,
 *     the shared workspace includes every worktree beneath the bare repo root.
 *     EXCEPTION: pi clipboard temp files (basename "pi-clipboard-*") are read
 *     directly from the host. Additional paths can be allowed via
 *     --container-allow-paths or /sandbox allow.
 *
 * Usage:
 *   Podman: image is pulled automatically from the registry on first run.
 *   Then run pi with the extension (sandbox is ON by default):
 *        pi -e ./index.ts
 *      Optional flags:
 *        --container-size xs|sm|md|lg|xlg|xxlg (default: md)
 *        --sandbox-name <name>                 (override the default repo-scoped name)
 *        --sandbox-persist                     (force persistence; already on by default)
 *        --sandbox-cache <volume>              (persistent cache volume at /cache)
 *        --container-image <name>            (default: pi-sandbox:latest)
 *        --container-net                     (allow outbound network)
 *        --browser                            (alias for --container-net)
 *        --container-keep                    (keep even when project config opts out of persistence)
 *        --container-mount-skills            (mount ~/.agents/skills & ~/.pi/agent/skills read-only at /skills; default: on)
 *        --container-mount-paths <paths>     (comma-separated extra host dirs to mount at /skills/<basename>)
 *        --container-memory <limit>          (e.g., 10g, 512m)
 *        --container-cpus <count>            (e.g., 4, 0.5)
 *        --container-pids-limit <n>          (max processes; default: 512)
 *        --container-swap <limit>            (swap limit, e.g., 1g)
 *        --no-container, --noc               (bypass entirely)
 *
 * Config file (.pi/config.json):
 *   {
 *     "sandbox": {
 *       "size": "lg",
 *       "cacheVolume": "my-project-cache"
 *     }
 *   }
 *   Persistent repo-scoped containers are the default; no project config is required.
 */

import { resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import {
  type ExtensionAPI,
  type ExtensionUIContext,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import { resolveSandboxWorkspace } from './worktrees';
import {
  detectHostGitIdentity,
  fetchTagDigest,
  imageRefForTag,
  loadSandboxProjectConfig,
  saveSandboxProjectConfig,
} from './config';
import { PathApprovalStore } from './path-approvals';
import { registerSandboxCommands } from './commands';
import type { RunArgs, Sandbox } from './types';
import {
  bashOps,
  discoverSkillDirs,
  editOps,
  ensureExternalReadApproved,
  execArgv,
  execCapture,
  getExternalPath,
  isAllowedExternalResource,
  readOps,
  shq,
  SKILLS_ROOT,
  writeOps,
} from './operations';
import {
  deriveContainerName,
  detectRuntime,
  loadSandboxConfig,
  parseSizeTier,
  spawnWithTimeout,
  TIER_SPECS,
} from './runtime';

let sandbox: Sandbox | null = null;
let pathApprovals: PathApprovalStore | null = null;
const getSbx = () => sandbox;

export function registerExtension(pi: ExtensionAPI) {
  pi.registerFlag('container', {
    description: 'Sandbox all bash/read/write/edit ops inside a Linux container (default: on)',
    type: 'boolean',
    default: true,
  });
  pi.registerFlag('no-container', {
    description: 'Force-disable container sandboxing',
    type: 'boolean',
    default: false,
  });
  pi.registerFlag('noc', {
    description: 'Alias for --no-container',
    type: 'boolean',
    default: false,
  });
  pi.registerFlag('container-size', {
    description:
      'Sandbox size tier: xs, sm, md (default), lg, xlg, xxlg. Sets memory, swap, cpu, disk limits.',
    type: 'string',
    default: 'md',
  });
  pi.registerFlag('sandbox-name', {
    description: 'Override the default persistent repo-scoped sandbox name.',
    type: 'string',
  });
  pi.registerFlag('sandbox-persist', {
    description: 'Force persistence when project config opts out (persistent by default)',
    type: 'boolean',
    default: false,
  });
  pi.registerFlag('sandbox-cache', {
    description: 'Volume name for persistent cache at /cache (auto-created if needed)',
    type: 'string',
  });
  pi.registerFlag('container-image', {
    description: 'Image to use for the sandbox (default: pi-sandbox:latest)',
    type: 'string',
  });
  pi.registerFlag('container-net', {
    description:
      'Allow outbound network from the sandbox (default: on; use --no-container-net to disable)',
    type: 'boolean',
    default: true,
  });
  pi.registerFlag('browser', {
    description: 'Alias for --container-net (enables network for chromium)',
    type: 'boolean',
    default: false,
  });
  pi.registerFlag('container-keep', {
    description: 'Keep the container after exit when persistence is disabled',
    type: 'boolean',
    default: false,
  });
  pi.registerFlag('container-mount-skills', {
    description:
      'Mount agent skill directories read-only into the container at /skills (default: on)',
    type: 'boolean',
    default: true,
  });
  pi.registerFlag('container-mount-paths', {
    description:
      'Comma-separated list of additional host directories to mount read-only at /skills/<basename>',
    type: 'string',
  });
  pi.registerFlag('container-allow-paths', {
    description:
      'Comma-separated list of host path prefixes to allow for read access from outside the sandbox (e.g. ~/Downloads)',
    type: 'string',
  });
  pi.registerFlag('container-memory', {
    description: 'Memory limit for the container (e.g., 2g, 512m, 10gb). Default: 2g',
    type: 'string',
  });
  pi.registerFlag('container-cpus', {
    description: 'CPU limit for the container (e.g., 2, 0.5, 4.0). Default: 2',
    type: 'string',
  });
  pi.registerFlag('container-pids-limit', {
    description: 'Maximum number of PIDs the container can create. Default: 512',
    type: 'string',
  });
  pi.registerFlag('container-swap', {
    description: 'Swap limit for the container (e.g., 1g, 0 to disable). Default: unset',
    type: 'string',
  });

  const localCwd = process.cwd();
  // pi's AgentTool type omits the ctx param (5th arg) built-in tools accept at runtime;
  // forwarding it is required for PI_* session env injection (e.g. PI_MODEL)
  type CtxTool = {
    execute: (id: string, params: any, signal: any, onUpdate: any, ctx: any) => any;
  };
  const withCtx = <T extends object>(t: T): T & CtxTool => t as T & CtxTool;
  const localRead = withCtx(createReadTool(localCwd));
  const localWrite = withCtx(createWriteTool(localCwd));
  const localEdit = withCtx(createEditTool(localCwd));
  const localBash = withCtx(createBashTool(localCwd));

  // Initialize the persistent path approval store
  pathApprovals = new PathApprovalStore(getAgentDir());

  /**
   * Shared guard for read tools: if the path is external, check approvals
   * and prompt interactively before delegating to sandbox readOps.
   */
  async function guardExternalRead(
    paramsPath: string,
    sbx: Sandbox,
    ctx: { ui: ExtensionUIContext; hasUI: boolean },
  ): Promise<void> {
    const external = getExternalPath(paramsPath, sbx.hostCwd, sbx.workspaceRoot, sbx.mounts);
    if (!external) return;
    // Already in session allowlist?
    if (isAllowedExternalResource(external, sbx.allowedExternalPrefixes)) return;
    // Need UI for interactive prompt
    if (!ctx.hasUI) {
      throw new Error(
        `sandbox: refusing to access ${external}: outside mounted workspace ${sbx.workspaceRoot}. ` +
          `Use --container-allow-paths or /sandbox allow to grant access.`,
      );
    }
    await ensureExternalReadApproved(external, sbx, pathApprovals!, ctx.ui);
  }

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const sbx = getSbx();
      if (!sbx) return localRead.execute(id, params, signal, onUpdate, ctx);
      await guardExternalRead(params.path, sbx, ctx);
      const tool = createReadTool(sbx.hostCwd, { operations: readOps(sbx) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const sbx = getSbx();
      if (!sbx) return localWrite.execute(id, params, signal, onUpdate, ctx);
      const tool = createWriteTool(sbx.hostCwd, { operations: writeOps(sbx) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const sbx = getSbx();
      if (!sbx) return localEdit.execute(id, params, signal, onUpdate, ctx);
      const tool = createEditTool(sbx.hostCwd, { operations: editOps(sbx) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...localBash,
    label: 'bash (sandboxed)',
    async execute(id, params, signal, onUpdate, ctx) {
      const sbx = getSbx();
      if (!sbx) return localBash.execute(id, params, signal, onUpdate, ctx);
      const tool = createBashTool(sbx.hostCwd, { operations: bashOps(sbx) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on('user_bash', () => {
    const sbx = getSbx();
    if (!sbx) return;
    return { operations: bashOps(sbx) };
  });

  pi.on('before_agent_start', async event => {
    const sbx = getSbx();
    if (!sbx) return;

    event.systemPromptOptions.cwd = sbx.remoteCwd;
    const skillInfo = sbx.mounts.length
      ? `Agent skills are mounted read-only at ${SKILLS_ROOT}/ (e.g. ${sbx.mounts.map(m => m.target).join(', ')}). Read skill files via /skills/<name>/SKILL.md. Writing to /skills/ is forbidden.`
      : 'No skill directories are mounted.';
    const cwdInfo = `Current working directory: ${sbx.remoteCwd} (sandboxed in ${sbx.runtime.kind} container ${sbx.name}, host cwd ${sbx.hostCwd} mounted read-write)`;
    const promptHasCwd = /^Current working directory: .*$/m.test(event.systemPrompt);
    const systemPrompt = promptHasCwd
      ? event.systemPrompt.replace(/^Current working directory: .*$/m, cwdInfo)
      : `${event.systemPrompt}\n${cwdInfo}`;

    return { systemPrompt: `${systemPrompt}\n${skillInfo}` };
  });

  pi.on('session_start', async (_event, ctx) => {
    if ((pi.getFlag('no-container') as boolean) || (pi.getFlag('noc') as boolean)) return;
    if (!(pi.getFlag('container') as boolean)) return;

    try {
      const runtime = await detectRuntime(ctx);
      if (!runtime) {
        ctx.ui.notify('Podman not available or timed out. Running without sandbox.', 'warning');
        return;
      }

      const workspace = resolveSandboxWorkspace(localCwd);

      // Load sandbox config from .pi/config.json and .pi/agent/sandbox.json
      const config = loadSandboxConfig(localCwd);
      const projectConfig = loadSandboxProjectConfig(localCwd);

      // Determine size tier (flag > config > default)
      const sizeFlag = pi.getFlag('container-size') as string | undefined;
      const sizeTier = parseSizeTier(sizeFlag || config?.size || 'md') || 'md';
      const tierSpec = TIER_SPECS[sizeTier];

      // Resolve image: flag > .pi/agent/sandbox.json > default
      const flagImage = pi.getFlag('container-image') as string | undefined;
      const configImageRef = imageRefForTag(projectConfig.image, projectConfig.tag);
      const image = flagImage || configImageRef || 'pi-sandbox:latest';
      const allowNetwork =
        (pi.getFlag('container-net') as boolean) || (pi.getFlag('browser') as boolean);
      const keep = pi.getFlag('container-keep') as boolean;
      const persist = (pi.getFlag('sandbox-persist') as boolean) || (config?.persist ?? true);
      const mountSkills = pi.getFlag('container-mount-skills') as boolean;
      const extraPathsRaw = pi.getFlag('container-mount-paths') as string | undefined;
      const extraPaths = extraPathsRaw
        ? extraPathsRaw
            .split(',')
            .map(p => p.trim())
            .filter(Boolean)
        : undefined;

      // All worktrees in a bare repo share one persistent container.
      const nameFlag = pi.getFlag('sandbox-name') as string | undefined;
      const sandboxName = nameFlag || deriveContainerName(workspace.root);
      const isReusable = Boolean(nameFlag) || persist;

      // Determine cache volume
      const cacheFlag = pi.getFlag('sandbox-cache') as string | undefined;
      const cacheVolume = cacheFlag || config?.cacheVolume;

      // Create cache volume if specified
      if (cacheVolume) {
        await runtime.createVolume(cacheVolume);
      }

      // Discover skill directories on the host.
      const skillMounts = mountSkills ? discoverSkillDirs(extraPaths) : [];

      // Check if a container with this name already exists:
      //   - Running  → reattach (crash recovery, persist mode, or concurrent session)
      //   - Stopped  → start if reusable/persist, otherwise remove for fresh slate
      //   - Missing  → create new
      let isReattached = false;
      {
        const running = await runtime.isRunning(sandboxName);
        if (running) {
          isReattached = true;
          ctx.ui.notify(`⇄ Reattaching to existing sandbox: ${sandboxName}`, 'info');
        } else {
          // Check if container exists at all (stopped state)
          const inspect = await spawnWithTimeout(
            runtime.bin,
            ['inspect', '--format', 'exists', sandboxName],
            5000,
          );
          if (inspect.code === 0 && !inspect.timedOut) {
            // Container exists but is not running
            if (isReusable) {
              // Reusable or persist mode → start the stopped container
              const started = await runtime.start(sandboxName);
              if (started) {
                isReattached = true;
                ctx.ui.notify(`↻ Restarted existing sandbox: ${sandboxName}`, 'info');
              } else {
                // Start failed — remove it and create fresh
                ctx.ui.notify(
                  `Removing broken container ${sandboxName}, creating fresh...`,
                  'warning',
                );
                runtime.remove(sandboxName);
              }
            } else {
              // Non-reusable, non-persist → remove stale container for clean slate
              ctx.ui.notify(`Cleaning up stale container ${sandboxName} for fresh sandbox`, 'info');
              runtime.remove(sandboxName);
            }
          }
        }
      }

      if (!(await runtime.exists(image))) {
        ctx.ui.notify(`Sandbox image "${image}" not found locally, pulling from registry...`);
        const pull = await spawnWithTimeout(runtime.bin, ['pull', image], 120000);
        if (pull.code !== 0 || pull.timedOut) {
          ctx.ui.notify(
            `Sandbox image "${image}" not found. Pull failed. Build it manually:\n  podman build -t ${image} -f containers/Containerfile containers`,
            'error',
          );
          return;
        }
      }

      const allowPathsRaw = pi.getFlag('container-allow-paths') as string | undefined;
      const allowedExternalPrefixes = allowPathsRaw
        ? allowPathsRaw
            .split(',')
            .map(p => p.trim())
            .filter(Boolean)
            .map(p => (p.startsWith('~') ? resolvePath(homedir(), p.slice(1)) : resolvePath(p)))
        : [];

      // Build resource config from tier + flag overrides
      const resources: RunArgs['resources'] = {
        memory: tierSpec.memory,
        cpus: tierSpec.cpus,
        swap: tierSpec.swap,
        disk: tierSpec.disk,
      };

      // Apply flag overrides
      const memFlag = pi.getFlag('container-memory') as string | undefined;
      const cpusFlag = pi.getFlag('container-cpus') as string | undefined;
      const pidsFlagRaw = pi.getFlag('container-pids-limit') as string | undefined;
      const pidsFlag = pidsFlagRaw ? parseInt(pidsFlagRaw, 10) : undefined;
      const swapFlag = pi.getFlag('container-swap') as string | undefined;
      if (memFlag) resources.memory = memFlag;
      if (cpusFlag) resources.cpus = cpusFlag;
      if (pidsFlag !== undefined) resources.pidsLimit = pidsFlag;
      if (swapFlag !== undefined) resources.swap = swapFlag;

      // Create new sandbox if not reattaching
      let actualName = sandboxName;
      if (!isReattached) {
        actualName = await runtime.run({
          name: sandboxName,
          image,
          workspaceRoot: workspace.root,
          mountHostPathAlias: workspace.isBareRepo,
          allowNetwork,
          extraMounts: skillMounts.length ? skillMounts : undefined,
          resources,
          cacheVolume,
        });
      }

      sandbox = {
        runtime,
        name: actualName,
        workspaceRoot: workspace.root,
        hostCwd: localCwd,
        remoteCwd: workspace.remoteCwd,
        isBareRepo: workspace.isBareRepo,
        keep: keep || persist,
        mounts: skillMounts,
        allowedExternalPrefixes,
        resources,
        imageRef: image,
        projectConfig,
        isReusable,
        isReattached,
      };

      // Cleanup removes non-persistent containers; persistent containers stay running for reuse.
      const cleanup = () => {
        const s = sandbox;
        if (!s || s.keep) return;
        try {
          s.runtime.stop(s.name);
          s.runtime.remove(s.name);
        } catch {
          /* ignore */
        }
        sandbox = null;
      };
      process.once('exit', cleanup);
      process.once('SIGINT', () => {
        cleanup();
        process.exit(130);
      });
      process.once('SIGTERM', () => {
        cleanup();
        process.exit(143);
      });

      // Configure git identity inside the container so commits
      // are authored correctly. Uses the `git` field from
      // .pi/agent/sandbox.json if present, otherwise falls back
      // to the host's git config.
      const gitId = projectConfig.git ?? (await detectHostGitIdentity());
      if (gitId) {
        try {
          await execArgv(
            sandbox,
            ['git', 'config', '--global', 'user.name', gitId.user.name],
            5000,
          );
          await execArgv(
            sandbox,
            ['git', 'config', '--global', 'user.email', gitId.user.email],
            5000,
          );
        } catch {
          // Non-fatal — git may not be installed or config dir unwritable
        }
      }

      // Smoke test (10s timeout)
      const ok = (
        await execCapture(sandbox, `id -un && cd ${shq(sandbox.remoteCwd)} && pwd`, 10000)
      )
        .toString()
        .trim();

      // Build resource status string
      const resParts: string[] = [
        `size=${sizeTier}`,
        `mem=${resources.memory}`,
        `cpu=${resources.cpus}`,
        `swap=${resources.swap}`,
        `disk=${resources.disk}`,
      ];
      if (resources.pidsLimit !== undefined) resParts.push(`pids=${resources.pidsLimit}`);
      const resStr = ` (${resParts.join(', ')})`;

      const statusPrefix = isReattached ? '✓ Reattached' : '󰞀 Sandbox up';
      ctx.ui.setStatus('sandbox', undefined);
      ctx.ui.setWidget(
        'sandbox-status',
        [
          ctx.ui.theme.fg(
            'accent',
            `${statusPrefix}: ${actualName} (net=${allowNetwork ? 'on' : 'off'})${resStr}`,
          ),
        ],
        { placement: 'belowEditor' },
      );
      ctx.ui.notify(
        `${statusPrefix}: podman ${actualName}${resStr}${sandbox.keep ? ' [persistent]' : ''}\n${ok}${skillMounts.length ? `\nSkills mounted: ${skillMounts.map(m => m.target).join(', ')}` : ''}${cacheVolume ? `\nCache volume: ${cacheVolume} at /cache` : ''}`,
        'info',
      );

      // ── Background version check ─────────────────────────────────────
      // Check registry for a newer image digest (non-blocking, fire & forget).
      // Only checks if:
      //   - not using a flag-override image (which takes priority)
      //   - the tag is not explicitly pinned in sandbox.json
      //   - at least 24 hours since last check (avoids hammering the registry)
      if (!flagImage && !projectConfig.pinned) {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const lastCheck = projectConfig.lastCheckedAt ?? 0;
        if (now - lastCheck >= oneDay) {
          // Fire-and-forget async check — never blocks session start
          (async () => {
            try {
              const tagInfo = await fetchTagDigest(projectConfig.image, projectConfig.tag);
              if (!tagInfo?.digest) return;

              // Update last-checked timestamp
              projectConfig.lastCheckedAt = now;
              if (projectConfig.lastDigest && projectConfig.lastDigest !== tagInfo.digest) {
                ctx.ui.notify(
                  `󰏗 New sandbox image available: ${imageRefForTag(projectConfig.image, projectConfig.tag)}\n` +
                    `  Last digest: ${projectConfig.lastDigest.slice(0, 19)}...\n` +
                    `  New digest:  ${tagInfo.digest.slice(0, 19)}...\n` +
                    `  Run \`/sandbox update\` to pull the update.`,
                  'info',
                );
              } else if (!projectConfig.lastDigest && tagInfo.digest) {
                // First check — store the digest for future comparison
                projectConfig.lastDigest = tagInfo.digest;
              }
              projectConfig.lastCheckedAt = Date.now();
              saveSandboxProjectConfig(localCwd, projectConfig);
            } catch {
              // Silently ignore — network may be unavailable
            }
          })();
        }
      }
    } catch (e) {
      sandbox = null;
      ctx.ui.notify(`Sandbox init failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  });

  pi.on('session_shutdown', async () => {
    const sbx = getSbx();
    if (!sbx) return;
    if (!sbx.keep) {
      sbx.runtime.stop(sbx.name);
      sbx.runtime.remove(sbx.name);
    }
    sandbox = null;
  });

  registerSandboxCommands(pi, localCwd, getSbx, pathApprovals);
}
