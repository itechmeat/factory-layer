import { describe, expect, test } from 'bun:test';

import { z } from 'zod';

import { BRAIN_DECISION_RETRIES, CheckResultSchema, type CheckResult } from '../domain';

import { RunFactory } from '.';
import { aSpec, aTask, cliCheck, drive, fakePorts, planOf, succeedRuns, type FakePorts } from './testing';

const SPEC = aSpec();

/** The check results the first judge decision received, validated. */
function judgedResults(ports: FakePorts): readonly CheckResult[] {
  return z.array(CheckResultSchema).parse(ports.brain.callsOf('judge')[0]?.args['checkResults']);
}

function run(ports: FakePorts): ReturnType<RunFactory['run']> {
  return drive(ports.clock, new RunFactory(ports).run({ runId: 'run-j', spec: SPEC, options: { requiredRuntimes: ['bun', 'npm'] } }));
}

describe('judging', () => {
  test('the critic gets the package steps under both runtimes and every acceptance check', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })], [cliCheck({ id: 'help' }), cliCheck({ id: 'add' })]);
    succeedRuns(ports);

    await run(ports);

    const results = judgedResults(ports);
    expect(results.map((result) => result.checkId)).toEqual([
      'package-bun-install',
      'package-bun-build',
      'package-bun-test',
      'package-npm-install',
      'package-npm-build',
      'package-npm-test',
      'help',
      'add',
    ]);
    expect(ports.checks.calls[0]?.dir).toBe('tree-only-r1');
  });

  test('a scaffold accepted while the feature checks fail moves on to integration', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'scaffold' })], [cliCheck({ id: 'add' })]);
    ports.checks.setResultsForDir('tree-scaffold-r1', [{ checkId: 'add', status: 'failed', reasons: ['unknown command add'], detail: '' }]);
    succeedRuns(ports);

    await run(ports);

    const results = judgedResults(ports);
    expect(results.find((result) => result.checkId === 'add')?.status).toBe('failed');
    expect((await ports.store.load('run-j'))?.tasks['scaffold']?.state).toBe('integrated');
  });

  test('a critic that fails every attempt rejects the task with brain_unavailable and recovery applies', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.brain.failNext('judge', 1 + BRAIN_DECISION_RETRIES, 'brain down');
    ports.brain.script.recovery.answerWith({ decision: { choice: 'give_up', reason: 'stop' } });
    succeedRuns(ports);

    await run(ports);

    expect(ports.sink.ofType('verdict')[0]).toMatchObject({ outcome: 'reject', reasons: ['brain_unavailable'] });
    expect(ports.brain.callsOf('recovery')[0]?.args['failure']).toMatchObject({ reason: 'brain_unavailable' });
  });
});
