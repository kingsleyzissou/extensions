import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { isPathWithin, sandboxPathForHostPath, SANDBOX_WORKSPACE_ROOT } from './worktrees';
import type {
  BashOperations,
  EditOperations,
  ExtensionUIContext,
  ReadOperations,
  WriteOperations,
} from '@earendil-works/pi-coding-agent';
import { requestPathApproval, type PathApprovalStore } from './path-approvals';
import type { MountSpec, Sandbox } from './types';

// Path translation + safety
// ---------------------------------------------------------------------------

const REMOTE_ROOT = SANDBOX_WORKSPACE_ROOT;
export const SKILLS_ROOT = '/skills';

/** Return the container-side path if it falls under a known extra mount, otherwise null. */
function resolveExtraMountPath(containerPath: string, mounts: MountSpec[]): string | null {
  for (const m of mounts) {
    if (containerPath === m.target || containerPath.startsWith(`${m.target}/`)) {
      return containerPath;
    }
  }
  return null;
}

export function toRemote(hostPath: string, sbx: Sandbox): string {
  // Accept container-absolute paths because the system prompt shows /workspace.
  if (hostPath === REMOTE_ROOT || hostPath.startsWith(`${REMOTE_ROOT}/`)) {
    const remotePath = resolvePath(hostPath);
    if (isPathWithin(REMOTE_ROOT, remotePath)) return remotePath;
    throw new Error(
      `sandbox: refusing to access ${hostPath}: outside mounted workspace ${REMOTE_ROOT}`,
    );
  }
  // Also accept paths under any extra mount target (e.g. /skills/...).
  const resolvedMount = resolveExtraMountPath(hostPath, sbx.mounts);
  if (resolvedMount) return resolvedMount;

  const abs = resolvePath(sbx.hostCwd, hostPath);
  if (!isPathWithin(sbx.workspaceRoot, abs)) {
    throw new Error(
      `sandbox: refusing to access ${abs}: outside mounted workspace ${sbx.workspaceRoot}`,
    );
  }
  return sandboxPathForHostPath(sbx.workspaceRoot, abs);
}

/**
 * Check whether a container-side path falls under an extra (read-only) mount.
 * Used to reject write/edit operations against skill directories.
 */
function isReadOnlyMount(containerPath: string, mounts: MountSpec[]): boolean {
  for (const m of mounts) {
    if (containerPath === m.target || containerPath.startsWith(`${m.target}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Check whether an external host path is allowed for read access.
 * Default: pi clipboard temp files (basename starts with "pi-clipboard-").
 * Additional prefixes can be added via --container-allow-paths or /sandbox allow.
 */
export function isAllowedExternalResource(hostPath: string, allowedPrefixes: string[]): boolean {
  const abs = resolvePath(hostPath);
  // Default: pi clipboard files
  const basename = abs.split('/').pop() || '';
  if (basename.startsWith('pi-clipboard-')) return true;
  // User-configured prefixes
  for (const prefix of allowedPrefixes) {
    if (abs === prefix || abs.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/** Check whether a tool path resolves inside the shared workspace mount. */
function isInsideWorkspace(hostPath: string, hostCwd: string, workspaceRoot: string): boolean {
  if (hostPath === REMOTE_ROOT || hostPath.startsWith(`${REMOTE_ROOT}/`)) return true;
  return isPathWithin(workspaceRoot, resolvePath(hostCwd, hostPath));
}

export function shq(s: string): string {
  // POSIX single-quote: ' -> '\''
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Container exec helpers
// ---------------------------------------------------------------------------

export function execArgv(sbx: Sandbox, argv: string[], timeoutMs?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(sbx.runtime.bin, ['exec', sbx.name, ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : undefined;

    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`exec timed out after ${timeoutMs}ms: ${argv.join(' ')}`));
      } else if (code !== 0) {
        reject(new Error(`exec failed (${code}): ${Buffer.concat(err).toString()}`));
      } else {
        resolve(Buffer.concat(out));
      }
    });
  });
}

export function execCapture(sbx: Sandbox, command: string, timeoutMs?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(sbx.runtime.bin, ['exec', sbx.name, 'sh', '-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : undefined;

    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`exec timed out after ${timeoutMs}ms: ${command}`));
      } else if (code !== 0) {
        reject(new Error(`exec failed (${code}): ${Buffer.concat(err).toString()}`));
      } else {
        resolve(Buffer.concat(out));
      }
    });
  });
}

function execStream(
  sbx: Sandbox,
  command: string,
  {
    onData,
    signal,
    timeout,
  }: { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number },
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(sbx.runtime.bin, ['exec', sbx.name, 'sh', '-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeout * 1000)
      : undefined;
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new Error('aborted'));
      else if (timedOut) reject(new Error(`timeout:${timeout}`));
      else resolve({ exitCode: code });
    });
  });
}

// ---------------------------------------------------------------------------
// Operations adapters (one per built-in tool)
// ---------------------------------------------------------------------------

export function readOps(sbx: Sandbox): ReadOperations {
  const resolveAbs = (p: string) => resolvePath(sbx.hostCwd, p);
  const tryExternal = (p: string): { external: true; abs: string } | { external: false } => {
    if (isInsideWorkspace(p, sbx.hostCwd, sbx.workspaceRoot)) return { external: false };
    const abs = resolveAbs(p);
    return isAllowedExternalResource(abs, sbx.allowedExternalPrefixes)
      ? { external: true, abs }
      : { external: false };
  };

  return {
    readFile: p => {
      const ext = tryExternal(p);
      if (ext.external) return Promise.resolve(readFileSync(ext.abs));
      return execCapture(sbx, `cat ${shq(toRemote(p, sbx))}`);
    },
    access: p => {
      const ext = tryExternal(p);
      if (ext.external) {
        try {
          statSync(ext.abs);
          return Promise.resolve();
        } catch (e) {
          return Promise.reject(e);
        }
      }
      return execCapture(sbx, `test -r ${shq(toRemote(p, sbx))}`).then(() => {});
    },
    detectImageMimeType: async p => {
      const ext = tryExternal(p);
      if (ext.external) {
        const ext2lower = ext.abs.split('.').pop()?.toLowerCase() || '';
        const map: Record<string, string> = {
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          gif: 'image/gif',
          webp: 'image/webp',
        };
        return map[ext2lower] || null;
      }
      try {
        const r = await execCapture(sbx, `file --mime-type -b ${shq(toRemote(p, sbx))}`);
        const m = r.toString().trim();
        return ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(m) ? m : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Check whether a host path is outside the mounted workspace and needs approval.
 * Returns the absolute external path, or null if it is inside the workspace or a known mount.
 */
export function getExternalPath(
  hostPath: string,
  hostCwd: string,
  workspaceRoot: string,
  mounts: MountSpec[],
): string | null {
  if (isInsideWorkspace(hostPath, hostCwd, workspaceRoot)) return null;
  const abs = resolvePath(hostCwd, hostPath);
  // Already covered by an extra mount (e.g. /skills)
  const containerPath = hostPath.startsWith('/') ? hostPath : abs;
  if (resolveExtraMountPath(containerPath, mounts)) return null;
  return abs;
}

/**
 * Ensure an external path is approved for read access.
 * Checks session allowlist, persisted store, then prompts interactively.
 * Throws if denied. On approval, adds path to session allowlist so readOps can use it.
 */
export async function ensureExternalReadApproved(
  absPath: string,
  sbx: Sandbox,
  store: PathApprovalStore,
  ui: ExtensionUIContext,
): Promise<void> {
  const approved = await requestPathApproval(absPath, sbx.allowedExternalPrefixes, store, ui);
  if (!approved) {
    throw new Error(`sandbox: access denied to ${absPath}`);
  }
}

export function writeOps(sbx: Sandbox): WriteOperations {
  return {
    writeFile: async (p, content) => {
      const remote = toRemote(p, sbx);
      if (isReadOnlyMount(remote, sbx.mounts)) {
        throw new Error(`sandbox: refusing to write to ${remote}: read-only skill mount`);
      }
      const buf = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
      const b64 = buf.toString('base64');
      await execCapture(sbx, `printf %s ${shq(b64)} | base64 -d > ${shq(remote)}`);
    },
    mkdir: async dir => {
      const remote = toRemote(dir, sbx);
      if (isReadOnlyMount(remote, sbx.mounts)) {
        throw new Error(`sandbox: refusing to mkdir in ${remote}: read-only skill mount`);
      }
      await execCapture(sbx, `mkdir -p ${shq(remote)}`);
    },
  };
}

export function editOps(sbx: Sandbox): EditOperations {
  const r = readOps(sbx);
  const w = writeOps(sbx);
  return {
    readFile: r.readFile,
    access: r.access,
    writeFile: async (p, content) => {
      const remote = toRemote(p, sbx);
      if (isReadOnlyMount(remote, sbx.mounts)) {
        throw new Error(`sandbox: refusing to edit ${remote}: read-only skill mount`);
      }
      return w.writeFile(p, content);
    },
  };
}

export function bashOps(sbx: Sandbox): BashOperations {
  return {
    exec: (command, _cwd, opts) => execStream(sbx, `cd ${shq(sbx.remoteCwd)} && ${command}`, opts),
  };
}

// ---------------------------------------------------------------------------
// Skill directory discovery
// ---------------------------------------------------------------------------

/**
 * Scan the host filesystem for agent skill directories and return mount specs.
 *
 * Looks under the following host directories (in order):
 *   - Any additional paths passed via --container-mount-skills (comma-separated)
 *   - $HOME/.agents/skills/
 *   - $HOME/.pi/agent/skills/
 *
 * Each immediate subdirectory that exists on disk becomes a read-only bind mount
 * at /skills/<name> inside the container.
 */
export function discoverSkillDirs(additionalPaths?: string[]): MountSpec[] {
  const home = homedir();
  const skillRoots = [
    ...(additionalPaths ?? []),
    resolvePath(home, '.agents', 'skills'),
    resolvePath(home, '.pi', 'agent', 'skills'),
  ];

  const mounts: MountSpec[] = [];

  for (const root of skillRoots) {
    if (!existsSync(root)) continue;
    try {
      const entries = readdirSync(root);
      for (const entry of entries) {
        const full = resolvePath(root, entry);
        try {
          const st = statSync(full);
          if (!st.isDirectory()) continue;
        } catch {
          continue;
        }
        // Avoid duplicate mount targets if the same skill name exists
        // under multiple roots — first one wins.
        const target = `${SKILLS_ROOT}/${entry}`;
        if (mounts.some(m => m.target === target)) continue;
        mounts.push({ source: full, target });
      }
    } catch {
      // Permission or I/O error — skip silently.
    }
  }

  return mounts;
}

// ---------------------------------------------------------------------------
