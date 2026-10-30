import { describe, expect, test } from 'bun:test';

import type { RecoveryChoice } from '../domain';
import type { StopResult } from '../ports';

import { RunFactory, type RunRequest } from '.';
import { aSpec, aTask, drive, FAKE_CLOCK_START_ISO, FakeExecutor, fakePorts, planOf, SlotRecordingSink, type FakePorts } from './testing';

const SPEC = aSpec();
const START_MS = Date.parse(FAKE_CLOCK_START_ISO);
const NODE_FAILED = { kind: 'wake', seq: 1, trigger: 'node_failed', nodeId: 'code', detail: 'tests failed' } as const;

function run(ports: FakePorts, request: Partial<RunRequest> = {}): ReturnType<RunFactory['run']> {
  return drive(ports.clock, new RunFactory(ports).run({ runId: 'run-c', spec: SPEC, ...request }));
}

/** Two independent tasks whose runs stay live until stopped. */
function twoLiveTasks(ports: FakePorts): void {
  planOf(ports, [aTask({ id: 'a', ownedPaths: ['src/a'] }), aTask({ id: 'b', ownedPaths: ['src/b'] })]);
}

/** An executor whose first stop of each run is unconfirmed and whose later stops confirm. */
class SlowToStopExecutor extends FakeExecutor {
  private readonly asked = new Set<string>();

  override async stop(runId: string, deadlineMs: number): Promise<StopResult> {
    if (!this.asked.has(runId)) {
      this.asked.add(runId);
      return { outcome: 'unconfirmed', detail: 'still running' };
    }
    return super.stop(runId, deadlineMs);
  }
}

function slowToStop(): FakePorts & { readonly sink: SlotRecordingSink } {
  const base = fakePorts();
  return { ...base, executor: new SlowToStopExecutor({ clock: base.clock, sleep: base.sleep }), sink: new SlotRecordingSink(base.slots) };
}

describe('cutoff', () => {
  test('the cutoff during execution stops both live runs, starts no new work and delivers', async () => {
    const ports = fakePorts();
    twoLiveTasks(ports);

    const result = await run(ports, { cutoffAtMs: START_MS + 30_000 });

    const stops = ports.sink.ofType('executor_stopped');
    expect(stops.map((event) => [event.taskId, event.purpose, event.confirmed])).toEqual([
      ['a', 'cutoff', true],
      ['b', 'cutoff', true],
    ]);
    expect(stops.every((event) => Date.parse(event.at) === START_MS + 30_000)).toBe(true);
    expect(ports.executor.starts).toHaveLength(2);
    expect(ports.sink.ofType('cutoff_reached')).toHaveLength(1);
    expect(ports.sink.ofType('delivery_done')).toHaveLength(1);
    const state = await ports.store.load('run-c');
    expect(Object.values(state?.tasks ?? {}).map((task) => task.failReason)).toEqual(['cutoff', 'cutoff']);
    expect(result.outcome).toBe('partial');
    expect(ports.slots.liveCount()).toBe(0);
  });

  test('no dispatch starts after the cutoff', async () => {
    const ports = fakePorts();
    twoLiveTasks(ports);

    await run(ports, { cutoffAtMs: START_MS + 30_000, options: { runTaskConcurrency: 1 } });

    expect(ports.executor.starts.map((start) => start.tree)).toEqual(['tree-a-r1']);
    expect((await ports.store.load('run-c'))?.tasks['b']?.failReason).toBe('cutoff');
  });

  test('the cutoff during recovery cancels the pending decision and starts no recovery', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.executor.onStart((_input, runId) => ports.executor.pushEvent(runId, NODE_FAILED));
    const repair: RecoveryChoice = { choice: 'retry', hint: 'too late' };
    ports.brain.script.recovery.answerWith({ decision: repair, delayMs: 100_000 });

    await run(ports, { cutoffAtMs: START_MS + 30_000 });

    expect(ports.sink.ofType('decision_ended').find((event) => event.kind === 'recovery')?.outcome).toBe('defaulted');
    expect(ports.sink.ofType('recovery_chosen')).toEqual([]);
    expect(ports.executor.commands).toEqual([]);
    expect(ports.executor.starts).toHaveLength(1);
    expect(ports.sink.ofType('executor_stopped').map((event) => event.purpose)).toEqual(['cutoff']);
  });

  test('the cutoff during planning ends the run as failed before any task starts', async () => {
    const ports = fakePorts();
    ports.brain.script.plan.answerWith({ decision: { tasks: [aTask({ id: 'only' })] }, delayMs: 100_000 });
    ports.brain.script.acceptance.answerWith({ decision: [] });

    const result = await run(ports, { cutoffAtMs: START_MS + 30_000 });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('cutoff');
    expect(ports.executor.starts).toEqual([]);
    expect(ports.sink.ofType('cutoff_reached')).toHaveLength(1);
  });

  test('a stop the cutoff cannot confirm is traced as abandoned and keeps its slot through delivery', async () => {
    const base = fakePorts();
    const sink = new SlotRecordingSink(base.slots);
    const ports = { ...base, sink };
    planOf(ports, [aTask({ id: 'only' })]);
    ports.executor.onStart((_input, runId) => ports.executor.setStopOutcome(runId, { confirmed: false }));

    await run(ports, { cutoffAtMs: START_MS + 30_000 });

    expect(ports.sink.ofType('executor_failure').some((event) => event.reason.startsWith('abandoned'))).toBe(true);
    expect(sink.liveCounts.find((entry) => entry.type === 'delivery_done')?.live).toBe(1);
    expect(ports.slots.liveCount()).toBe(0);
  });

  test("the caller's cancellation sets the cutoff to now, stops the live runs and delivers", async () => {
    const ports = fakePorts();
    twoLiveTasks(ports);
    const cancel = new AbortController();
    void ports.sleep(20_000).then(() => cancel.abort());

    const result = await run(ports, { signal: cancel.signal });

    expect((await ports.store.load('run-c'))?.cutoffAtMs).toBe(START_MS + 20_000);
    expect(ports.sink.ofType('executor_stopped').map((event) => event.purpose)).toEqual(['cutoff', 'cutoff']);
    expect(ports.sink.ofType('delivery_done')).toHaveLength(1);
    expect(result.outcome).toBe('partial');
  });
});

describe('unconfirmed stops', () => {
  test('a live run stopped for a repair without confirmation blocks the repair, fails the task and holds the slot until it is seen stopped', async () => {
    const ports = slowToStop();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.executor.onStart((_input, runId) => ports.executor.pushEvent(runId, NODE_FAILED));
    ports.brain.script.recovery.answerWith({ decision: { choice: 'repair', failingCheckIds: ['help'] } });

    await run(ports);

    expect(ports.executor.starts).toHaveLength(1);
    expect((await ports.store.load('run-c'))?.tasks['only']?.failReason).toBe('stop_unconfirmed');
    const { sink } = ports;
    expect(sink.liveCounts.find((entry) => entry.type === 'task_state_changed' && entry.live === 1)).toBeDefined();
    const recheck = ports.sink.ofType('executor_stopped').find((event) => event.purpose === 'recheck');
    expect(recheck?.confirmed).toBe(true);
    expect(sink.liveCounts.find((entry) => entry.type === 'delivery_done')?.live).toBe(0);
  });

  test('a give up whose stop is not confirmed fails the task with stop_unconfirmed instead of given_up', async () => {
    const ports = slowToStop();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.executor.onStart((_input, runId) => ports.executor.pushEvent(runId, NODE_FAILED));
    ports.brain.script.recovery.answerWith({ decision: { choice: 'give_up', reason: 'hopeless' } });

    await run(ports);

    expect((await ports.store.load('run-c'))?.tasks['only']?.failReason).toBe('stop_unconfirmed');
    expect((await ports.store.load('run-c'))?.runs['executor-run-1']?.state).toBe('stopped');
  });
});
