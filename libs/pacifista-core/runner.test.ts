import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChecksResult, PacifistaEvent, GateAction, PlanTask, RunDeps } from './types.ts';
import type { GateHandler } from './runner.ts';
import { runPlan } from './runner.ts';

// ── Test helpers ────────────────────────────────────────────────────────

function makePassingChecks(): ChecksResult {
  return {
    passed: true,
    checks: [{ name: 'typecheck', status: 'pass' }],
  };
}

function makeFailingChecks(output?: string): ChecksResult {
  return {
    passed: false,
    checks: [
      {
        name: 'typecheck',
        status: 'fail',
        output: output ?? 'error TS2345: Argument of type ...',
      },
    ],
  };
}

const PLAN_CONTENT = `# Test Plan

Context for the plan.

## Tasks

### 1. Do the thing

Do the thing described here.

**acceptance**: it works
**files**: foo.ts
`;

describe('runner – auto-retry on check failure', () => {
  let workdir: string;
  let planPath: string;

  // Mocks
  let mockPiStream: ReturnType<typeof mock>;
  let mockRunChecks: ReturnType<typeof mock>;
  let mockGetHead: ReturnType<typeof mock>;
  let mockGetChangedFiles: ReturnType<typeof mock>;
  let mockStageAndCommit: ReturnType<typeof mock>;
  let mockGetJournalPath: ReturnType<typeof mock>;
  let mockJournalExists: ReturnType<typeof mock>;
  let mockAppendEvent: ReturnType<typeof mock>;
  let mockReplayState: ReturnType<typeof mock>;

  // Collected events + gate calls
  let events: PacifistaEvent[];
  let gateCalls: { task: PlanTask; attempt: number; checksResult: ChecksResult }[];
  let gateHandler: GateHandler;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'runner-test-'));
    planPath = join(workdir, 'plan.md');
    await writeFile(planPath, PLAN_CONTENT);

    events = [];
    gateCalls = [];

    // Default gate handler: always approve
    gateHandler = async (task, attempt, _changed, checksResult) => {
      gateCalls.push({ task, attempt, checksResult });
      return { action: 'approve' } as GateAction;
    };

    // Mock piStream — agent always "succeeds"
    mockPiStream = mock(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', sessionId: 'sess-1' }),
    );

    // Mock git operations
    mockGetHead = mock(() => Promise.resolve('abc123'));
    mockGetChangedFiles = mock(() => Promise.resolve(['foo.ts']));
    mockStageAndCommit = mock(() => Promise.resolve('def456'));

    // Mock state operations — we need a fresh "run state" per task
    const journalPath = join(workdir, 'journal.jsonl');
    let attemptCounter = 0;
    mockGetJournalPath = mock(() => Promise.resolve(journalPath));
    mockJournalExists = mock(() => Promise.resolve(false));
    mockAppendEvent = mock(() => Promise.resolve());
    mockReplayState = mock(() => {
      // Return a state that matches the plan
      return Promise.resolve({
        planPath,
        worktreePath: workdir,
        startedAt: new Date().toISOString(),
        currentTask: 1,
        tasks: [
          {
            id: 1,
            title: 'Do the thing',
            status: 'in_progress',
            attempts: Array.from({ length: attemptCounter }, () => ({
              startedAt: new Date().toISOString(),
            })),
          },
        ],
      });
    });

    // Override attempt counter on appendEvent for task:started events
    const origAppendEvent = mockAppendEvent;
    mockAppendEvent = mock(async (_path: string, event: { type: string }) => {
      if (event.type === 'task:started') {
        attemptCounter++;
      }
      return origAppendEvent(_path, event);
    });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  function makeDeps(): Partial<RunDeps> {
    return {
      piStream: mockPiStream as RunDeps['piStream'],
      runChecks: mockRunChecks as RunDeps['runChecks'],
      getHead: mockGetHead as RunDeps['getHead'],
      getChangedFiles: mockGetChangedFiles as RunDeps['getChangedFiles'],
      stageAndCommit: mockStageAndCommit as RunDeps['stageAndCommit'],
      getJournalPath: mockGetJournalPath as RunDeps['getJournalPath'],
      journalExists: mockJournalExists as RunDeps['journalExists'],
      appendEvent: mockAppendEvent as RunDeps['appendEvent'],
      replayState: mockReplayState as RunDeps['replayState'],
      runReviewStage: mock(() =>
        Promise.resolve({ reviewed: false, fixes: 0 }),
      ) as RunDeps['runReviewStage'],
    };
  }

  async function runWithMocks(options?: { maxAutoRetries?: number; maxAttempts?: number }) {
    return runPlan(
      {
        planPath,
        worktreePath: workdir,
        skipReview: true,
        maxAttempts: options?.maxAttempts ?? 5,
        maxAutoRetries: options?.maxAutoRetries,
        deps: makeDeps(),
      },
      event => events.push(event),
      gateHandler,
    );
  }

  test('checks pass on first attempt → gate called, no auto-retry', async () => {
    mockRunChecks = mock(() => Promise.resolve(makePassingChecks()));

    await runWithMocks({ maxAutoRetries: 2 });

    // Gate should be called exactly once
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0]!.checksResult.passed).toBe(true);

    // No auto-retry events
    const autoRetryEvents = events.filter(e => e.type === 'checks:auto-retry');
    expect(autoRetryEvents).toHaveLength(0);

    // piStream should be called once (no retries)
    expect(mockPiStream).toHaveBeenCalledTimes(1);
  });

  test('checks fail then pass on auto-retry → gate called with passing checks', async () => {
    let checkCallCount = 0;
    mockRunChecks = mock(() => {
      checkCallCount++;
      if (checkCallCount === 1) {
        return Promise.resolve(makeFailingChecks());
      }
      return Promise.resolve(makePassingChecks());
    });

    await runWithMocks({ maxAutoRetries: 2 });

    // Agent should run twice (initial + 1 auto-retry)
    expect(mockPiStream).toHaveBeenCalledTimes(2);

    // Gate should be called once, with passing checks
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0]!.checksResult.passed).toBe(true);

    // Should have emitted an auto-retry event
    const autoRetryEvents = events.filter(e => e.type === 'checks:auto-retry');
    expect(autoRetryEvents).toHaveLength(1);
    const evt = autoRetryEvents[0] as PacifistaEvent & { type: 'checks:auto-retry' };
    expect(evt.retriesRemaining).toBe(1);
  });

  test('checks fail, all auto-retries exhausted → gate called with failing checks', async () => {
    mockRunChecks = mock(() => Promise.resolve(makeFailingChecks()));

    await runWithMocks({ maxAutoRetries: 2 });

    // Agent should run 3 times (initial + 2 auto-retries)
    expect(mockPiStream).toHaveBeenCalledTimes(3);

    // Gate should be called once, with failing checks
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0]!.checksResult.passed).toBe(false);

    // Should have emitted 2 auto-retry events
    const autoRetryEvents = events.filter(e => e.type === 'checks:auto-retry');
    expect(autoRetryEvents).toHaveLength(2);
  });

  test('maxAutoRetries: 0 → no auto-retry, gate always called (backwards compatible)', async () => {
    mockRunChecks = mock(() => Promise.resolve(makeFailingChecks()));

    await runWithMocks({ maxAutoRetries: 0 });

    // Agent should run once
    expect(mockPiStream).toHaveBeenCalledTimes(1);

    // Gate should be called with failing checks
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0]!.checksResult.passed).toBe(false);

    // No auto-retry events
    const autoRetryEvents = events.filter(e => e.type === 'checks:auto-retry');
    expect(autoRetryEvents).toHaveLength(0);
  });
});
