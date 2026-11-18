import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { imageRefForTag, inspectLocalImageDigest, loadSandboxProjectConfig } from '../config';
import { execCapture } from '../operations';
import { isPathWithin, listSandboxWorktrees, sandboxPathForHostPath } from '../worktrees';
import type { SandboxCommandDependencies } from './context';

export async function cmdSandboxStatus(
  deps: SandboxCommandDependencies,
  _subArgs: string,
  ctx: { ui: ExtensionUIContext },
) {
  const sbx = deps.getSbx();
  if (!sbx) {
    const cfg = loadSandboxProjectConfig(deps.localCwd);
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
  if (sbx.runtime.kind === 'podman') {
    if (sbx.resources?.disk) resParts.push(`disk: ${sbx.resources.disk}`);
    if (sbx.resources?.swap !== undefined) resParts.push(`swap: ${sbx.resources.swap}`);
    if (sbx.resources?.pidsLimit !== undefined)
      resParts.push(`pids-limit: ${sbx.resources.pidsLimit}`);
  }
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

export async function cmdSandboxWorktree(
  deps: SandboxCommandDependencies,
  raw: string,
  ctx: { ui: ExtensionUIContext },
) {
  const sbx = deps.getSbx();
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

export async function cmdSandboxDoctor(
  deps: SandboxCommandDependencies,
  _subArgs: string,
  ctx: { ui: ExtensionUIContext },
) {
  const sbx = deps.getSbx();
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
