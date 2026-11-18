import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { isPathWithin, listSandboxWorktrees, sandboxPathForHostPath } from './worktrees';
import type { ExtensionAPI, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_SANDBOX_PROJECT_CONFIG,
  fetchTagDigest,
  getSandboxConfigPath,
  imageRefForTag,
  inspectLocalImageDigest,
  loadSandboxProjectConfig,
  saveSandboxProjectConfig,
} from './config';
import type { PathApprovalStore } from './path-approvals';
import type { Sandbox } from './types';
import { execCapture } from './operations';
import { podmanRuntime, randomSuffix, spawnWithTimeout } from './runtime';

export function registerSandboxCommands(
  pi: ExtensionAPI,
  localCwd: string,
  getSbx: () => Sandbox | null,
  pathApprovals: PathApprovalStore | null,
): void {
  // ── Shared subcommand handlers ────────────────────────────────────────

  async function cmdSandboxStatus(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
    const sbx = getSbx();
    if (!sbx) {
      const cfg = loadSandboxProjectConfig(localCwd);
      ctx.ui.notify(
        `Sandbox is not active. Start pi with --container.\nconfigured image: ${imageRefForTag(cfg.image, cfg.tag)} (${cfg.pinned ? 'pinned' : 'unpinned'})`,
        'info',
      );
      return;
    }
    const info = (await execCapture(sbx, 'id; uname -a; df -h /workspace | tail -1')).toString();
    const localDigest = await inspectLocalImageDigest(sbx.runtime, sbx.imageRef);
    const resParts: string[] = [];
    if (sbx.resources?.memory) resParts.push(`memory: ${sbx.resources.memory}`);
    if (sbx.resources?.cpus) resParts.push(`cpus: ${sbx.resources.cpus}`);
    if (sbx.resources?.disk) resParts.push(`disk: ${sbx.resources.disk}`);
    if (sbx.resources?.swap !== undefined) resParts.push(`swap: ${sbx.resources.swap}`);
    if (sbx.resources?.pidsLimit !== undefined)
      resParts.push(`pids-limit: ${sbx.resources.pidsLimit}`);
    const resStr = resParts.length ? `\nresources: ${resParts.join(', ')}` : '';
    const reusableStr = sbx.keep ? ` [persistent${sbx.isReattached ? ', reattached' : ''}]` : '';
    const cfg = sbx.projectConfig;
    ctx.ui.notify(
      [
        `Sandbox: ${sbx.runtime.kind} container ${sbx.name}${reusableStr}`,
        `workspace root: ${sbx.workspaceRoot}`,
        `active cwd: ${sbx.hostCwd} (${sbx.remoteCwd})`,
        `image: ${sbx.imageRef} (${cfg.pinned ? 'pinned' : 'unpinned'})`,
        `local digest: ${localDigest ?? 'unknown'}`,
        `last seen remote digest: ${cfg.lastDigest ?? 'unknown'}`,
        `last update check: ${cfg.lastCheckedAt ? new Date(cfg.lastCheckedAt).toISOString() : 'never'}`,
        `update: run /sandbox update, then restart pi to use the new image`,
        resStr.trim(),
        info.trimEnd(),
      ]
        .filter(Boolean)
        .join('\n'),
      'info',
    );
  }

  async function cmdSandboxWorktree(raw: string, ctx: { ui: ExtensionUIContext }) {
    const sbx = getSbx();
    if (!sbx) {
      ctx.ui.notify('Sandbox is not active.', 'info');
      return;
    }
    if (!sbx.isBareRepo) {
      ctx.ui.notify('Worktree switching is available for bare-repo workspaces only.', 'warning');
      return;
    }

    const worktrees = listSandboxWorktrees(sbx.workspaceRoot);
    const current = worktrees.find(worktree => isPathWithin(worktree.path, sbx.hostCwd));
    if (!raw.trim()) {
      if (worktrees.length === 0) {
        ctx.ui.notify('No Git worktrees found in this repository.', 'info');
        return;
      }
      const lines = worktrees.map(worktree => {
        const active = worktree.name === current?.name ? '*' : ' ';
        const branch = worktree.branch ?? 'detached';
        return `${active} ${worktree.name} (${branch}) — ${sandboxPathForHostPath(sbx.workspaceRoot, worktree.path)}`;
      });
      ctx.ui.notify(`Worktrees (* = active):\n${lines.join('\n')}`, 'info');
      return;
    }

    const selected = worktrees.find(worktree => worktree.name === raw.trim());
    if (!selected) {
      ctx.ui.notify(
        `Unknown worktree: ${raw.trim()}\nAvailable: ${worktrees.map(worktree => worktree.name).join(', ') || '(none)'}`,
        'warning',
      );
      return;
    }

    sbx.hostCwd = selected.path;
    sbx.remoteCwd = sandboxPathForHostPath(sbx.workspaceRoot, selected.path);
    ctx.ui.notify(`Active worktree: ${selected.name} (${sbx.remoteCwd})`, 'info');
  }

  async function cmdSandboxAllow(raw: string, ctx: { ui: ExtensionUIContext }) {
    const sbx = getSbx();
    if (!sbx) {
      ctx.ui.notify('Sandbox is not active.', 'info');
      return;
    }
    if (!raw) {
      ctx.ui.notify(
        'Usage: /sandbox allow <host-path>\nAdds a host path prefix for read access from the sandbox.',
        'info',
      );
      return;
    }
    const abs = raw.startsWith('~') ? resolvePath(homedir(), raw.slice(1)) : resolvePath(raw);
    if (sbx.allowedExternalPrefixes.includes(abs)) {
      ctx.ui.notify(`Path ${abs} is already allowed.`, 'info');
      return;
    }
    if (!existsSync(abs)) {
      ctx.ui.notify(`Path ${abs} does not exist on host.`, 'warning');
      return;
    }
    sbx.allowedExternalPrefixes.push(abs);
    ctx.ui.notify(`Sandbox: read access now allowed for ${abs}`, 'info');
  }

  async function cmdSandboxPathsList(ctx: { ui: ExtensionUIContext }) {
    const store = pathApprovals;
    if (!store) {
      ctx.ui.notify('Path approval store not initialized.', 'info');
      return;
    }
    const records = store.list();
    if (records.length === 0) {
      ctx.ui.notify(
        'No persisted path approvals. External reads will prompt interactively.',
        'info',
      );
      return;
    }
    const lines = records.map(r => {
      const expiry =
        r.expiresAt === Infinity ? 'always' : `expires ${new Date(r.expiresAt).toISOString()}`;
      return `  ${r.path} (${expiry})`;
    });
    ctx.ui.notify(
      [
        `Persisted path approvals (${records.length}):`,
        ...lines,
        '',
        'Use /sandbox paths revoke <path> to revoke an approval.',
      ].join('\n'),
      'info',
    );
  }

  async function cmdSandboxPathsRevoke(target: string, ctx: { ui: ExtensionUIContext }) {
    const store = pathApprovals;
    if (!store) {
      ctx.ui.notify('Path approval store not initialized.', 'info');
      return;
    }
    if (!target) {
      ctx.ui.notify('Usage: /sandbox paths revoke <path>', 'info');
      return;
    }
    const abs = target.startsWith('~')
      ? resolvePath(homedir(), target.slice(1))
      : resolvePath(target);
    if (store.revoke(abs)) {
      ctx.ui.notify(`Revoked path approval: ${abs}`, 'info');
    } else {
      ctx.ui.notify(`No approval found for: ${abs}`, 'warning');
    }
  }

  async function cmdSandboxInstall(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
    const hostCwd = localCwd;
    const cfg = loadSandboxProjectConfig(hostCwd);
    const imageRef = imageRefForTag(cfg.image, cfg.tag);

    // Detect runtime (Podman) — works without an active sandbox container
    const runtime = podmanRuntime();

    // 1. Check if image already exists locally
    const localDigest = await inspectLocalImageDigest(runtime, imageRef);
    if (localDigest) {
      ctx.ui.notify(
        `${ctx.ui.theme.fg('success', '✓')} Already installed: ${imageRef}\n` +
          `   Digest: ${localDigest.slice(0, 19)}...\n` +
          `   Run \`pi -e ./index.ts\` to start the sandbox.`,
        'info',
      );
      return;
    }

    // 2. Pull the image
    ctx.ui.notify(`↓ Installing sandbox image: ${imageRef}...`);
    const pull = await spawnWithTimeout(runtime.bin, ['pull', imageRef], 180000);
    if (pull.code !== 0 || pull.timedOut) {
      ctx.ui.notify(
        `${ctx.ui.theme.fg('error', '×')} Failed to pull ${imageRef}.\n` +
          `   Check Podman connectivity or build manually:\n` +
          `   podman build -t ${imageRef} -f containers/Containerfile containers`,
        'error',
      );
      return;
    }

    // 3. Record the digest
    const tagInfo = await fetchTagDigest(cfg.image, cfg.tag);
    if (tagInfo?.digest) {
      cfg.lastDigest = tagInfo.digest;
    }
    cfg.lastCheckedAt = Date.now();
    saveSandboxProjectConfig(hostCwd, cfg);

    // 4. Quick smoke test — run a throwaway container to verify the image works
    const testName = `pi-install-test-${randomSuffix()}`;
    const smoke = await spawnWithTimeout(
      runtime.bin,
      ['run', '--rm', '--name', testName, imageRef, 'sh', '-c', 'id -un && pwd'],
      15000,
    );
    if (smoke.code === 0 && !smoke.timedOut) {
      ctx.ui.notify(
        `${ctx.ui.theme.fg('success', '✓')} Installed: ${imageRef}\n` +
          `   Digest: ${tagInfo?.digest?.slice(0, 19) ?? 'unknown'}...\n` +
          `   Smoke test: ${smoke.stdout.trim()}\n` +
          `   Run \`pi -e ./index.ts\` to start using the sandbox.`,
        'info',
      );
    } else {
      ctx.ui.notify(
        `${ctx.ui.theme.fg('warning', '⚠')} Installed ${imageRef} but smoke test failed.\n` +
          `   The image may be incomplete. Try /sandbox update or build manually.`,
        'warning',
      );
    }
  }

  async function cmdSandboxUpdate(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
    const sbx = getSbx();
    if (!sbx) {
      ctx.ui.notify('Sandbox is not active.', 'info');
      return;
    }
    const hostCwd = sbx.hostCwd;
    const cfg = loadSandboxProjectConfig(hostCwd);
    const imageRef = imageRefForTag(cfg.image, cfg.tag);

    ctx.ui.notify(`↓ Pulling ${imageRef}...`);
    const pull = await spawnWithTimeout(sbx.runtime.bin, ['pull', imageRef], 120000);
    if (pull.code !== 0 || pull.timedOut) {
      ctx.ui.notify(`${ctx.ui.theme.fg('error', '×')} Failed to pull ${imageRef}.`, 'error');
      return;
    }

    // Record the new digest
    const tagInfo = await fetchTagDigest(cfg.image, cfg.tag);
    if (tagInfo?.digest) {
      cfg.lastDigest = tagInfo.digest;
    }
    cfg.lastCheckedAt = Date.now();
    saveSandboxProjectConfig(hostCwd, cfg);

    ctx.ui.notify(
      `${ctx.ui.theme.fg('success', '✓')} Updated sandbox image: ${imageRef}\n` +
        `   Restart pi (exit and re-run) to use the new image.`,
      'info',
    );
  }

  async function cmdSandboxDoctor(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
    const sbx = getSbx();
    if (!sbx) {
      ctx.ui.notify('Sandbox is not active. Start pi with --container.', 'info');
      return;
    }
    const script = [
      'set -u',
      'for cmd in sh bash git rg fd bat eza jq yq ast-grep uv python python3 bun bunx node npm chromium; do',
      "  if command -v $cmd >/dev/null 2>&1; then printf 'ok   %s -> %s\\n' $cmd $(command -v $cmd); else printf 'MISS %s\\n' $cmd; fi",
      'done',
      'echo',
      "bun --version 2>&1 | sed 's/^/bun: /'",
      "node --version 2>&1 | sed 's/^/node: /'",
      "npm --version 2>&1 | sed 's/^/npm: /'",
      "python --version 2>&1 | sed 's/^/python: /'",
      "uv --version 2>&1 | sed 's/^/uv: /'",
      "chromium --version 2>&1 | sed 's/^/chromium: /'",
      'echo',
      "ldd $(command -v node) | sed 's/^/node ldd: /'",
    ].join('\n');
    const out = (await execCapture(sbx, script, 20000)).toString();
    ctx.ui.notify(`Sandbox doctor:\n${out}`, 'info');
  }

  async function cmdSandboxConfig(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
    const sbx = getSbx();
    const hostCwd = sbx?.hostCwd ?? localCwd;
    const cfg = loadSandboxProjectConfig(hostCwd);
    const imageRef = imageRefForTag(cfg.image, cfg.tag);
    const lines: string[] = [
      `󰒓 Sandbox project config (.pi/agent/sandbox.json):`,
      `  Image:  ${imageRef}`,
      `  Pinned: ${cfg.pinned ? 'yes' : 'no'}`,
      `  Git:    ${cfg.git ? `${cfg.git.user.name} <${cfg.git.user.email}>` : 'auto-detected from host'}`,
      `  Last digest: ${cfg.lastDigest?.slice(0, 19) ?? '—'}...`,
      `  Last checked: ${cfg.lastCheckedAt ? new Date(cfg.lastCheckedAt).toISOString() : 'never'}`,
      ``,
      `Commands:`,
      `  /sandbox status        Show container status`,
      `  /sandbox allow <path>  Grant session read access to a host path`,
      `  /sandbox paths [revoke <path>]  List/revoke path approvals`,
      `  /sandbox worktree [name]  List or switch active Git worktree`,
      `  /sandbox doctor       Check core tools inside the container`,
      `  /sandbox install      Pull sandbox image (no running container needed)`,
      `  /sandbox update       Pull the latest image (requires active sandbox)`,
      `  /sandbox pin <tag>     Pin to a specific version tag (e.g. v1.0.0)`,
      `  /sandbox unpin         Unpin and follow the default tag again`,
    ];

    const configPath = getSandboxConfigPath(hostCwd);
    if (!existsSync(configPath)) {
      lines.push(`(no config file yet — will be created on first pin/update)`);
    }

    ctx.ui.notify(lines.join('\n'), 'info');
  }

  async function cmdSandboxPin(tag: string, ctx: { ui: ExtensionUIContext }) {
    if (!tag) {
      ctx.ui.notify('Usage: /sandbox pin <tag>\n  e.g. /sandbox pin v1.0.0', 'info');
      return;
    }
    const hostCwd = getSbx()?.hostCwd ?? localCwd;
    const cfg = loadSandboxProjectConfig(hostCwd);
    // If tag looks like a full image ref (contains a slash), extract just the tag part
    const cleanTag = tag.replace(/^.*?\//, '');
    cfg.tag = cleanTag;
    cfg.pinned = true;
    saveSandboxProjectConfig(hostCwd, cfg);
    ctx.ui.notify(
      `📌 Pinned sandbox image to ${imageRefForTag(cfg.image, cfg.tag)}\n` +
        `   Set ${getSandboxConfigPath(hostCwd)}`,
      'info',
    );
  }

  async function cmdSandboxUnpin(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
    const hostCwd = getSbx()?.hostCwd ?? localCwd;
    const cfg = loadSandboxProjectConfig(hostCwd);
    if (!cfg.pinned) {
      ctx.ui.notify('Sandbox image is not pinned. Nothing to unpin.', 'info');
      return;
    }
    cfg.tag = DEFAULT_SANDBOX_PROJECT_CONFIG.tag;
    cfg.pinned = false;
    saveSandboxProjectConfig(hostCwd, cfg);
    ctx.ui.notify(
      `🔓 Unpinned sandbox image — will follow tag "${cfg.tag}"\n` +
        `   Run \`/sandbox update\` to pull the latest.`,
      'info',
    );
  }

  // ── Main /sandbox command with subcommands ────────────────────────────

  pi.registerCommand('sandbox', {
    description:
      'Sandbox management. Subcommands: status, worktree, doctor, allow, paths, install, update, config, pin, unpin',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || 'status';

      switch (sub) {
        case 'status':
        case 'info':
          return cmdSandboxStatus(parts.slice(1).join(' '), ctx);
        case 'worktree':
        case 'worktrees':
          return cmdSandboxWorktree(parts.slice(1).join(' '), ctx);
        case 'doctor':
        case 'check':
          return cmdSandboxDoctor(parts.slice(1).join(' '), ctx);
        case 'allow':
          return cmdSandboxAllow(parts.slice(1).join(' '), ctx);
        case 'paths': {
          if (parts[1] === 'revoke' && parts[2]) {
            return cmdSandboxPathsRevoke(parts.slice(2).join(' '), ctx);
          }
          return cmdSandboxPathsList(ctx);
        }
        case 'install':
        case 'setup':
          return cmdSandboxInstall(parts.slice(1).join(' '), ctx);
        case 'update':
        case 'upgrade':
          return cmdSandboxUpdate(parts.slice(1).join(' '), ctx);
        case 'config':
        case 'settings':
          return cmdSandboxConfig(parts.slice(1).join(' '), ctx);
        case 'pin':
          return cmdSandboxPin(parts.slice(1).join(' '), ctx);
        case 'unpin':
          return cmdSandboxUnpin(parts.slice(1).join(' '), ctx);
        default:
          ctx.ui.notify(
            `Unknown subcommand: ${sub}\n` +
              `Available: status, worktree [name], doctor, allow, paths [revoke], install, update, config, pin, unpin`,
            'info',
          );
      }
    },
  });
}
