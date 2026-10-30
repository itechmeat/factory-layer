import { describe, expect, test } from 'bun:test';

import type { RunOptionsInput } from '../domain';
import type { ExecutorEvent } from '../ports';

import { RunFactory } from '.';
import { aSpec, aTask, drive, fakePorts, planOf, type FakePorts } from './testing';

const SPEC = aSpec();

function run(ports: FakePorts, options: RunOptionsInput = {}): ReturnType<RunFactory['run']> {
  return drive(ports.clock, new RunFactory(ports).run({ runId: 'run-s', spec: SPEC, options }));
}

/** One task whose first run reports the events; later runs (repairs) succeed at once. The critic gives up on recovery. */
function oneTaskWithEvents(ports: FakePorts, events: readonly ExecutorEvent[]): void {
  planOf(ports, [aTask({ id: 'only' })]);
  ports.brain.script.recovery.defaultAnswer({ decision: { choice: 'give_up', reason: 'test ends here' } });
  let first = true;
  ports.executor.onStart((_input, runId) => {
    for (const event of first ? events : [{ kind: 'terminal', status: 'succeeded' } as const]) {
      ports.executor.pushEvent(runId, event);
    }
    first = false;
  });
}

/** The failure the recovery decision saw. */
function recoveryFailure(ports: FakePorts): unknown {
  return ports.brain.callsOf('recovery')[0]?.args['failure'];
}

describe('supervised waits', () => {
  test('the cursor of the last event is saved and waits resume after it', async () => {
    const ports = fakePorts();
    oneTaskWithEvents(ports, [
      { kind: 'wake', seq: 4, trigger: 'node_finished', nodeId: 'plan', detail: null },
      { kind: 'wake', seq: 7, trigger: 'node_finished', nodeId: 'code', detail: null },
      { kind: 'terminal', status: 'succeeded' },
    ]);

    await run(ports);

    expect((await ports.store.load('run-s'))?.runs['executor-run-1']?.cursor).toBe(7);
    expect(ports.sink.ofType('executor_event').map((event) => event.seq)).toEqual([4, 7, 7]);
  });

  test('a run with no event for the stall limit is stopped and recovered as an executor failure', async () => {
    const ports = fakePorts();
    oneTaskWithEvents(ports, []);

    await run(ports, { executorStallLimitMs: 150_000 });

    const stopped = ports.sink.ofType('executor_stopped').find((event) => event.purpose === 'recovery');
    expect(stopped?.confirmed).toBe(true);
    expect(Date.parse(stopped?.at ?? '') - Date.parse(ports.sink.ofType('executor_started')[0]?.at ?? '')).toBe(150_000);
    expect(recoveryFailure(ports)).toMatchObject({ reason: 'stalled' });
    expect((await ports.store.load('run-s'))?.tasks['only']?.failReason).toBe('given_up');
  });

  test('a run that waits for a host agent is stopped at once and recovered as an executor failure', async () => {
    const ports = fakePorts();
    oneTaskWithEvents(ports, [{ kind: 'needs_host' }]);

    await run(ports);

    expect(ports.sink.ofType('executor_stopped').map((event) => event.purpose)).toEqual(['recovery']);
    expect(recoveryFailure(ports)).toMatchObject({ reason: 'needs_host' });
  });

  for (const trigger of ['question', 'review', 'stalled'] as const) {
    test(`a ${trigger} wake is stopped and recovered as an executor failure`, async () => {
      const ports = fakePorts();
      oneTaskWithEvents(ports, [{ kind: 'wake', seq: 1, trigger, nodeId: 'code', detail: 'waiting' }]);

      await run(ports);

      expect(ports.sink.ofType('executor_stopped').map((event) => event.purpose)).toEqual(['recovery']);
      expect(recoveryFailure(ports)).toMatchObject({ reason: trigger });
    });
  }

  test('a node failure on a live run enters recovery for that node before the run is stopped', async () => {
    const ports = fakePorts();
    oneTaskWithEvents(ports, [{ kind: 'wake', seq: 1, trigger: 'node_failed', nodeId: 'code', detail: 'tests failed' }]);

    await run(ports);

    expect(recoveryFailure(ports)).toMatchObject({ reason: 'node_failed', nodeId: 'code' });
    const types = ports.sink.events.map((event) => event.type);
    expect(types.indexOf('recovery_chosen')).toBeLessThan(types.indexOf('executor_stopped'));
    expect(ports.sink.ofType('executor_stopped').map((event) => event.purpose)).toEqual(['give_up']);
  });

  test('a node timeout is recovered as a failure of that node with the reason timeout', async () => {
    const ports = fakePorts();
    oneTaskWithEvents(ports, [{ kind: 'wake', seq: 1, trigger: 'node_failed', nodeId: 'code', detail: 'timeout' }]);

    await run(ports);

    expect(recoveryFailure(ports)).toMatchObject({ reason: 'timeout', nodeId: 'code' });
  });

  test('a node timeout with a detail is recovered with the reason timeout', async () => {
    const ports = fakePorts();
    oneTaskWithEvents(ports, [{ kind: 'wake', seq: 1, trigger: 'node_failed', nodeId: 'code', detail: 'timeout: no output for 600 s' }]);

    await run(ports);

    expect(recoveryFailure(ports)).toMatchObject({ reason: 'timeout', nodeId: 'code' });
  });

  test('a succeeded run whose release stays unconfirmed is neither committed nor integrated', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.executor.onStart((_input, runId) => {
      ports.executor.pushEvent(runId, { kind: 'terminal', status: 'succeeded' });
      ports.executor.setStopOutcome(runId, { confirmed: false });
    });

    await run(ports);

    expect(ports.workspace.commits).toEqual([]);
    expect(ports.sink.ofType('merge_produced')).toEqual([]);
    expect((await ports.store.load('run-s'))?.tasks['only']?.failReason).toBe('stop_unconfirmed');
  });

  test('failed and aborted terminals enter recovery with the run finished', async () => {
    for (const status of ['failed', 'aborted'] as const) {
      const ports = fakePorts();
      oneTaskWithEvents(ports, [{ kind: 'terminal', status }]);

      await run(ports);

      expect(recoveryFailure(ports)).toMatchObject({ reason: `run_${status}` });
      expect(ports.sink.ofType('executor_stopped').map((event) => event.purpose)).toEqual(['release']);
    }
  });
});
