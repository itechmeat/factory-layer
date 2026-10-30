import { afterAll, describe, expect, test } from 'bun:test';

import { ProcessCheckRunner } from './check-runner';
import { cleanupFixturePackages, fixturePackage } from './testing/fixture-package';

afterAll(cleanupFixturePackages);

function packageJson(scripts: Record<string, string>): string {
  return JSON.stringify({ name: 'fixture', private: true, scripts });
}

// A real passing `bun test` file: a runtime that ran `bun test` instead of the package's script would pass.
const SELFCHECK_TS = `
import { expect, test } from 'bun:test';
test('selfcheck', () => {
  expect(1).toBe(1);
});
`;

describe('ProcessCheckRunner.packageSteps', () => {
  test('a healthy package passes install, build and test under both runtimes', async () => {
    const dir = await fixturePackage({
      'package.json': packageJson({ build: 'echo built', test: 'echo tests-ok' }),
      'selfcheck.test.ts': SELFCHECK_TS,
    });
    const result = await new ProcessCheckRunner().packageSteps(dir, ['bun', 'npm']);

    expect(result.ok).toBe(true);
    expect(result.dir).toBe(dir);
    expect(result.runtimes).toEqual(['bun', 'npm']);
    expect(result.steps.map((step) => `${step.runtime}:${step.step}`)).toEqual([
      'bun:install',
      'bun:build',
      'bun:test',
      'npm:install',
      'npm:build',
      'npm:test',
    ]);
    for (const step of result.steps) {
      expect(step.ok).toBe(true);
      expect(step.missingScript).toBe(false);
      expect(step.outcome?.exitCode).toBe(0);
      expect(step.detail).not.toBe('');
    }
  });

  test('both runtimes run the package test script, so a failing script fails both', async () => {
    const dir = await fixturePackage({
      'package.json': packageJson({ build: 'echo built', test: 'echo tests-fail; exit 1' }),
      'selfcheck.test.ts': SELFCHECK_TS,
    });
    const result = await new ProcessCheckRunner().packageSteps(dir, ['bun', 'npm']);

    expect(result.ok).toBe(false);
    for (const runtime of ['bun', 'npm'] as const) {
      const testStep = result.steps.find((step) => step.runtime === runtime && step.step === 'test');
      expect(testStep?.ok).toBe(false);
      expect(testStep?.outcome?.exitCode).toBe(1);
      expect(testStep?.outcome?.stdout).toContain('tests-fail');
    }
  });

  test('each runtime installs into a clean node_modules, never reusing the previous runtime install', async () => {
    const seen = 'if [ -f node_modules/.seen ]; then echo reused; exit 1; fi; mkdir -p node_modules && touch node_modules/.seen';
    const dir = await fixturePackage({ 'package.json': packageJson({ test: seen }) });
    const result = await new ProcessCheckRunner().packageSteps(dir, ['bun', 'npm']);

    expect(result.steps.filter((step) => step.step === 'test').map((step) => step.ok)).toEqual([true, true]);
    expect(result.ok).toBe(true);
  });

  test('a missing build script is a passing no-op step', async () => {
    const dir = await fixturePackage({
      'package.json': packageJson({ test: 'echo tests-ok' }),
      'selfcheck.test.ts': SELFCHECK_TS,
    });
    const result = await new ProcessCheckRunner().packageSteps(dir, ['bun', 'npm']);

    const builds = result.steps.filter((step) => step.step === 'build');
    expect(builds).toHaveLength(2);
    for (const build of builds) {
      expect(build.ok).toBe(true);
      expect(build.missingScript).toBe(false);
      expect(build.outcome).toBeNull();
      expect(build.detail).toContain('no build script');
    }
    expect(result.ok).toBe(true);
  });

  test('a missing test script fails the test step under both runtimes and names the script', async () => {
    const dir = await fixturePackage({ 'package.json': packageJson({ build: 'echo built' }), 'selfcheck.test.ts': SELFCHECK_TS });
    const result = await new ProcessCheckRunner().packageSteps(dir, ['bun', 'npm']);

    expect(result.ok).toBe(false);
    const testSteps = result.steps.filter((step) => step.step === 'test');
    expect(testSteps.map((step) => step.runtime)).toEqual(['bun', 'npm']);
    for (const testStep of testSteps) {
      expect(testStep.ok).toBe(false);
      expect(testStep.missingScript).toBe(true);
      expect(testStep.outcome).toBeNull();
      expect(testStep.detail).toContain('test script');
    }
    expect(result.steps).toHaveLength(6);
  });

  test('a missing directory resolves with a failed result instead of throwing', async () => {
    const result = await new ProcessCheckRunner().packageSteps('/nonexistent-fcr-dir-xyz', ['bun']);
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(3);
    expect(result.steps.some((step) => !step.ok)).toBe(true);
  });
});

describe('ProcessCheckRunner.packageSteps, local type libraries', () => {
  test('a type library tsconfig names but the package does not install fails the install, naming it', async () => {
    const dir = await fixturePackage({
      'package.json': packageJson({ test: 'echo tests-ok' }),
      'tsconfig.json': '{\n  // types the build needs\n  "compilerOptions": { "types": ["node"] }\n}\n',
    });
    const result = await new ProcessCheckRunner().packageSteps(dir, ['bun']);

    const install = result.steps.find((step) => step.step === 'install');
    expect(install?.ok).toBe(false);
    expect(install?.detail).toContain('tsconfig.json names the type library "node"');
    expect(result.ok).toBe(false);
  });
});
