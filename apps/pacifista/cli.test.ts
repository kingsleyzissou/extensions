import { describe, expect, test } from 'bun:test';
import { parseArgs, buildConfigOverrides } from './cli.ts';

describe('parseArgs', () => {
  test('no sandbox flags → sandbox and noSandbox are both undefined', () => {
    const result = parseArgs(['node', 'cli.ts', 'execute', 'plan.md']);
    expect(result.sandbox).toBeUndefined();
    expect(result.noSandbox).toBeUndefined();
  });

  test('--sandbox → sandbox is true, noSandbox is undefined', () => {
    const result = parseArgs(['node', 'cli.ts', 'execute', 'plan.md', '--sandbox']);
    expect(result.sandbox).toBe(true);
    expect(result.noSandbox).toBeUndefined();
  });

  test('--no-sandbox → noSandbox is true, sandbox is undefined', () => {
    const result = parseArgs(['node', 'cli.ts', 'execute', 'plan.md', '--no-sandbox']);
    expect(result.noSandbox).toBe(true);
    expect(result.sandbox).toBeUndefined();
  });
});

describe('buildConfigOverrides', () => {
  test('both undefined → pi does not contain sandbox/noSandbox keys', () => {
    const overrides = buildConfigOverrides({
      command: 'resume',
      commitPerTask: true,
      skipReview: false,
      sandbox: undefined,
      noSandbox: undefined,
    });
    expect(overrides.pi).toBeDefined();
    expect(overrides.pi).not.toHaveProperty('sandbox');
    expect(overrides.pi).not.toHaveProperty('noSandbox');
  });

  test('sandbox: true → pi.sandbox is true', () => {
    const overrides = buildConfigOverrides({
      command: 'execute',
      commitPerTask: true,
      skipReview: false,
      sandbox: true,
      noSandbox: undefined,
    });
    expect(overrides.pi!.sandbox).toBe(true);
    expect(overrides.pi).not.toHaveProperty('noSandbox');
  });

  test('noSandbox: true → pi.noSandbox is true', () => {
    const overrides = buildConfigOverrides({
      command: 'execute',
      commitPerTask: true,
      skipReview: false,
      sandbox: undefined,
      noSandbox: true,
    });
    expect(overrides.pi!.noSandbox).toBe(true);
    expect(overrides.pi).not.toHaveProperty('sandbox');
  });
});
