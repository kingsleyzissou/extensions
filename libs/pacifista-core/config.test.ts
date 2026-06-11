import { describe, expect, test } from 'bun:test';
import { deepMerge, DEFAULTS } from './config.ts';
import type { DeepPartial, PacifistaConfig } from './types.ts';

describe('deepMerge', () => {
  test('empty overrides preserve file config values', () => {
    const fileConfig: DeepPartial<PacifistaConfig> = {
      pi: { sandbox: true },
    };

    const result = deepMerge(DEFAULTS, fileConfig, {});

    expect(result.pi.sandbox).toBe(true);
    // Default that wasn't overridden stays
    expect(result.pi.noSandbox).toBe(false);
  });

  test('explicit false override wins over file config true', () => {
    const fileConfig: DeepPartial<PacifistaConfig> = {
      pi: { sandbox: true },
    };
    const cliOverrides: DeepPartial<PacifistaConfig> = {
      pi: { sandbox: false },
    };

    const result = deepMerge(DEFAULTS, fileConfig, cliOverrides);

    expect(result.pi.sandbox).toBe(false);
  });

  test('undefined does NOT override file config', () => {
    const fileConfig: DeepPartial<PacifistaConfig> = {
      pi: { sandbox: true },
    };
    const cliOverrides: DeepPartial<PacifistaConfig> = {
      pi: { sandbox: undefined },
    };

    const result = deepMerge(DEFAULTS, fileConfig, cliOverrides);

    expect(result.pi.sandbox).toBe(true);
  });

  test('empty nested object does not clobber existing values', () => {
    const fileConfig: DeepPartial<PacifistaConfig> = {
      pi: { sandbox: true },
    };
    const cliOverrides: DeepPartial<PacifistaConfig> = {
      pi: {},
    };

    const result = deepMerge(DEFAULTS, fileConfig, cliOverrides);

    expect(result.pi.sandbox).toBe(true);
    expect(result.pi.noSandbox).toBe(false);
  });

  test('arrays replace rather than merge', () => {
    const fileConfig: DeepPartial<PacifistaConfig> = {
      checks: [{ name: 'custom-lint', command: 'bun run lint' }],
    };

    const result = deepMerge(DEFAULTS, fileConfig, {});

    // The file config's array should replace the defaults entirely
    expect(result.checks).toEqual([{ name: 'custom-lint', command: 'bun run lint' }]);
    expect(result.checks).toHaveLength(1);
  });
});

describe('resume preserves config file sandbox preference', () => {
  test('empty pi override from buildConfigOverrides does not clobber config file sandbox: true', () => {
    // Simulates the full merge path during `kuma resume`:
    //   1. DEFAULTS has { pi: { sandbox: false, noSandbox: false } }
    //   2. Config file sets { pi: { sandbox: true, noSandbox: false } }
    //   3. buildConfigOverrides returns { pi: {} } when no CLI flags are set
    // The merged result must preserve the config file's sandbox: true.
    const configFile: DeepPartial<PacifistaConfig> = {
      pi: { sandbox: true, noSandbox: false },
    };
    const cliOverrides: DeepPartial<PacifistaConfig> = { pi: {} };

    const result = deepMerge(DEFAULTS, configFile, cliOverrides);

    expect(result.pi.sandbox).toBe(true);
    expect(result.pi.noSandbox).toBe(false);
  });

  test('explicit CLI --sandbox flag still overrides config file', () => {
    // When a user passes --sandbox on the CLI, buildConfigOverrides
    // produces { pi: { sandbox: true } } — this must win.
    const configFile: DeepPartial<PacifistaConfig> = {
      pi: { sandbox: false, noSandbox: false },
    };
    const cliOverrides: DeepPartial<PacifistaConfig> = { pi: { sandbox: true } };

    const result = deepMerge(DEFAULTS, configFile, cliOverrides);

    expect(result.pi.sandbox).toBe(true);
  });

  test('--no-sandbox merges into config without clobbering sandbox: true', () => {
    const configFile: DeepPartial<PacifistaConfig> = {
      pi: { sandbox: true, noSandbox: false },
    };
    const cliOverrides: DeepPartial<PacifistaConfig> = { pi: { noSandbox: true } };

    const result = deepMerge(DEFAULTS, configFile, cliOverrides);

    expect(result.pi.sandbox).toBe(true);
    expect(result.pi.noSandbox).toBe(true);
  });
});
