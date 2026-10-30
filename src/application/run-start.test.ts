import { describe, expect, test } from 'bun:test';

import { BRAIN_DECISION_RETRIES, MEMORY_DEADLINE_MS, type RunOptionsInput } from '../domain';
import type { Memory } from '../ports';
import type { FactoryPorts } from './run-context';

import { RunFactory } from '.';
import { aPlan, aSpec, aTask, cliCheck, drive, fakePorts, planOf, succeedRuns, type FakeClock } from './testing';

const SPEC = aSpec();

function run(ports: FactoryPorts & { readonly clock: FakeClock }, options: RunOptionsInput = {}): ReturnType<RunFactory['run']> {
  return drive(ports.clock, new RunFactory(ports).run({ runId: 'run-start', spec: SPEC, options }));
}

describe('run start', () => {
  test('a recall that never answers is abandoned at the memory deadline and the plan gets no recall', async () => {
    const hanging: Memory = {
      recall: () =>
        new Promise<never>(() => {
          // Never settles: the memory deadline must end the wait.
        }),
      remember: async () => undefined,
    };
    const ports = { ...fakePorts(), memory: hanging };
    planOf(ports, [aTask({ id: 'only' })], [cliCheck()]);
    succeedRuns(ports);

    const result = await run(ports);

    const failed = ports.sink.ofType('memory_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.phase).toBe('recall');
    expect(Date.parse(failed[0]?.at ?? '') - Date.parse(ports.sink.events[0]?.at ?? '')).toBe(MEMORY_DEADLINE_MS);
    expect(ports.brain.callsOf('plan')[0]?.args['recalled']).toEqual([]);
    expect(result.outcome).toBe('succeeded');
  });

  test('plan and acceptance are both asked before either answers, and their intervals overlap', async () => {
    const ports = fakePorts();
    ports.brain.script.plan.answerWith({ decision: aPlan([aTask({ id: 'only' })]), delayMs: 100 });
    ports.brain.script.acceptance.answerWith({ decision: [], delayMs: 100 });
    ports.brain.script.judge.defaultAnswer({ decision: { outcome: 'accept' } });
    succeedRuns(ports);

    await run(ports);

    const [plan] = ports.brain.callsOf('plan');
    const [acceptance] = ports.brain.callsOf('acceptance');
    expect(plan?.startedAt).toBe(acceptance?.startedAt);
    expect(plan?.endedAt).toBe(acceptance?.endedAt);
    expect(Date.parse(plan?.endedAt ?? '') - Date.parse(plan?.startedAt ?? '')).toBe(100);
  });

  test('an overlapping first plan is corrected once, the rejection is traced and the runtime re-plan stays available', async () => {
    const ports = fakePorts();
    const overlapping = aPlan([aTask({ id: 'a', ownedPaths: ['src'] }), aTask({ id: 'b', ownedPaths: ['src/cli.ts'] })]);
    planOf(ports, overlapping.tasks, [cliCheck()]);
    ports.brain.script.correct_plan.answerWith({
      decision: aPlan([aTask({ id: 'a', ownedPaths: ['src/a'] }), aTask({ id: 'b', ownedPaths: ['src/b'] })]),
    });
    succeedRuns(ports);

    const result = await run(ports);

    expect(ports.sink.ofType('plan_rejected')).toHaveLength(1);
    expect(ports.sink.ofType('plan_rejected')[0]).toMatchObject({
      source: 'initial',
      reasons: [{ kind: 'path_overlap', taskIdA: 'a', taskIdB: 'b', pathA: 'src', pathB: 'src/cli.ts' }],
    });
    expect(ports.sink.ofType('plan_produced').map((event) => event.source)).toEqual(['correction']);
    expect(result.outcome).toBe('succeeded');
    expect((await ports.store.load('run-start'))?.replansUsed).toBe(0);
  });

  test('a second invalid plan fails the run before any task starts', async () => {
    const ports = fakePorts();
    const invalid = aPlan([aTask({ id: 'a', dependsOn: ['ghost'] })]);
    planOf(ports, invalid.tasks);
    ports.brain.script.correct_plan.answerWith({ decision: invalid });

    const result = await run(ports);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('plan_invalid');
    expect(ports.sink.ofType('plan_rejected').map((event) => event.source)).toEqual(['initial', 'correction']);
    expect(ports.executor.starts).toEqual([]);
    expect(await ports.store.load('run-start')).toBeNull();
    expect(ports.memory.remembered[0]?.outcome).toBe('failed');
  });

  test('a plan decision that fails every attempt fails the run and cancels the acceptance decision', async () => {
    const ports = fakePorts();
    ports.brain.failNext('plan', 1 + BRAIN_DECISION_RETRIES, 'brain down');
    ports.brain.script.acceptance.answerWith({ decision: [], delayMs: 1000 });

    const result = await run(ports);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('plan_unavailable');
    const acceptanceEnd = ports.sink.ofType('decision_ended').find((event) => event.kind === 'acceptance');
    expect(acceptanceEnd?.outcome).toBe('defaulted');
    expect(ports.executor.starts).toEqual([]);
  });

  test('an acceptance decision that fails every attempt continues without checks and caps the outcome at partial', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.brain.failNext('acceptance', 1 + BRAIN_DECISION_RETRIES, 'brain down');
    succeedRuns(ports);

    const result = await run(ports);

    expect(ports.sink.ofType('acceptance_unavailable')).toHaveLength(1);
    expect(result.outcome).toBe('partial');
    expect(result.reason).toContain('acceptance_unavailable');
    expect((await ports.store.load('run-start'))?.acceptanceUnavailable).toBe(true);
  });
});
