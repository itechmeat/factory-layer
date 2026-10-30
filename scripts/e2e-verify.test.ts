/**
 * Failure paths of the independent verification: a broken build fails the
 * runtime before its tests, and the npm runtime sees no `bun` on the PATH,
 * as a Node-only grader would.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';

import { cleanupFixturePackages, fixturePackage } from '../src/adapters/check-runner/testing/fixture-package';
import { createDeadline } from './e2e-process';
import { verifyRuntime, type RuntimeResult } from './e2e-verify';

const copies: string[] = [];

afterAll(async () => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
  await cleanupFixturePackages();
});

async function verify(scripts: Record<string, string>, runtime: 'bun' | 'npm'): Promise<RuntimeResult> {
  const dir = await fixturePackage({ 'package.json': JSON.stringify({ name: 'verify-fixture', private: true, scripts }) });
  const result = await verifyRuntime(runtime, dir, createDeadline(60_000));
  copies.push(result.copyDir);
  return result;
}

describe('verifyRuntime', () => {
  test('a broken build fails the runtime and no test step runs', async () => {
    const result = await verify({ build: 'echo build-broke; exit 2', test: 'echo tests-ok' }, 'npm');
    expect(result.passed).toBe(false);
    expect(result.steps.map((step) => `${step.name}:${String(step.passed)}`)).toEqual(['npm install:true', 'npm run build:false']);
    expect(result.steps[1]?.outputTail).toContain('build-broke');
  });

  test('a Bun-only test script fails under npm', async () => {
    const result = await verify({ test: 'bun --version' }, 'npm');
    expect(result.passed).toBe(false);
    expect(result.steps.at(-1)?.exitCode).toBe(127);
  });
});
