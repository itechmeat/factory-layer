import { describe, expect, test } from 'bun:test';

import type { CheckResult, Plan, PlanTask, RunOptionsInput } from '../domain';
import { BrainError, type ExecutorReport } from '../ports';

import { RunFactory } from '.';
import { aPlan, aSpec, aTask, drive, FakeBrain, fakePorts, planOf, type FakePorts } from './testing';

const SPEC = aSpec();
const BASE = aTask({ id: 'base', ownedPaths: ['src/base'] });
const A = aTask({ id: 'a', ownedPaths: ['src/a'] });
const B = aTask({ id: 'b', ownedPaths: ['src/b'] });
const C = aTask({ id: 'c', ownedPaths: ['src/c'] });

/** A brain whose first verdict on task b takes 200 s (cancellable), so a re-plan finds b being judged. */
class SlowFirstJudgeOfB extends FakeBrain {
  private slowed = false;

  override async judge(
    task: PlanTask,
    report: ExecutorReport,
    checkResults: readonly CheckResult[],
    signal: AbortSignal,
  ): ReturnType<FakeBrain['judge']> {
    if (task.id === 'b' && !this.slowed) {
      this.slowed = true;
      try {
        await this.sleepFor(200_000, signal);
      } catch {
        throw new BrainError({ reason: 'cancelled', detail: 'judge cancelled', usage: [] });
      }
    }
    return super.judge(task, report, checkResults, signal);
  }

  sleepFor: (ms: number, signal: AbortSignal) => Promise<void> = async () => undefined;
}

/**
 * Four independent tasks: base integrates at once; a's first run stays live;
 * b's first run succeeds and its verdict is slow; c's first run fails after
 * 10 s (seen at the end of its 60 s wait slice), and with one attempt it
 * asks for the re-plan. Later runs succeed. The run's cap lets all four run.
 */
function inFlight(options: { readonly unconfirmedStopOfA?: boolean } = {}): FakePorts {
  const base = fakePorts();
  const brain = new SlowFirstJudgeOfB({ clock: base.clock, sleep: base.sleep });
  brain.sleepFor = (ms, signal) => base.sleep(ms, signal);
  const ports = { ...base, brain };
  planOf(ports, [BASE, A, B, C]);
  ports.executor.onStart((input, runId) => {
    if (input.tree === 'tree-a-r1') {
      if (options.unconfirmedStopOfA === true) {
        ports.executor.setStopOutcome(runId, { confirmed: false });
      }
      return;
    }
    if (input.tree === 'tree-c-r1') {
      void ports.sleep(10_000).then(() => ports.executor.pushEvent(runId, { kind: 'terminal', status: 'failed' }));
      return;
    }
    ports.executor.pushEvent(runId, { kind: 'terminal', status: 'succeeded' });
  });
  return ports;
}

const IN_FLIGHT_OPTIONS: RunOptionsInput = { taskAttemptBudget: 1, runTaskConcurrency: 4 };

function run(ports: FakePorts, options: RunOptionsInput = IN_FLIGHT_OPTIONS): ReturnType<RunFactory['run']> {
  return drive(ports.clock, new RunFactory(ports).run({ runId: 'run-p', spec: SPEC, options }));
}

function startKeys(ports: FakePorts): string[] {
  return ports.executor.starts.map((start) => start.dispatchKey);
}

/** The types of the events between the re-plan's start and end. */
function eventsDuringReplan(ports: FakePorts): string[] {
  const types = ports.sink.events.map((event) => event.type);
  return types.slice(types.indexOf('replan_started'), types.indexOf('replan_ended') + 1);
}

describe('runtime re-plan', () => {
  test('a re-plan with a running and a judging task stops the run, discards the verdict, keeps the integrated task and starts new revisions with fresh budgets', async () => {
    const ports = inFlight();
    const replacement: Plan = aPlan([BASE, A, B, C]);
    ports.brain.script.replan.answerWith({ decision: replacement });

    const result = await run(ports);

    const stopped = ports.sink.ofType('executor_stopped').filter((event) => event.purpose === 'replan');
    expect(stopped.map((event) => [event.taskId, event.confirmed])).toEqual([['a', true]]);
    expect(ports.sink.ofType('stale_result_discarded').map((event) => event.taskId)).toEqual(['b']);
    expect(eventsDuringReplan(ports)).not.toContain('executor_started');
    expect(ports.brain.callsOf('replan')[0]?.args['integrated']).toEqual(['base']);
    expect(startKeys(ports).filter((key) => key.includes('|r2|'))).toEqual(['run-p|a|r2|a1', 'run-p|b|r2|a1', 'run-p|c|r2|a1']);
    expect(startKeys(ports).filter((key) => key.includes('|base|'))).toEqual(['run-p|base|r1|a1']);
    const state = await ports.store.load('run-p');
    expect(state?.replansUsed).toBe(1);
    expect(state?.tasks).toEqual({
      base: { revision: 1, state: 'integrated', attemptsUsed: 1 },
      a: { revision: 2, state: 'integrated', attemptsUsed: 1 },
      b: { revision: 2, state: 'integrated', attemptsUsed: 1 },
      c: { revision: 2, state: 'integrated', attemptsUsed: 1 },
    });
    expect(state?.intents).toEqual([]);
    expect(result.outcome).toBe('partial');
  });

  test('an integrated task reworded, with its owned paths respelled, still matches and keeps its original record', async () => {
    const ports = inFlight();
    const reworded = { ...BASE, description: 'said differently', ownedPaths: ['./src/base/'] };
    ports.brain.script.replan.answerWith({ decision: aPlan([reworded, A, B, C]) });

    await run(ports);

    const state = await ports.store.load('run-p');
    expect(ports.sink.ofType('replan_ended').map((event) => event.ok)).toEqual([true]);
    expect(state?.plan.tasks.find((task) => task.id === 'base')).toEqual(BASE);
  });

  test('an invalid replacement plan fails the asker, dispatches the stopped task again with its attempts, judges the waiting task again, and spends the allowance', async () => {
    const ports = inFlight();
    ports.brain.script.replan.answerWith({ decision: aPlan([A, aTask({ id: 'a', ownedPaths: ['src/other'] })]) });

    await run(ports);

    const state = await ports.store.load('run-p');
    expect(state?.tasks['c']).toMatchObject({ state: 'failed', failReason: 'replan_invalid' });
    expect(ports.sink.ofType('plan_rejected').map((event) => event.source)).toEqual(['replan']);
    expect(startKeys(ports)).toContain('run-p|a|r2|a1');
    expect(ports.sink.ofType('stale_result_discarded').map((event) => event.taskId)).toEqual(['b']);
    const judgesOfB = ports.sink.ofType('decision_started').filter((event) => event.kind === 'judge' && event.taskId === 'b');
    expect(judgesOfB.map((event) => event.revision)).toEqual([1, 1]);
    expect(state?.tasks['b']).toMatchObject({ revision: 1, state: 'integrated' });
    expect(state?.tasks['a']).toMatchObject({ revision: 2, state: 'integrated', attemptsUsed: 1 });
    expect(state?.replansUsed).toBe(1);
    expect(ports.sink.ofType('replan_ended').map((event) => event.ok)).toEqual([false]);
  });

  test('a re-plan decision that fails every attempt keeps the plan and fails the asker', async () => {
    const ports = inFlight();
    ports.brain.failNext('replan', 3, 'brain down');

    await run(ports);

    const state = await ports.store.load('run-p');
    expect(state?.tasks['c']).toMatchObject({ state: 'failed', failReason: 'replan_unavailable' });
    expect(state?.tasks['a']).toMatchObject({ revision: 2, state: 'integrated' });
    expect(state?.plan.tasks.map((task) => task.id)).toEqual(['base', 'a', 'b', 'c']);
  });

  test('a stop the re-plan cannot confirm fails that task and the asker, and the others continue under the current plan', async () => {
    const ports = inFlight({ unconfirmedStopOfA: true });
    ports.brain.script.replan.answerWith({ decision: aPlan([BASE, A, B, C]) });

    await run(ports);

    const state = await ports.store.load('run-p');
    expect(ports.brain.callsOf('replan')).toEqual([]);
    expect(state?.tasks['a']).toMatchObject({ state: 'failed', failReason: 'stop_unconfirmed' });
    expect(state?.tasks['c']).toMatchObject({ state: 'failed', failReason: 'replan_failed' });
    expect(state?.tasks['b']).toMatchObject({ revision: 1, state: 'integrated' });
    expect(state?.replansUsed).toBe(1);
  });

  test('a re-plan budget of 2 allows a second re-plan; the third task to spend its attempts then fails without a decision', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'x' })]);
    ports.executor.onStart((_input, runId) => {
      ports.executor.pushEvent(runId, { kind: 'terminal', status: 'failed' });
    });
    ports.brain.script.replan.defaultAnswer({ decision: aPlan([aTask({ id: 'x' })]) });

    await run(ports, { taskAttemptBudget: 1, runReplanBudget: 2 });

    const state = await ports.store.load('run-p');
    expect(ports.brain.callsOf('replan')).toHaveLength(2);
    expect(state?.replansUsed).toBe(2);
    expect(state?.tasks['x']).toMatchObject({ revision: 3, state: 'failed', failReason: 'budget_spent' });
  });

  test('an asker whose run release was not confirmed is stopped again by the re-plan and fails when that stays unconfirmed', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'x' })]);
    ports.executor.onStart((_input, runId) => {
      ports.executor.pushEvent(runId, { kind: 'terminal', status: 'failed' });
      ports.executor.setStopOutcome(runId, { confirmed: false });
    });
    ports.brain.script.replan.answerWith({ decision: aPlan([aTask({ id: 'x' })]) });

    await run(ports, { taskAttemptBudget: 1 });

    const state = await ports.store.load('run-p');
    expect(ports.brain.callsOf('replan')).toEqual([]);
    expect(ports.sink.ofType('executor_stopped').map((event) => [event.purpose, event.confirmed])).toContainEqual(['replan', false]);
    expect(state?.tasks['x']?.failReason).toBe('stop_unconfirmed');
    expect(ports.executor.starts).toHaveLength(1);
  });
});
