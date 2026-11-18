import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { SandboxCommandDependencies } from './context';

export async function cmdSandboxAllow(
  deps: SandboxCommandDependencies,
  raw: string,
  ctx: { ui: ExtensionUIContext },
) {
  const sbx = deps.getSbx();
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

export async function cmdSandboxPathsList(
  deps: SandboxCommandDependencies,
  ctx: { ui: ExtensionUIContext },
) {
  const store = deps.pathApprovals;
  if (!store) {
    ctx.ui.notify('Path approval store not initialized.', 'info');
    return;
  }
  const records = store.list();
  if (records.length === 0) {
    ctx.ui.notify('No persisted path approvals. External reads will prompt interactively.', 'info');
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

export async function cmdSandboxPathsRevoke(
  deps: SandboxCommandDependencies,
  target: string,
  ctx: { ui: ExtensionUIContext },
) {
  const store = deps.pathApprovals;
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
