#!/usr/bin/env bun
import { resolve, relative } from 'node:path';
import { readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as p from '@clack/prompts';
import {
  runPlan,
  parsePlan,
  getJournalPath,
  journalExists,
  replayState,
} from '@kingsleyzissou/pacifista-core';
import type { DeepPartial, PacifistaConfig } from '@kingsleyzissou/pacifista-core';
import { createEventRenderer } from './tui/events.ts';
import { presentGate } from './tui/gate.ts';
import { isBareRepo, isSandboxAvailable, listWorktrees, selectWorktree } from './tui/detect.ts';

// ── Arg parsing ─────────────────────────────────────────────────────────

const USAGE = `
kuma — plan executor with QC gates and user approval

Usage:
  kuma [execute] [<plan.md>] [-w <worktree>] [options]
  kuma resume [-w <worktree>]
  kuma status [-w <worktree>]
  kuma init [-w <worktree>]

Commands:
  execute   Execute a markdown plan file (default if omitted)
  resume    Resume a stopped run
  status    Show status of a run
  init      Initialize .kuma/ in a project

Options:
  -w, --worktree <path>     Path to the git worktree (auto-detected)
  --start-from <n>          Start from task N (default: 1)
  --no-commit               Don't instruct agent to commit per task
  --skip-review             Skip the ensemble review stage
  --sandbox                 Keep sandbox container alive between tasks
  --no-sandbox              Disable sandbox entirely (for debugging)
  -h, --help                Show this help message

If no command or plan file is provided, kuma runs an interactive wizard.
`;

type ParsedArgs = {
  command: string;
  planPath?: string;
  worktree?: string;
  startFrom?: number;
  commitPerTask: boolean;
  skipReview: boolean;
  sandbox: boolean;
  noSandbox: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }

  const result: ParsedArgs = {
    command: 'execute',
    commitPerTask: true,
    skipReview: false,
    sandbox: false,
    noSandbox: false,
  };

  let i = 0;

  // Check if first arg is a known command
  const commands = ['execute', 'resume', 'status', 'init'];
  if (args[0] && commands.includes(args[0])) {
    result.command = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i]!;

    switch (arg) {
      case '-w':
      case '--worktree':
        if (i + 1 >= args.length) {
          console.error('--worktree requires an argument');
          process.exit(1);
        }
        result.worktree = args[++i];
        break;
      case '--start-from':
        if (i + 1 >= args.length) {
          console.error('--start-from requires a numeric argument');
          process.exit(1);
        }
        result.startFrom = parseInt(args[++i]!, 10);
        if (Number.isNaN(result.startFrom) || result.startFrom < 1) {
          console.error('--start-from must be a positive integer (1-based task ID)');
          process.exit(1);
        }
        break;
      case '--no-commit':
        result.commitPerTask = false;
        break;
      case '--skip-review':
        result.skipReview = true;
        break;
      case '--sandbox':
        result.sandbox = true;
        break;
      case '--no-sandbox':
        result.noSandbox = true;
        break;
      default:
        if (!arg.startsWith('-') && !result.planPath) {
          result.planPath = arg;
        } else {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
    i++;
  }

  return result;
}

// ── Wizard ──────────────────────────────────────────────────────────────

/**
 * Find markdown files that look like plans.
 */
function findPlanFiles(dir: string): string[] {
  const plans: string[] = [];

  const scanDir = (d: string, prefix: string) => {
    try {
      const entries = readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory() && (entry.name === 'docs' || entry.name === 'plans')) {
          scanDir(`${d}/${entry.name}`, rel);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          plans.push(rel);
        }
      }
    } catch {
      // Permission error or similar
    }
  };

  // Scan docs/ and plans/ directories, plus top-level .md files
  scanDir(dir, '');
  return plans;
}

/**
 * Interactive wizard for the execute command.
 * Prompts for anything not provided on the command line.
 */
async function wizard(args: ParsedArgs): Promise<ParsedArgs> {
  p.intro('kuma');

  // 1. Resolve worktree
  if (!args.worktree) {
    const cwd = process.cwd();
    const bare = await isBareRepo(cwd);

    if (bare) {
      const worktrees = await listWorktrees(cwd);
      if (worktrees.length === 0) {
        p.log.error('Bare repo detected but no worktrees found.');
        process.exit(1);
      }

      const selected = await selectWorktree(worktrees);
      if (!selected) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      args.worktree = selected;
    }
  }

  // 2. Resolve plan file
  if (!args.planPath) {
    const searchDir = process.cwd();
    const plans = findPlanFiles(searchDir);

    if (plans.length > 0) {
      const selected = await p.select({
        message: 'Select a plan',
        options: plans.map(f => ({
          value: f,
          label: f,
        })),
      });

      if (p.isCancel(selected)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      args.planPath = selected;
    } else {
      const planPath = await p.text({
        message: 'Path to plan file',
        placeholder: 'docs/plans/my-plan.md',
        validate: v => {
          if (!v?.trim()) return 'Plan path is required';
        },
      });

      if (p.isCancel(planPath)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      args.planPath = String(planPath);
    }
  }

  // 3. Show plan preview
  const resolvedPlan = resolve(args.planPath);
  const wizardRoot = await getProjectRoot();
  assertSafePath(resolvedPlan, wizardRoot, 'planPath');
  const planFile = Bun.file(resolvedPlan);
  if (await planFile.exists()) {
    const plan = parsePlan(await planFile.text());
    const taskList = plan.tasks.map(t => `${t.id}. ${t.title}`).join('\n');
    p.note(taskList, plan.title);
  }

  // 4. Sandbox detection
  if (!args.sandbox && !args.noSandbox) {
    const hasSandbox = await isSandboxAvailable();
    if (hasSandbox) {
      const useSandbox = await p.select({
        message: 'Sandbox detected. How should agents run?',
        options: [
          {
            value: 'sandbox',
            label: 'Sandboxed',
            hint: 'agents run in a persistent container',
          },
          {
            value: 'no-sandbox',
            label: 'No sandbox',
            hint: 'agents run directly on host',
          },
        ],
      });

      if (p.isCancel(useSandbox)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }

      if (useSandbox === 'sandbox') {
        args.sandbox = true;
      } else {
        args.noSandbox = true;
      }
    }
  }

  // 5. Confirm
  const worktreeLabel = args.worktree ? args.worktree.split('/').pop() : 'cwd';
  const sandboxLabel = args.sandbox ? 'sandboxed' : args.noSandbox ? 'no sandbox' : 'default';

  const proceed = await p.confirm({
    message: `Execute ${args.planPath} in ${worktreeLabel} (${sandboxLabel})?`,
  });

  if (p.isCancel(proceed) || !proceed) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  return args;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the project root for path-safety checks.
 *
 * For bare repos the root is the parent of `git rev-parse --git-common-dir`
 * (e.g. `/repos/my-project`), which is the directory that contains both the
 * bare `.git` data and the sibling worktrees. For regular repos it falls back
 * to `git rev-parse --show-toplevel`, and finally to `cwd` if neither works.
 */
async function getProjectRoot(): Promise<string> {
  // Try bare-repo layout first — git-common-dir points at the bare repo itself
  const common = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], {
    cwd: resolve('.'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const commonDir = common.stdout.toString().trim();
  if (common.exitCode === 0 && commonDir && commonDir !== '.git') {
    // The bare repo root's parent is the project root
    return resolve(commonDir, '..');
  }

  // Regular repo
  const toplevel = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
    cwd: resolve('.'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (toplevel.exitCode === 0) {
    return toplevel.stdout.toString().trim();
  }

  return resolve('.');
}

/**
 * Assert that a resolved path is a descendant of (or equal to) the project root.
 * Prevents path traversal via user-supplied --worktree or planPath values.
 *
 * Anchors against the bare-repo root (or repo toplevel) so that sibling
 * worktrees — the canonical layout — are accepted.
 */
function assertSafePath(resolved: string, root: string, label: string): void {
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || resolve(root, rel) !== resolved) {
    console.error(`${label} escapes the project root: ${resolved}`);
    process.exit(1);
  }
}

async function resolveWorktree(explicit?: string): Promise<string> {
  const resolved = explicit ? resolve(explicit) : resolve('.');
  const root = await getProjectRoot();
  assertSafePath(resolved, root, '--worktree');
  return resolved;
}

function buildConfigOverrides(args: ParsedArgs): DeepPartial<PacifistaConfig> {
  return {
    pi: { sandbox: args.sandbox, noSandbox: args.noSandbox },
  };
}

// ── Commands ────────────────────────────────────────────────────────────

async function cmdExecute(args: ParsedArgs) {
  // Run wizard if plan path is missing or worktree needs detection
  const needsWizard = !args.planPath;
  if (needsWizard) {
    args = await wizard(args);
  } else {
    p.intro('kuma');

    // Still resolve worktree interactively if not provided
    if (!args.worktree) {
      const cwd = process.cwd();
      const bare = await isBareRepo(cwd);
      if (bare) {
        const worktrees = await listWorktrees(cwd);
        if (worktrees.length > 0) {
          const selected = await selectWorktree(worktrees);
          if (!selected) {
            p.cancel('No worktree selected.');
            process.exit(0);
          }
          args.worktree = selected;
        }
      }
    }
  }

  const worktree = await resolveWorktree(args.worktree);
  const planPath = resolve(args.planPath!);
  const projectRoot = await getProjectRoot();
  assertSafePath(planPath, projectRoot, 'planPath');
  const { handler, stopSpinner } = createEventRenderer();

  try {
    const result = await runPlan(
      {
        planPath,
        worktreePath: worktree,
        startFromTask: args.startFrom,
        commitPerTask: args.commitPerTask,
        skipReview: args.skipReview,
        configOverrides: buildConfigOverrides(args),
      },
      handler,
      presentGate,
    );

    p.outro(
      result.completed === result.total
        ? 'All tasks completed!'
        : `${result.completed}/${result.total} tasks completed`,
    );

    process.exit(result.completed === result.total ? 0 : 1);
  } catch (err) {
    stopSpinner();
    p.log.error(`Execution failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function cmdResume(args: ParsedArgs) {
  const worktree = await resolveWorktree(args.worktree);
  const journalPath = await getJournalPath(worktree);

  if (!(await journalExists(journalPath))) {
    p.log.error(`No journal found at ${journalPath}`);
    process.exit(1);
  }

  const state = await replayState(journalPath);
  const { handler, stopSpinner } = createEventRenderer();

  p.intro('kuma — resuming');

  try {
    const result = await runPlan(
      {
        planPath: resolve(state.planPath),
        worktreePath: resolve(state.worktreePath),
        startFromTask: state.currentTask,
        commitPerTask: args.commitPerTask,
        skipReview: args.skipReview,
        configOverrides: buildConfigOverrides(args),
      },
      handler,
      presentGate,
    );

    p.outro(
      result.completed === result.total
        ? 'All tasks completed!'
        : `${result.completed}/${result.total} tasks completed`,
    );

    process.exit(result.completed === result.total ? 0 : 1);
  } catch (err) {
    stopSpinner();
    p.log.error(`Resume failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function cmdStatus(args: ParsedArgs) {
  const worktree = await resolveWorktree(args.worktree);
  const journalPath = await getJournalPath(worktree);

  if (!(await journalExists(journalPath))) {
    p.log.info('No active run.');
    return;
  }

  const state = await replayState(journalPath);

  p.intro('kuma — status');
  p.log.info(`Plan: ${state.planPath}`);
  p.log.info(`Started: ${state.startedAt}`);
  p.log.info(`Current task: ${state.currentTask}`);

  const lines = state.tasks.map(task => {
    const icon =
      task.status === 'approved'
        ? '✓'
        : task.status === 'rejected'
          ? '✗'
          : task.status === 'skipped'
            ? '○'
            : task.status === 'in_progress'
              ? '▶'
              : '·';
    const attempts = task.attempts.length > 0 ? ` (${task.attempts.length} attempts)` : '';
    return `${icon} Task ${task.id}: ${task.title} [${task.status}]${attempts}`;
  });

  p.note(lines.join('\n'), 'Tasks');
  p.outro('');
}

async function cmdInit(args: ParsedArgs) {
  const worktree = resolve(args.worktree ?? '.');
  const kumaDir = `${worktree}/.kuma`;

  await mkdir(kumaDir, { recursive: true });

  const configPath = `${kumaDir}/config.js`;
  const configFile = Bun.file(configPath);

  if (await configFile.exists()) {
    p.log.warn(`.kuma/config.js already exists in ${worktree}`);
    return;
  }

  await Bun.write(
    configPath,
    `export default {
  checks: [
    { name: 'typecheck', command: 'bun run typecheck' },
    { name: 'lint', command: 'bun run lint' },
    { name: 'tests', command: 'bun test' },
  ],

  pi: {
    sandbox: false,
  },

  hooks: {
    // beforeRun: async (ctx) => { await ctx.exec('npm ci'); },
    // beforeTask: async (task, ctx) => {},
    // afterTask: async (task, result, ctx) => {},
    // beforeChecks: async (task, ctx) => {},
    // onApprove: async (task, ctx) => {},
  },

  prompt: {
    // preamble: '',
    // rules: [],
  },

  review: {
    enabled: true,
    // baseBranch: 'main',
    // reviewsDir: 'docs/reviews',
  },

  gate: {
    autoApprove: false,
  },
}
`,
  );

  p.log.success(`Initialized .kuma/ in ${worktree}`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case 'execute':
      await cmdExecute(args);
      break;
    case 'resume':
      await cmdResume(args);
      break;
    case 'status':
      await cmdStatus(args);
      break;
    case 'init':
      await cmdInit(args);
      break;
    default:
      // Unknown first arg — treat as plan path
      if (args.command && !args.command.startsWith('-')) {
        args.planPath = args.command;
        args.command = 'execute';
        await cmdExecute(args);
      } else {
        console.error(`Unknown command: ${args.command}`);
        console.log(USAGE);
        process.exit(1);
      }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
