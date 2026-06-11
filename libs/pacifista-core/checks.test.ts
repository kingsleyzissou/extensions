import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { runChecks } from './checks.ts';
import type { Check } from './types.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FIXTURES = join(import.meta.dir, 'test-fixtures');

describe('runChecks – flaky check retries', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'checks-test-'));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  test('non-flaky check fails → not retried, reported as failed', async () => {
    const checks: Check[] = [{ name: 'typecheck', command: 'node -e "process.exitCode=1"' }];

    const result = await runChecks(workdir, checks, 'task');

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.status).toBe('fail');
    expect(result.checks[0]!.flaky).toBeUndefined();
  });

  test('flaky check fails then passes on retry → reported as passed', async () => {
    const marker = join(workdir, '.flaky-state');
    const checks: Check[] = [
      {
        name: 'flaky-test',
        command: `node ${join(FIXTURES, 'flaky.cjs')} ${marker}`,
        flaky: true,
        retries: 2,
      },
    ];

    const result = await runChecks(workdir, checks, 'task');

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.status).toBe('pass');
    expect(result.checks[0]!.flaky).toBe(true);
  });

  test('flaky check fails all retries → reported as failed with flaky: true', async () => {
    const checks: Check[] = [
      {
        name: 'always-fails',
        command: 'node -e "process.exitCode=1"',
        flaky: true,
        retries: 2,
      },
    ];

    const result = await runChecks(workdir, checks, 'task');

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.status).toBe('fail');
    expect(result.checks[0]!.flaky).toBe(true);
  });

  test('retries defaults to 1 when flaky: true but retries omitted', async () => {
    const counterFile = join(workdir, '.counter');
    const checks: Check[] = [
      {
        name: 'default-retry',
        command: `node ${join(FIXTURES, 'count-fail.cjs')} ${counterFile}`,
        flaky: true,
        // retries intentionally omitted — should default to 1
      },
    ];

    const result = await runChecks(workdir, checks, 'task');

    expect(result.passed).toBe(false);
    expect(result.checks[0]!.status).toBe('fail');
    expect(result.checks[0]!.flaky).toBe(true);

    // Verify the command was run exactly 2 times (1 initial + 1 retry)
    const counterValue = parseInt(await Bun.file(counterFile).text());
    expect(counterValue).toBe(2);
  });

  test('non-flaky check passes → no retry, reported as passed', async () => {
    const checks: Check[] = [{ name: 'passes', command: 'node -e "process.exitCode=0"' }];

    const result = await runChecks(workdir, checks, 'task');

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.status).toBe('pass');
    expect(result.checks[0]!.flaky).toBeUndefined();
  });
});
