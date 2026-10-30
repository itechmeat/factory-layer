import { afterAll, describe, expect, test } from 'bun:test';

import { AcceptanceCheckSchema } from '../../domain/acceptance';
import { REDACTED } from '../../domain/redact';
import { ProcessCheckRunner } from './check-runner';
import { cleanupFixturePackages, fixturePackage } from './testing/fixture-package';

afterAll(cleanupFixturePackages);

const CLI_TS = `
if (process.argv[2] === 'leak') process.stdout.write('token hunter2 leaked\\n');
else process.stdout.write('ok\\n');
`;

function packageJson(scripts: Record<string, string>): string {
  return JSON.stringify({ name: 'secret-fixture', private: true, scripts, bin: 'cli.ts' });
}

describe('ProcessCheckRunner', () => {
  test('a batch never throws and returns one result per check', async () => {
    const dir = await fixturePackage({ 'package.json': JSON.stringify({ name: 'batch-fixture', private: true }) });
    const runner = new ProcessCheckRunner();
    const results = await runner.runChecks(dir, [
      AcceptanceCheckSchema.parse({ id: 'batch-fail', description: 'fails', kind: 'command', command: 'exit 1', expectedExitCode: 0 }),
      AcceptanceCheckSchema.parse({ id: 'batch-pass', description: 'passes', kind: 'command', command: 'exit 0', expectedExitCode: 0 }),
    ]);
    expect(results.map((result) => result.checkId)).toEqual(['batch-fail', 'batch-pass']);
    expect(results.map((result) => result.status)).toEqual(['failed', 'passed']);
  });

  test('setSecrets redacts the captured output of steps and checks', async () => {
    const dir = await fixturePackage({
      'package.json': packageJson({ build: 'echo built', test: 'echo token hunter2 in tests' }),
      'cli.ts': CLI_TS,
    });
    const runner = new ProcessCheckRunner();
    runner.setSecrets(['hunter2']);

    const steps = await runner.packageSteps(dir, ['npm']);
    const testStep = steps.steps.find((step) => step.step === 'test');
    expect(testStep?.outcome?.stdout).toContain(REDACTED);
    expect(testStep?.outcome?.stdout).not.toContain('hunter2');

    const results = await runner.runChecks(dir, [
      AcceptanceCheckSchema.parse({
        id: 'secret-cli',
        description: 'leaks',
        kind: 'cli',
        args: ['leak'],
        expectedExitCode: 0,
        expectedStdout: { kind: 'substring', value: 'hunter2' },
      }),
    ]);
    const [result] = results;
    expect(result?.status).toBe('failed');
    const reason = result?.reasons.join(' ') ?? '';
    expect(reason).toContain(REDACTED);
    expect(reason).not.toContain('hunter2');
    expect(result?.detail).toContain(REDACTED);
    expect(result?.detail).not.toContain('hunter2');
  });
});
