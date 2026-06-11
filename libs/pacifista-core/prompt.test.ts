import { describe, test, expect } from 'bun:test';
import { buildTaskPrompt } from './prompt.ts';
import type { Check, Plan, PlanTask } from './types.ts';

// ── Helpers ─────────────────────────────────────────────────────────────

function makePlan(overrides?: Partial<Plan>): Plan {
  return {
    title: 'Test Plan',
    context: 'Plan context here.',
    tasks: [],
    ...overrides,
  };
}

function makeTask(overrides?: Partial<PlanTask>): PlanTask {
  return {
    id: 1,
    title: 'Do the thing',
    body: 'Implement the thing.',
    fields: { acceptance: 'it works', files: 'foo.ts' },
    ...overrides,
  };
}

const CHECKS: Check[] = [
  { name: 'typecheck', command: 'bun run typecheck' },
  { name: 'lint', command: 'bun run lint:check' },
  { name: 'tests', command: 'bun test' },
];

// ── Tests ───────────────────────────────────────────────────────────────

describe('buildTaskPrompt – assertive check instructions', () => {
  test('contains assertive "Run ALL" language for checks', () => {
    const prompt = buildTaskPrompt(makePlan(), makeTask(), { checks: CHECKS });

    expect(prompt).toContain('Run ALL of the following checks');
  });

  test('contains "Do not finish until every check passes"', () => {
    const prompt = buildTaskPrompt(makePlan(), makeTask(), { checks: CHECKS });

    expect(prompt).toContain('Do not finish until every check passes');
  });

  test('check commands are listed with exact syntax', () => {
    const prompt = buildTaskPrompt(makePlan(), makeTask(), { checks: CHECKS });

    expect(prompt).toContain('`bun run typecheck`');
    expect(prompt).toContain('`bun run lint:check`');
    expect(prompt).toContain('`bun test`');
  });

  test('each check command is listed as a bullet item', () => {
    const prompt = buildTaskPrompt(makePlan(), makeTask(), { checks: CHECKS });

    expect(prompt).toContain('- **typecheck**: `bun run typecheck`');
    expect(prompt).toContain('- **lint**: `bun run lint:check`');
    expect(prompt).toContain('- **tests**: `bun test`');
  });

  test('instructs agent to fix failures and re-run', () => {
    const prompt = buildTaskPrompt(makePlan(), makeTask(), { checks: CHECKS });

    expect(prompt).toContain('If a check fails, fix the issue and re-run it');
  });
});

describe('buildTaskPrompt – revision feedback', () => {
  test('revision feedback appears under "## Revision Required" heading', () => {
    const feedback = 'typecheck: ✗ fail\nerror TS2345: Argument of type ...';
    const prompt = buildTaskPrompt(makePlan(), makeTask(), {
      checks: CHECKS,
      revision: feedback,
    });

    expect(prompt).toContain('## Revision Required');
    expect(prompt).toContain(feedback);
  });

  test('revision section includes context about previous attempt', () => {
    const feedback = 'tests failed';
    const prompt = buildTaskPrompt(makePlan(), makeTask(), {
      checks: CHECKS,
      revision: feedback,
    });

    expect(prompt).toContain('## Revision Required');
    expect(prompt).toContain('previous attempt');
  });
});

describe('buildTaskPrompt – TDD vs config tasks', () => {
  test('TDD task includes "Write tests first" step', () => {
    const prompt = buildTaskPrompt(makePlan(), makeTask(), { checks: CHECKS });

    expect(prompt).toContain('Write tests first');
  });

  test('config task (tdd: false) omits "Write tests first" step', () => {
    const task = makeTask({ fields: { tdd: 'false', acceptance: 'it works' } });
    const prompt = buildTaskPrompt(makePlan(), task, { checks: CHECKS });

    expect(prompt).not.toContain('Write tests first');
    expect(prompt).toContain('configuration / scaffolding task');
  });

  test('config task still has assertive check language', () => {
    const task = makeTask({ fields: { tdd: 'false', acceptance: 'it works' } });
    const prompt = buildTaskPrompt(makePlan(), task, { checks: CHECKS });

    expect(prompt).toContain('Run ALL of the following checks');
    expect(prompt).toContain('Do not finish until every check passes');
  });

  test('config task filters tdd-scoped checks', () => {
    const checks: Check[] = [
      { name: 'typecheck', command: 'bun run typecheck' },
      { name: 'tests', command: 'bun test', scope: 'tdd' },
    ];
    const task = makeTask({ fields: { tdd: 'false', acceptance: 'it works' } });
    const prompt = buildTaskPrompt(makePlan(), task, { checks });

    expect(prompt).toContain('`bun run typecheck`');
    expect(prompt).not.toContain('`bun test`');
  });
});

describe('buildTaskPrompt – no checks provided', () => {
  test('omits check instructions when no checks are provided', () => {
    const prompt = buildTaskPrompt(makePlan(), makeTask(), {});

    expect(prompt).not.toContain('Run ALL');
    expect(prompt).toContain('## Approach');
  });

  test('omits check instructions when checks array is empty', () => {
    const prompt = buildTaskPrompt(makePlan(), makeTask(), { checks: [] });

    expect(prompt).not.toContain('Run ALL');
  });
});
