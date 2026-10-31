import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  DispatchRequestSchema,
  EXECUTOR_SETTLE_WINDOW_MS,
  RunOptionsSchema,
  RunStateSchema,
  resolveRunLimits,
  topologicalOrder,
  type Plan,
  type RunIntent,
  type RunOptionsInput,
} from '../domain';

import { WorkspaceError, type TaskTree } from '../ports';

import { RunFactory } from '.';
import { Decider } from './decide';
import { dispatchRun, requestOf, requestRecord } from './dispatch';
import { IntegrationQueue } from './integration-queue';
import { serializedReplan } from './replan';
import type { RunContext } from './run-context';
import { RunOwner } from './run-owner';
import { RunSlots } from './run-slots';
import { RunTrace } from './run-trace';
import { taskRequest } from './task-inputs';
import {
  aPlan,
  aRunState,
  aSpec,
  aTask,
  drive,
  fakePorts,
  FakeSlots,
  FakeWorkspace,
  planOf,
  SlotRecordingSink,
  succeedRuns,
  type FakePorts,
} from './testing';

const SPEC = aSpec();

function run(ports: FakePorts, options: RunOptionsInput = {}, runId = 'run-d'): ReturnType<RunFactory['run']> {
  return new RunFactory(ports).run({ runId, spec: SPEC, options });
}

/** A run context over the fakes for one plan, as RunFactory builds it after planning. */
function contextOn(ports: FakePorts, plan: Plan): RunContext {
  const options = RunOptionsSchema.parse({});
  const limits = resolveRunLimits(options);
  const trace = new RunTrace({ sink: ports.sink, clock: ports.clock, runId: 'run-ctx', specName: SPEC.name, secrets: [] });
  const controller = new AbortController();
  const state = RunStateSchema.parse({
    ...aRunState({ runId: 'run-ctx', plan }),
    tasks: Object.fromEntries(plan.tasks.map((task) => [task.id, { revision: 1, state: 'ready', attemptsUsed: 0 }])),
  });
  return {
    ports,
    owner: new RunOwner({ state, store: ports.store, trace, onStorageFailure: () => controller.abort() }),
    trace,
    decider: new Decider({
      trace,
      sleep: ports.sleep,
      costs: ports.costs,
      deadlineMs: limits.brainDecisionDeadlineMs,
      signal: controller.signal,
    }),
    limits,
    slots: new RunSlots({ cap: limits.runTaskConcurrency, global: ports.slots, runId: 'run-ctx' }),
    leases: new Map(),
    signal: controller.signal,
    cutoff: new AbortController(),
    history: new Map(),
    lastChecks: new Map(),
    integrations: new IntegrationQueue(topologicalOrder(plan)),
    replan: serializedReplan,
    runners: new Map(),
    work: new Map(),
  };
}

describe('persisted requests', () => {
  test('a request keeps its mode through the record a resume restarts from', () => {
    const request = {
      taskId: 'core',
      role: 'repair' as const,
      playbook: 'build-task',
      inputs: { taskText: 'fix it', mode: 'repair' as const, ownedPaths: ['src/core.ts'], failingChecks: [{ id: 'c1', reason: 'exit 1' }] },
    };
    const record = DispatchRequestSchema.parse(JSON.parse(JSON.stringify(requestRecord(request))));
    expect(requestOf(record)).toEqual(request);
  });
});

describe('dispatch', () => {
  test('a dependant listed first is dispatched after its dependency is integrated', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'b', dependsOn: ['a'] }), aTask({ id: 'a' })]);
    succeedRuns(ports);

    await drive(ports.clock, run(ports));

    expect(ports.executor.starts.map((start) => start.dispatchKey)).toEqual(['run-d|a|r1|a1', 'run-d|b|r1|a1']);
    const integratedA = ports.sink.events.findIndex(
      (event) => event.type === 'task_state_changed' && event.taskId === 'a' && event.to === 'integrated',
    );
    const startedB = ports.sink.events.findIndex((event) => event.type === 'executor_started' && event.taskId === 'b');
    expect(integratedA).toBeLessThan(startedB);
  });

  test('five ready tasks under a run cap of 3 keep exactly 3 executor runs live until one finishes', async () => {
    const ports = fakePorts();
    const tasks = ['t1', 't2', 't3', 't4', 't5'].map((id) => aTask({ id, ownedPaths: [`src/${id}`] }));
    planOf(ports, tasks);
    succeedRuns(ports, { when: (input) => input.tree === 'tree-t1-r1' });
    succeedRuns(ports, { afterMs: 1000, when: (input) => input.tree !== 'tree-t1-r1' });

    await drive(ports.clock, run(ports, { runTaskConcurrency: 3 }));

    let live = 0;
    let maxLive = 0;
    let liveAtFourthStart = -1;
    for (const event of ports.sink.events) {
      if (event.type === 'executor_started') {
        if (event.taskId === 't4') {
          liveAtFourthStart = live;
        }
        live += 1;
        maxLive = Math.max(maxLive, live);
      }
      if (event.type === 'executor_stopped' && event.confirmed) {
        live -= 1;
      }
    }
    expect(maxLive).toBe(3);
    expect(liveAtFourthStart).toBe(2);
    expect(ports.sink.ofType('executor_started')).toHaveLength(5);
  });

  test('two runs in one process never hold more than the shared cap of 4 executor runs', async () => {
    const shared = fakePorts();
    const slots = new FakeSlots({ cap: 4, sleep: shared.sleep });
    const sink = new SlotRecordingSink(slots);
    const first = { ...fakePorts({ clock: shared.clock, sleep: shared.sleep, slots }), sink };
    const second = { ...fakePorts({ clock: shared.clock, sleep: shared.sleep, slots }), sink };
    for (const ports of [first, second]) {
      planOf(
        ports,
        ['x1', 'x2', 'x3'].map((id) => aTask({ id, ownedPaths: [`src/${id}`] })),
      );
      succeedRuns(ports, { afterMs: 1000 });
    }

    const results = await drive(shared.clock, Promise.all([run(first, {}, 'run-one'), run(second, {}, 'run-two')]));

    expect(results.map((result) => result.outcome)).toEqual(['partial', 'partial']);
    expect(sink.maxLive()).toBe(4);
    expect(slots.liveCount()).toBe(0);
  });

  test('the start intent with the dispatch key is saved before the run starts, the mapping after', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    const intentsAtStart: RunIntent[] = [];
    ports.executor.onStart(() => {
      const stored = z.record(z.string(), RunStateSchema).parse(JSON.parse(ports.store.snapshot()));
      intentsAtStart.push(...(stored['run-d']?.intents ?? []));
    });
    succeedRuns(ports);

    await drive(ports.clock, run(ports));

    expect(intentsAtStart).toHaveLength(1);
    expect(intentsAtStart[0]).toMatchObject({
      kind: 'start',
      dispatchKey: 'run-d|only|r1|a1',
      playbook: 'playbook-feature',
      tree: 'tree-only-r1',
    });
    const state = await ports.store.load('run-d');
    expect(state?.runs['executor-run-1']).toMatchObject({
      dispatchKey: 'run-d|only|r1|a1',
      supervisorToken: 'token-1',
      tree: 'tree-only-r1',
    });
  });

  test('dispatching the same task, revision and attempt twice starts one executor run', async () => {
    const ports = fakePorts();
    const plan = aPlan([aTask({ id: 'only' })]);
    const ctx = contextOn(ports, plan);
    await ctx.owner.save();

    const first = await drive(ports.clock, dispatchRun(ctx, taskRequest(ctx, 'only'), await ctx.slots.acquire(ctx.signal)));
    const second = await drive(ports.clock, dispatchRun(ctx, taskRequest(ctx, 'only'), await ctx.slots.acquire(ctx.signal)));

    expect(first).toEqual({ kind: 'started', executorRunId: 'executor-run-1' });
    expect(second).toEqual(first);
    expect(ports.executor.starts).toHaveLength(1);
    expect(ctx.slots.freeLocal()).toBe(ctx.limits.runTaskConcurrency - 1);
  });

  test('a lost start answer whose run appears 30 s later is stopped as an orphan before the replacement starts', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only', playbook: 'build-task' })]);
    ports.executor.startWith({ outcome: 'indeterminate', detail: 'answer lost' });
    ports.executor.appearLater({ runId: 'late-run', playbook: 'build-task', tree: 'tree-only-r1' }, 30_000);
    succeedRuns(ports);

    const result = await drive(ports.clock, run(ports));

    expect(ports.sink.ofType('orphan_found').map((event) => event.executorRunId)).toEqual(['late-run']);
    const order = ports.sink.events
      .filter((event) => event.type === 'executor_stopped' || event.type === 'executor_started')
      .map((event) => `${event.type}:${event.executorRunId}`);
    expect(order.slice(0, 3)).toEqual(['executor_started:late-run', 'executor_stopped:late-run', 'executor_started:executor-run-2']);
    const replacement = ports.executor.starts[1];
    expect(replacement?.dispatchKey).toBe('run-d|only|r2|a1');
    expect(replacement?.tree).toBe('tree-only-r2');
    expect(result.outcome).toBe('partial');
    expect((await ports.store.load('run-d'))?.tasks['only']).toEqual({ revision: 2, state: 'integrated', attemptsUsed: 1 });
  });

  test('a lost start whose run never appears is dispatched again after the settle window as a new revision in a new tree', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.executor.startWith({ outcome: 'indeterminate', detail: 'answer lost' });
    succeedRuns(ports);

    await drive(ports.clock, run(ports));

    const starts = ports.executor.starts;
    expect(starts.map((start) => start.tree)).toEqual(['tree-only-r1', 'tree-only-r2']);
    const second = ports.sink.ofType('executor_started')[0];
    expect(Date.parse(second?.at ?? '')).toBeGreaterThanOrEqual(Date.parse(ports.sink.events[0]?.at ?? '') + EXECUTOR_SETTLE_WINDOW_MS);
    expect((await ports.store.load('run-d'))?.tasks['only']?.attemptsUsed).toBe(1);
  });

  test('a lost start of an integrate run is never replaced in a fresh tree and nothing is integrated', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.workspace.queueIntegration(SPEC.name, 'only', 1, { outcome: 'conflict', paths: ['src/index.ts'] });
    ports.workspace.queueIntegration(SPEC.name, 'only', 1, { outcome: 'ok' });
    ports.executor.startWith({ outcome: 'ok' });
    ports.executor.startWith({ outcome: 'indeterminate', detail: 'answer lost' });
    succeedRuns(ports);

    await drive(ports.clock, run(ports));

    expect(ports.executor.starts.map((start) => start.tree)).toEqual(['tree-only-r1', 'tree-only-r1']);
    expect(ports.sink.ofType('main_advanced')).toEqual([]);
    expect((await ports.store.load('run-d'))?.tasks['only']).toMatchObject({ state: 'failed', failReason: 'start_lost' });
  });

  test('a cutoff while a lost start is settled starts no replacement and frees the slot', async () => {
    const base = fakePorts();
    const ports = { ...base, sink: new SlotRecordingSink(base.slots) };
    planOf(ports, [aTask({ id: 'only' })]);
    base.executor.startWith({ outcome: 'indeterminate', detail: 'answer lost' });
    succeedRuns(base);
    const startMs = base.clock.now().getTime();

    await drive(base.clock, new RunFactory(ports).run({ runId: 'run-d', spec: SPEC, cutoffAtMs: startMs + 60_000 }));

    expect(base.executor.starts).toHaveLength(1);
    expect(ports.sink.liveCounts.find((entry) => entry.type === 'delivery_done')?.live).toBe(0);
    expect((await base.store.load('run-d'))?.abandonedTrees.map((entry) => entry.tree)).toEqual(['tree-only-r1']);
  });

  test('a start still in flight at the cutoff does not hold delivery back, and the run it creates is stopped before the slot is freed', async () => {
    const base = fakePorts();
    const ports = { ...base, sink: new SlotRecordingSink(base.slots) };
    planOf(ports, [aTask({ id: 'only', playbook: 'build-task' })]);
    base.executor.startWith({ outcome: 'ok', runId: 'slow-run', delayMs: 90_000 });
    succeedRuns(base);
    const startMs = base.clock.now().getTime();

    await drive(base.clock, new RunFactory(ports).run({ runId: 'run-d', spec: SPEC, cutoffAtMs: startMs + 70_000 }));

    expect(base.executor.runs.get('slow-run')?.status).toBe('stopped');
    const stored = await base.store.load('run-d');
    expect(stored?.intents.filter((intent) => intent.kind === 'start')).toEqual([]);
    expect(ports.sink.liveCounts.find((entry) => entry.type === 'delivery_done')?.live).toBe(1);
    expect(base.slots.liveCount()).toBe(0);
  });

  test('a start in flight at the cutoff whose answer is lost is settled by lookup after delivery began and the late run is stopped', async () => {
    const base = fakePorts();
    const ports = { ...base, sink: new SlotRecordingSink(base.slots) };
    planOf(ports, [aTask({ id: 'only', playbook: 'build-task' })]);
    base.executor.startWith({ outcome: 'indeterminate', detail: 'answer lost', delayMs: 90_000 });
    base.executor.appearLater({ runId: 'late-run', playbook: 'build-task', tree: 'tree-only-r1' }, 100_000);
    const startMs = base.clock.now().getTime();

    await drive(base.clock, new RunFactory(ports).run({ runId: 'run-d', spec: SPEC, cutoffAtMs: startMs + 70_000 }));

    expect(base.executor.runs.get('late-run')?.status).toBe('stopped');
    expect(base.executor.starts).toHaveLength(1);
    const stored = await base.store.load('run-d');
    expect(stored?.intents.filter((intent) => intent.kind === 'start')).toEqual([]);
    expect(ports.sink.liveCounts.find((entry) => entry.type === 'delivery_done')?.live).toBe(1);
    expect(base.slots.liveCount()).toBe(0);
  });

  test('an orphan whose stop is not confirmed fails the task and keeps its slot until the run ends', async () => {
    const ports = fakePorts();
    const sink = new SlotRecordingSink(ports.slots);
    const recorded = { ...ports, sink };
    planOf(recorded, [aTask({ id: 'only', playbook: 'build-task' })]);
    ports.executor.startWith({ outcome: 'indeterminate', detail: 'answer lost' });
    ports.executor.appearLater({ runId: 'late-run', playbook: 'build-task', tree: 'tree-only-r1' }, 0);
    ports.executor.setStopOutcome('late-run', { confirmed: false });

    const result = await drive(ports.clock, run(recorded));

    expect(result.outcome).toBe('partial');
    expect((await ports.store.load('run-d'))?.tasks['only']).toMatchObject({ state: 'failed', failReason: 'orphan_unconfirmed' });
    expect(ports.executor.starts).toHaveLength(1);
    const deliveryLive = sink.liveCounts.find((entry) => entry.type === 'delivery_done');
    expect(deliveryLive?.live).toBe(1);
    expect(ports.slots.liveCount()).toBe(0);
  });

  test('a refused start fails the task with executor_refused and the policy, with no lookup and no other run', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.executor.startWith({ outcome: 'refused', policy: 'untrusted_playbook', detail: 'the playbook is not trusted' });

    const result = await drive(ports.clock, run(ports));

    expect(result.outcome).toBe('partial');
    expect(ports.executor.starts).toHaveLength(1);
    expect(ports.sink.ofType('orphan_found')).toEqual([]);
    expect(ports.brain.callsOf('recovery')).toEqual([]);
    expect((await ports.store.load('run-d'))?.tasks['only']?.failReason).toBe('executor_refused: untrusted_playbook');
  });

  test('a task tree that cannot be created fails the task and frees its slot', async () => {
    class BrokenWorkspace extends FakeWorkspace {
      override async taskTree(): Promise<TaskTree> {
        throw new WorkspaceError({ command: 'git worktree add', exitCode: 128, stderrTail: 'disk full' });
      }
    }
    const base = fakePorts();
    const ports = { ...base, workspace: new BrokenWorkspace(), sink: new SlotRecordingSink(base.slots) };
    planOf(ports, [aTask({ id: 'only' })]);

    const result = await drive(ports.clock, run(ports));

    expect(result.outcome).toBe('partial');
    expect((await ports.store.load('run-d'))?.tasks['only']?.failReason).toContain('internal_error');
    expect(ports.sink.liveCounts.find((entry) => entry.type === 'delivery_done')?.live).toBe(0);
  });
});
