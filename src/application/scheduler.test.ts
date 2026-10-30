import { describe, expect, test } from 'bun:test';

import type { StopResult } from '../ports';

import { RunFactory } from '.';
import { aSpec, aTask, drive, FakeExecutor, fakePorts, planOf, type FakePorts } from './testing';

const SPEC = aSpec();

function run(ports: FakePorts): ReturnType<RunFactory['run']> {
  return drive(ports.clock, new RunFactory(ports).run({ runId: 'run-k', spec: SPEC, options: { runTaskConcurrency: 1 } }));
}

/** An executor whose stops of the held runs stay unconfirmed until `confirmAfter` stops of the run were asked. */
class HeldExecutor extends FakeExecutor {
  private readonly asked = new Map<string, number>();
  readonly held = new Set<string>();
  confirmAfter = Number.POSITIVE_INFINITY;

  override async stop(runId: string, deadlineMs: number): Promise<StopResult> {
    if (!this.held.has(runId)) {
      return super.stop(runId, deadlineMs);
    }
    const count = (this.asked.get(runId) ?? 0) + 1;
    this.asked.set(runId, count);
    if (count < this.confirmAfter) {
      return { outcome: 'unconfirmed', detail: 'driver still alive' };
    }
    return super.stop(runId, deadlineMs);
  }
}

/** Cap 1, tasks a and b; a's run ends failed, its release is not confirmed, and the brain gives up on a. */
function heldPermit(confirmAfter: number): FakePorts {
  const base = fakePorts();
  const executor = new HeldExecutor({ clock: base.clock, sleep: base.sleep });
  executor.confirmAfter = confirmAfter;
  const ports = { ...base, executor };
  planOf(ports, [aTask({ id: 'a', ownedPaths: ['src/a'] }), aTask({ id: 'b', ownedPaths: ['src/b'] })]);
  ports.brain.script.recovery.defaultAnswer({ decision: { choice: 'give_up', reason: 'stop here' } });
  ports.executor.onStart((input, runId) => {
    if (input.tree === 'tree-a-r1') {
      executor.held.add(runId);
    }
    ports.executor.pushEvent(runId, { kind: 'terminal', status: input.tree === 'tree-a-r1' ? 'failed' : 'succeeded' });
  });
  return ports;
}

describe('scheduler', () => {
  test('a permit held by a run whose release is not confirmed is checked again and used once the run is seen stopped', async () => {
    const ports = heldPermit(3);

    await run(ports);

    const state = await ports.store.load('run-k');
    expect(state?.tasks['a']?.failReason).toBe('given_up');
    expect(state?.tasks['b']?.state).toBe('integrated');
    expect(ports.sink.ofType('executor_stopped').some((event) => event.purpose === 'recheck' && event.confirmed)).toBe(true);
  });

  test('a permit that never comes back fails the waiting tasks with slots_held after the stall limit, before delivery', async () => {
    const ports = heldPermit(Number.POSITIVE_INFINITY);

    const result = await run(ports);

    const state = await ports.store.load('run-k');
    expect(state?.tasks['b']?.failReason).toBe('slots_held');
    expect(ports.executor.starts).toHaveLength(1);
    const types = ports.sink.events.map((event) => event.type);
    expect(types.indexOf('delivery_done')).toBeGreaterThan(types.lastIndexOf('task_state_changed'));
    expect(result.outcome).toBe('partial');
  });

  test('a permit freed when a run ends is used at once, while its task is still being judged', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'a', ownedPaths: ['src/a'] }), aTask({ id: 'b', ownedPaths: ['src/b'] })]);
    ports.brain.script.judge.defaultAnswer({ decision: { outcome: 'accept' }, delayMs: 50_000 });
    ports.executor.onStart((_input, runId) => ports.executor.pushEvent(runId, { kind: 'terminal', status: 'succeeded' }));

    await run(ports);

    const [first, second] = ports.sink.ofType('executor_started');
    expect(second?.taskId).toBe('b');
    expect(Date.parse(second?.at ?? '')).toBe(Date.parse(first?.at ?? ''));
  });
});
