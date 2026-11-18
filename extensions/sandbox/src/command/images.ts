import { existsSync } from 'node:fs';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_SANDBOX_PROJECT_CONFIG,
  fetchTagDigest,
  getSandboxConfigPath,
  imageRefForTag,
  inspectLocalImageDigest,
  loadSandboxProjectConfig,
  saveSandboxProjectConfig,
} from '../config';
import { detectRuntime, randomSuffix } from '../runtime';
import type { SandboxCommandDependencies } from './context';

export async function cmdSandboxInstall(
  deps: SandboxCommandDependencies,
  _subArgs: string,
  ctx: { ui: ExtensionUIContext },
) {
  const hostCwd = deps.localCwd;
  const cfg = loadSandboxProjectConfig(hostCwd);
  const imageRef = imageRefForTag(cfg.image, cfg.tag);

  const runtime = await detectRuntime();
  if (!runtime) {
    ctx.ui.notify(
      process.platform === 'darwin'
        ? 'Apple Container is unavailable. Start it with `container system start`.'
        : 'Podman is unavailable or not responding.',
      'error',
    );
    return;
  }

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
  const pulled = await runtime.pullImage(imageRef, 180000);
  if (!pulled) {
    ctx.ui.notify(
      `${ctx.ui.theme.fg('error', '×')} Failed to pull ${imageRef}.\n` +
        `   Check runtime connectivity or build manually:\n` +
        `   ${runtime.kind === 'apple' ? 'container' : 'podman'} build -t ${imageRef} -f containers/Containerfile containers`,
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
  const smoke = await runtime.smokeTest(testName, imageRef, 15000);
  if (smoke !== null) {
    ctx.ui.notify(
      `${ctx.ui.theme.fg('success', '✓')} Installed: ${imageRef}\n` +
        `   Digest: ${tagInfo?.digest?.slice(0, 19) ?? 'unknown'}...\n` +
        `   Smoke test: ${smoke}\n` +
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

export async function cmdSandboxUpdate(
  deps: SandboxCommandDependencies,
  _subArgs: string,
  ctx: { ui: ExtensionUIContext },
) {
  const sbx = deps.getSbx();
  if (!sbx) {
    ctx.ui.notify('Sandbox is not active.', 'info');
    return;
  }
  const hostCwd = sbx.hostCwd;
  const cfg = loadSandboxProjectConfig(hostCwd);
  const imageRef = imageRefForTag(cfg.image, cfg.tag);

  ctx.ui.notify(`↓ Pulling ${imageRef}...`);
  const pulled = await sbx.runtime.pullImage(imageRef, 120000);
  if (!pulled) {
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

export async function cmdSandboxConfig(
  deps: SandboxCommandDependencies,
  _subArgs: string,
  ctx: { ui: ExtensionUIContext },
) {
  const sbx = deps.getSbx();
  const hostCwd = sbx?.hostCwd ?? deps.localCwd;
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

export async function cmdSandboxPin(
  deps: SandboxCommandDependencies,
  tag: string,
  ctx: { ui: ExtensionUIContext },
) {
  if (!tag) {
    ctx.ui.notify('Usage: /sandbox pin <tag>\n  e.g. /sandbox pin v1.0.0', 'info');
    return;
  }
  const hostCwd = deps.getSbx()?.hostCwd ?? deps.localCwd;
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

export async function cmdSandboxUnpin(
  deps: SandboxCommandDependencies,
  _subArgs: string,
  ctx: { ui: ExtensionUIContext },
) {
  const hostCwd = deps.getSbx()?.hostCwd ?? deps.localCwd;
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
