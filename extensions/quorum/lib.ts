import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ExecFn, ProjectType, ReviewerDef } from './types.ts';

// --- Constants ---

export const REVIEWERS: ReviewerDef[] = [
  // Shared (all project types)
  {
    name: 'security',
    label: 'Security',
    agentFile: 'shared/security.md',
    projectTypes: ['frontend', 'backend-ts', 'go'],
  },
  {
    name: 'qa',
    label: 'QA',
    agentFile: 'shared/qa.md',
    projectTypes: ['frontend', 'backend-ts', 'go'],
  },
  {
    name: 'performance',
    label: 'Performance',
    agentFile: 'shared/performance.md',
    projectTypes: ['frontend', 'backend-ts', 'go'],
  },
  {
    name: 'architecture',
    label: 'Architecture',
    agentFile: 'shared/architecture.md',
    projectTypes: ['frontend', 'backend-ts', 'go'],
  },

  // Backend (Go + TS lib)
  {
    name: 'api-design',
    label: 'API Design',
    agentFile: 'backend/api-design.md',
    projectTypes: ['backend-ts', 'go'],
  },

  // TypeScript (frontend + TS lib)
  {
    name: 'typescript',
    label: 'TypeScript',
    agentFile: 'typescript.md',
    projectTypes: ['frontend', 'backend-ts'],
  },

  // Go only
  {
    name: 'go',
    label: 'Go',
    agentFile: 'go.md',
    projectTypes: ['go'],
  },

  // Frontend only
  {
    name: 'react',
    label: 'React',
    agentFile: 'frontend/react.md',
    projectTypes: ['frontend'],
  },
  {
    name: 'ux',
    label: 'UI/UX',
    agentFile: 'frontend/ux.md',
    projectTypes: ['frontend'],
  },
];

export const REVIEWER_PROVIDER = 'vertex-anthropic';
export const REVIEWER_MODEL = 'claude-sonnet-4-6';
export const REVIEWER_TOOLS = ['read'];
export const MAX_CONCURRENCY = 4;

// --- Helpers ---

export function getPiInvocation(args: string[]): {
  command: string;
  args: string[];
} {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/');
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: 'pi', args };
}

export async function detectProjectType(cwd: string): Promise<ProjectType | null> {
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'go';

  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = pkg.dependencies ?? {};
      if ('react' in deps) return 'frontend';
      return 'backend-ts';
    } catch {
      return 'backend-ts';
    }
  }

  return null;
}

export function gitArgs(cwd: string, args: string[]): string[] {
  return ['-C', cwd, ...args];
}

export async function detectBaseBranch(exec: ExecFn, cwd: string): Promise<string | null> {
  const result = await exec('git', gitArgs(cwd, ['remote']), { timeout: 5000 });
  if (result.code !== 0) return null;

  const remotes = result.stdout.trim().split('\n');
  if (remotes.includes('upstream')) return 'upstream/main';
  if (remotes.includes('kingsley')) return 'kingsley/main';

  return null;
}

export async function isBareRepo(exec: ExecFn): Promise<boolean> {
  const result = await exec('git', ['rev-parse', '--is-bare-repository'], {
    timeout: 5000,
  });
  return result.code === 0 && result.stdout.trim() === 'true';
}

export async function listWorktrees(exec: ExecFn): Promise<{ path: string; branch: string }[]> {
  const result = await exec('git', ['worktree', 'list', '--porcelain'], {
    timeout: 5000,
  });
  if (result.code !== 0) return [];

  return parseWorktreePorcelain(result.stdout);
}

export function parseWorktreePorcelain(output: string): { path: string; branch: string }[] {
  const worktrees: { path: string; branch: string }[] = [];
  let currentPath = '';
  let currentBranch = '';

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice(9);
      currentBranch = '';
    } else if (line.startsWith('branch ')) {
      currentBranch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === '' && currentPath) {
      // Skip the bare repo entry (it won't have a branch)
      if (currentBranch) {
        worktrees.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = '';
      currentBranch = '';
    }
  }
  // Handle last entry if no trailing newline
  if (currentPath && currentBranch) {
    worktrees.push({ path: currentPath, branch: currentBranch });
  }

  return worktrees;
}

export async function runReviewer(
  cwd: string,
  agentPromptPath: string,
  task: string,
  signal?: AbortSignal,
  options?: { allowPaths?: string[] },
): Promise<{ output: string; exitCode: number; error?: string }> {
  const args = [
    '--mode',
    'json',
    '-p',
    '--no-session',
    '--noc',
    '--provider',
    REVIEWER_PROVIDER,
    '--model',
    REVIEWER_MODEL,
    '--tools',
    REVIEWER_TOOLS.join(','),
    '--append-system-prompt',
    agentPromptPath,
  ];

  // Allow the reviewer's sandbox to read external paths (e.g. temp dir with PR materials)
  if (options?.allowPaths?.length) {
    args.push('--container-allow-paths', options.allowPaths.join(','));
  }

  args.push(task);

  return new Promise(resolve => {
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let stderr = '';
    let lastAssistantText = '';

    proc.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'message_end' && event.message?.role === 'assistant') {
            for (const part of event.message.content) {
              if (part.type === 'text') lastAssistantText = part.text;
            }
          }
        } catch {
          // skip non-JSON lines
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number | null) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === 'message_end' && event.message?.role === 'assistant') {
            for (const part of event.message.content) {
              if (part.type === 'text') lastAssistantText = part.text;
            }
          }
        } catch {
          // ignore
        }
      }
      resolve({
        output: lastAssistantText,
        exitCode: code ?? 1,
        error: code !== 0 ? stderr.trim() || undefined : undefined,
      });
    });

    proc.on('error', (err: Error) => {
      resolve({ output: '', exitCode: 1, error: err.message });
    });

    if (signal) {
      const killProc = () => {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener('abort', killProc, { once: true });
    }
  });
}

export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (concurrency <= 0) {
    throw new Error(`runWithConcurrency: concurrency must be > 0, got ${concurrency}`);
  }
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional worker loop
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      await fn(items[current]!, current);
    }
  });
  await Promise.all(workers);
}
