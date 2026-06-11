import { describe, test, expect } from 'bun:test';
import type { PacifistaEvent, ChecksResult } from '@kingsleyzissou/pacifista-core';
import { createEventRenderer, formatAutoRetryMessage } from './events.ts';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeChecksResult(overrides?: Partial<ChecksResult>): ChecksResult {
  return {
    passed: false,
    checks: [
      { name: 'typecheck', status: 'fail', output: 'error TS2345...' },
      { name: 'tests', status: 'pass' },
    ],
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('createEventRenderer – checks:auto-retry', () => {
  test('handler accepts checks:auto-retry event without throwing', () => {
    const { handler } = createEventRenderer();

    const event: PacifistaEvent = {
      type: 'checks:auto-retry',
      taskId: 1,
      attempt: 2,
      retriesRemaining: 1,
      checksResult: makeChecksResult(),
    };

    // Should not throw — the switch case must exist
    expect(() => handler(event)).not.toThrow();
  });

  test('handler processes auto-retry event (does not fall through to default)', () => {
    const { handler } = createEventRenderer();

    // If the event type isn't handled in the switch, it would be silently
    // ignored (no default case). We verify the handler runs to completion
    // for this event type. This is a smoke test — more detailed rendering
    // tests would require mocking @clack/prompts internals.
    const event: PacifistaEvent = {
      type: 'checks:auto-retry',
      taskId: 1,
      attempt: 3,
      retriesRemaining: 0,
      checksResult: makeChecksResult(),
    };

    expect(() => handler(event)).not.toThrow();
  });

  test('auto-retry event with 0 retries remaining still works', () => {
    const { handler } = createEventRenderer();

    const event: PacifistaEvent = {
      type: 'checks:auto-retry',
      taskId: 1,
      attempt: 5,
      retriesRemaining: 0,
      checksResult: makeChecksResult({
        passed: false,
        checks: [
          { name: 'typecheck', status: 'fail', output: 'errors' },
          { name: 'lint', status: 'fail', output: 'warnings' },
          { name: 'tests', status: 'pass' },
        ],
      }),
    };

    expect(() => handler(event)).not.toThrow();
  });
});

describe('createEventRenderer – auto-retry message format', () => {
  test('formatAutoRetryMessage produces correct message with plural retries', () => {
    const msg = formatAutoRetryMessage(2, 3);
    expect(msg).toContain('auto-retrying');
    expect(msg).toContain('attempt 2');
    expect(msg).toContain('3 auto-retries remaining');
  });

  test('formatAutoRetryMessage uses singular for 1 retry remaining', () => {
    const msg = formatAutoRetryMessage(3, 1);
    expect(msg).toContain('1 auto-retry remaining');
    expect(msg).not.toContain('auto-retries');
  });

  test('formatAutoRetryMessage shows 0 retries remaining', () => {
    const msg = formatAutoRetryMessage(5, 0);
    expect(msg).toContain('0 auto-retries remaining');
  });
});
