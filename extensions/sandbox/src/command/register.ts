import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { PathApprovalStore } from '../path-approvals';
import type { Sandbox } from '../types';
import { cmdSandboxAllow, cmdSandboxPathsList, cmdSandboxPathsRevoke } from './access';
import {
  cmdSandboxConfig,
  cmdSandboxInstall,
  cmdSandboxPin,
  cmdSandboxUnpin,
  cmdSandboxUpdate,
} from './images';
import { cmdSandboxDoctor, cmdSandboxStatus, cmdSandboxWorktree } from './workspace';
import type { SandboxCommandDependencies } from './context';

export function registerSandboxCommands(
  pi: ExtensionAPI,
  localCwd: string,
  getSbx: () => Sandbox | null,
  pathApprovals: PathApprovalStore | null,
): void {
  const deps: SandboxCommandDependencies = { localCwd, getSbx, pathApprovals };

  pi.registerCommand('sandbox', {
    description:
      'Sandbox management. Subcommands: status, worktree, doctor, allow, paths, install, update, config, pin, unpin',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || 'status';

      switch (sub) {
        case 'status':
        case 'info':
          return cmdSandboxStatus(deps, parts.slice(1).join(' '), ctx);
        case 'worktree':
        case 'worktrees':
          return cmdSandboxWorktree(deps, parts.slice(1).join(' '), ctx);
        case 'doctor':
        case 'check':
          return cmdSandboxDoctor(deps, parts.slice(1).join(' '), ctx);
        case 'allow':
          return cmdSandboxAllow(deps, parts.slice(1).join(' '), ctx);
        case 'paths': {
          if (parts[1] === 'revoke' && parts[2]) {
            return cmdSandboxPathsRevoke(deps, parts.slice(2).join(' '), ctx);
          }
          return cmdSandboxPathsList(deps, ctx);
        }
        case 'install':
        case 'setup':
          return cmdSandboxInstall(deps, parts.slice(1).join(' '), ctx);
        case 'update':
        case 'upgrade':
          return cmdSandboxUpdate(deps, parts.slice(1).join(' '), ctx);
        case 'config':
        case 'settings':
          return cmdSandboxConfig(deps, parts.slice(1).join(' '), ctx);
        case 'pin':
          return cmdSandboxPin(deps, parts.slice(1).join(' '), ctx);
        case 'unpin':
          return cmdSandboxUnpin(deps, parts.slice(1).join(' '), ctx);
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
