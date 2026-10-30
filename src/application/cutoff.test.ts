import { describe, expect, test } from 'bun:test';

import type { RecoveryChoice, Runtime } from '../domain';
import type { AdvanceResult, IntegrationPreparation, PackageStepsResult, StopResult, WaitEventResult } from '../ports';

import { RunFactory, type RunRequest } from '.';
import {
  aSpec,
  aTask,
  drive,
  FAKE_CLOCK_START_ISO,
  FakeCheckRunner,
  FakeExecutor,
  fakePorts,
  FakeWorkspace,
  planOf,
  SlotRecordingSink,
  succeedRuns,
  type FakePorts,
} from './testing';

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

/**
 * An executor whose runs (only the named one, when given) emit a progress
 * event every 5 s of fake time, forever, ignoring the wait's signal; other
 * runs serve their scripted events.
 */
class ChattyExecutor extends FakeExecutor {
  private readonly sleepFor: (ms: number) => Promise<void>;
  private readonly only: string | null;
  private seq = 0;

  constructor(deps: ConstructorParameters<typeof FakeExecutor>[0], only: string | null = null) {
    super(deps);
    this.sleepFor = (ms) => deps.sleep(ms);
    this.only = only;
  }

  override async waitEvent(runId: string, afterSeq: number, sliceMs: number): Promise<WaitEventResult> {
    if (this.only !== null && runId !== this.only) {
      return super.waitEvent(runId, afterSeq, sliceMs);
    }
    await this.sleepFor(5_000);
    this.seq += 1;
    return { event: { kind: 'wake', seq: this.seq, trigger: 'node_finished', nodeId: 'code', detail: null }, nextAfterSeq: this.seq };
  }
}

/** A check runner whose package steps in the named task tree take an hour and ignore every signal. */
class SlowTreeChecks extends FakeCheckRunner {
  private readonly tree: string;
  private readonly sleepFor: (ms: number) => Promise<void>;

  constructor(tree: string, sleepFor: (ms: number) => Promise<void>) {
    super();
    this.tree = tree;
    this.sleepFor = sleepFor;
  }

  override async packageSteps(dir: string, runtimes: readonly Runtime[]): Promise<PackageStepsResult> {
    if (dir === this.tree) {
      await this.sleepFor(3_600_000);
    }
    return super.packageSteps(dir, runtimes);
  }
}

/** A workspace whose integrations run in their own tree and whose advance of main may run a hook first. */
class IntegrationTreeWorkspace extends FakeWorkspace {
  beforeAdvance: () => Promise<void> = async () => undefined;

  override async prepareIntegration(specName: string, taskId: string, revision: number): Promise<IntegrationPreparation> {
    const prepared = await super.prepareIntegration(specName, taskId, revision);
    return prepared.ok ? { ...prepared, tree: 'integration-tree' } : prepared;
  }

  override async advanceMain(specName: string, commit: string, base: string): Promise<AdvanceResult> {
    await this.beforeAdvance();
    return super.advanceMain(specName, commit, base);
  }
}

/** A check runner whose package steps in the integration tree run a hook first. */
class HookedIntegrationChecks extends FakeCheckRunner {
  beforeIntegration: () => Promise<void> = async () => undefined;

  override async packageSteps(dir: string, runtimes: readonly Runtime[]): Promise<PackageStepsResult> {
    if (dir === 'integration-tree') {
      await this.beforeIntegration();
    }
    return super.packageSteps(dir, runtimes);
  }
}

/** One task whose run succeeds at once, on a workspace and check runner with integration hooks. */
function hookedIntegration(): FakePorts & { readonly workspace: IntegrationTreeWorkspace; readonly checks: HookedIntegrationChecks } {
  const base = fakePorts();
  const ports = { ...base, workspace: new IntegrationTreeWorkspace(), checks: new HookedIntegrationChecks() };
  planOf(ports, [aTask({ id: 'only' })]);
  succeedRuns(ports);
  return ports;
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

  test('a task that keeps emitting executor events past the cutoff is stopped and delivery starts within the bound', async () => {
    const base = fakePorts();
    const ports = { ...base, executor: new ChattyExecutor({ clock: base.clock, sleep: base.sleep }) };
    planOf(ports, [aTask({ id: 'only' })]);
    const cutoffAtMs = START_MS + 30_000;

    const result = await run(ports, { cutoffAtMs });

    expect(ports.sink.ofType('executor_stopped').map((event) => [event.purpose, event.confirmed])).toEqual([['cutoff', true]]);
    const deliveryStartMs = Date.parse(ports.sink.ofType('delivery_step')[0]?.at ?? '');
    expect(deliveryStartMs - cutoffAtMs).toBeLessThanOrEqual(60_000);
    expect(ports.sink.ofType('executor_event').every((event) => Date.parse(event.at) <= cutoffAtMs)).toBe(true);
    expect((await ports.store.load('run-c'))?.tasks['only']?.failReason).toBe('cutoff');
    expect(result.outcome).toBe('partial');
  });

  test('a runner busy past the cutoff does not hold delivery back and its late verdict is discarded', async () => {
    const base = fakePorts();
    const ports = {
      ...base,
      executor: new ChattyExecutor({ clock: base.clock, sleep: base.sleep }, 'executor-run-1'),
      checks: new SlowTreeChecks('tree-b-r1', (ms) => base.sleep(ms)),
    };
    planOf(ports, [aTask({ id: 'a', ownedPaths: ['src/a'] }), aTask({ id: 'b', ownedPaths: ['src/b'] })]);
    ports.executor.onStart((input, runId) => {
      if (input.tree === 'tree-b-r1') {
        ports.executor.pushEvent(runId, { kind: 'terminal', status: 'succeeded' });
      }
    });
    const cutoffAtMs = START_MS + 30_000;

    const result = await run(ports, { cutoffAtMs });

    const deliveryStartMs = Date.parse(ports.sink.ofType('delivery_step')[0]?.at ?? '');
    expect(deliveryStartMs - cutoffAtMs).toBeLessThanOrEqual(60_000);
    const cutoffStops = ports.sink.ofType('executor_stopped').filter((event) => event.purpose === 'cutoff');
    expect(cutoffStops.map((event) => event.taskId)).toEqual(['a']);
    const state = await ports.store.load('run-c');
    expect([state?.tasks['a']?.failReason, state?.tasks['b']?.failReason]).toEqual(['cutoff', 'cutoff']);
    expect(result.outcome).toBe('partial');

    await drive(ports.clock, ports.sleep(3_600_000));

    expect(ports.sink.ofType('stale_result_discarded').map((event) => [event.taskId, event.detail])).toEqual([
      ['b', 'the verdict of revision 1 arrived after the cutoff'],
    ]);
    expect(ports.sink.ofType('verdict')).toEqual([]);
  });

  test('an integration whose checks outlast the cutoff never advances main afterwards', async () => {
    const ports = hookedIntegration();
    const cancel = new AbortController();
    ports.checks.beforeIntegration = async () => {
      cancel.abort();
      await ports.sleep(60_000);
    };
    const mainBefore = await ports.workspace.mainCommit(SPEC.name);

    const result = await run(ports, { signal: cancel.signal });
    await drive(ports.clock, ports.sleep(3_600_000));

    expect((await ports.store.load('run-c'))?.tasks['only']?.failReason).toBe('cutoff');
    expect(ports.sink.ofType('main_advanced')).toEqual([]);
    expect(await ports.workspace.mainCommit(SPEC.name)).toBe(mainBefore);
    expect(result.outcome).toBe('partial');
  });

  test('an advance of main under way at the cutoff finishes before delivery and the task counts as integrated', async () => {
    const ports = hookedIntegration();
    const cancel = new AbortController();
    ports.workspace.beforeAdvance = async () => {
      cancel.abort();
      await ports.sleep(1_000);
    };

    await run(ports, { signal: cancel.signal });

    const state = await ports.store.load('run-c');
    expect(state?.tasks['only']?.state).toBe('integrated');
    const advancedAt = Date.parse(ports.sink.ofType('main_advanced')[0]?.at ?? '');
    const deliveryAt = Date.parse(ports.sink.ofType('delivery_step')[0]?.at ?? '');
    expect(advancedAt).toBeLessThanOrEqual(deliveryAt);
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
