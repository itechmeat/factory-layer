import { describe, expect, test } from 'bun:test';

import type { TraceEvent } from '../domain';
import type { StartRunInput, StartRunResult } from '../ports';

import { RunFactory, type FactoryPorts, type RunRequest, type RunResult } from '.';
import { aPlan, aSpec, aTask, cliCheck, drive, FakeExecutor, fakePorts, FakeSink, planOf, succeedRuns, type FakePorts } from './testing';

const SPEC = aSpec();

/** Runs one request on the ports, driving the fake clock to the end. */
function runOn(ports: FactoryPorts & Pick<FakePorts, 'clock'>, request: RunRequest): Promise<RunResult> {
  return drive(ports.clock, new RunFactory(ports).run(request));
}

/** True when the two decision intervals share an instant span: each starts before the other ends. */
function overlap(sink: FakeSink, a: string, b: string): boolean {
  const first = sink.decisionInterval(a);
  const second = sink.decisionInterval(b);
  if (first === null || second === null) {
    throw new Error(`missing decision interval for ${a} or ${b}`);
  }
  return Date.parse(first.start) < Date.parse(second.end) && Date.parse(second.start) < Date.parse(first.end);
}

/** The id of the first decision of the kind (and task, when given). */
function decisionId(events: readonly TraceEvent[], kind: string, taskId?: string): string {
  const started = events.find(
    (event) => event.type === 'decision_started' && event.kind === kind && (taskId === undefined || event.taskId === taskId),
  );
  if (started?.decisionId === undefined) {
    throw new Error(`no ${kind} decision${taskId === undefined ? '' : ` for ${taskId}`}`);
  }
  return started.decisionId;
}

/** Scripts the three-task plan: scaffold first (listed last), then api and cli in parallel. */
function scriptThreeTasks(ports: FakePorts): void {
  const scaffold = aTask({ id: 'scaffold', playbook: 'scaffold', ownedPaths: ['package.json', 'src/index.ts'] });
  const api = aTask({ id: 'api', playbook: 'implement-task', ownedPaths: ['src/api'], dependsOn: ['scaffold'] });
  const cli = aTask({ id: 'cli', playbook: 'implement-task', ownedPaths: ['src/cli'], dependsOn: ['scaffold'] });
  ports.brain.script.plan.answerWith({ decision: aPlan([api, cli, scaffold]), delayMs: 100 });
  ports.brain.script.acceptance.answerWith({ decision: [cliCheck({ id: 'help' })], delayMs: 100 });
  ports.brain.script.judge.defaultAnswer({ decision: { outcome: 'accept' }, delayMs: 100 });
  ports.brain.script.recovery.answerWith({ decision: { choice: 'retry', hint: 'run the unit tests before finishing' }, delayMs: 50 });
  ports.workspace.queueIntegration(SPEC.name, 'cli', 1, { outcome: 'conflict', paths: ['src/index.ts'] });
  ports.workspace.queueIntegration(SPEC.name, 'cli', 1, { outcome: 'ok' });
  ports.executor.onStart((input, runId) => {
    if (input.playbook === 'scaffold') {
      ports.executor.pushEvent(runId, { kind: 'wake', seq: 1, trigger: 'node_failed', nodeId: 'code', detail: 'unit tests failed' });
    }
    if (input.playbook === 'integrate') {
      ports.workspace.markResolved(input.tree);
    }
    ports.executor.pushEvent(runId, { kind: 'terminal', status: 'succeeded' });
  });
}

describe('RunFactory end to end on fakes', () => {
  test('a three-task plan listed out of order with one live recovery and one conflict reaches succeeded', async () => {
    const ports = fakePorts();
    scriptThreeTasks(ports);

    const result = await drive(
      ports.clock,
      new RunFactory(ports).run({ runId: 'run-e2e', spec: SPEC, options: { outDir: 'out/todo-cli' } }),
    );

    expect(result).toEqual({ runId: 'run-e2e', outcome: 'succeeded', reason: null, deliveredDir: 'out/todo-cli', verified: true });
    const events = ports.sink.events;
    expect(overlap(ports.sink, decisionId(events, 'plan'), decisionId(events, 'acceptance'))).toBe(true);
    expect(overlap(ports.sink, decisionId(events, 'judge', 'api'), decisionId(events, 'judge', 'cli'))).toBe(true);

    const starts = ports.sink.ofType('executor_started').map((event) => `${event.taskId}:${event.role}`);
    expect(starts[0]).toBe('scaffold:task');
    expect(starts).toContain('cli:integrate');
    expect(ports.executor.commands.map((command) => command.kind)).toEqual(['append_context', 'retry_node']);
    expect(ports.sink.ofType('merge_conflict').map((event) => event.taskId)).toEqual(['cli']);
    expect(ports.sink.ofType('main_advanced').map((event) => event.taskId)).toEqual(['scaffold', 'api', 'cli']);

    const state = await ports.store.load('run-e2e');
    expect(state?.outcome).toBe('succeeded');
    expect(state?.intents).toEqual([]);
    expect(state?.tasks).toEqual({
      api: { revision: 1, state: 'integrated', attemptsUsed: 1 },
      cli: { revision: 1, state: 'integrated', attemptsUsed: 2 },
      scaffold: { revision: 1, state: 'integrated', attemptsUsed: 2 },
    });
    expect(ports.workspace.deliveries).toHaveLength(1);
    expect(ports.memory.remembered[0]?.outcome).toBe('succeeded');
    expect(ports.slots.liveCount()).toBe(0);
  });
});

describe('RunFactory failure paths', () => {
  test('remembering the outcome fails: the run keeps its outcome and the trace records the memory failure', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })], [cliCheck({ id: 'help' })]);
    succeedRuns(ports);
    ports.memory.failRemember(1);

    const result = await runOn(ports, { runId: 'run-m', spec: SPEC });

    expect(result.outcome).toBe('succeeded');
    expect(ports.sink.ofType('memory_failed').map((event) => event.phase)).toEqual(['remember']);
    expect(ports.sink.events.at(-1)?.type).toBe('memory_failed');
  });

  test('a state that cannot be saved during execution stops the live runs and fails the run', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.executor.onStart(() => {
      ports.store.failSaves(1000);
    });

    const result = await runOn(ports, { runId: 'run-x', spec: SPEC });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('storage_failed');
    expect(ports.sink.ofType('executor_stopped')).toHaveLength(1);
    expect(ports.sink.ofType('executor_stopped')[0]).toMatchObject({
      executorRunId: 'executor-run-1',
      purpose: 'storage',
      confirmed: true,
    });
    expect(ports.sink.ofType('storage_failed')).toHaveLength(1);
    expect(ports.executor.runs.get('executor-run-1')?.status).toBe('stopped');
    expect(ports.sink.ofType('run_ended')[0]?.outcome).toBe('failed');
    expect(ports.slots.liveCount()).toBe(0);
  });

  test('supervisor tokens and configured secrets never reach the trace, and the secrets never reach the saved state', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.executor.startWith({ outcome: 'ok', supervisorToken: 'sentinel-token' });
    ports.executor.onStart((_input, runId) => {
      ports.executor.pushEvent(runId, {
        kind: 'wake',
        seq: 1,
        trigger: 'node_finished',
        nodeId: 'code',
        detail: 'used sentinel-token and hunter2',
      });
      ports.executor.pushEvent(runId, { kind: 'terminal', status: 'succeeded' });
    });

    await drive(ports.clock, new RunFactory(ports, { secrets: ['hunter2'] }).run({ runId: 'run-t', spec: SPEC }));

    expect(ports.store.snapshot()).not.toContain('hunter2');
    const trace = JSON.stringify(ports.sink.events);
    expect(trace).not.toContain('sentinel-token');
    expect(trace).not.toContain('hunter2');
    expect(trace).toContain('[redacted]');
  });

  test('a storage failure while a start is in flight settles the start: the run it created is found and stopped, and its slot freed', async () => {
    const base = fakePorts();
    /** Creates a's run at once but answers 5 s later; b's start answers after 1 s, when the state stops saving. */
    class LateAnswerExecutor extends FakeExecutor {
      override async startRun(input: StartRunInput): Promise<StartRunResult> {
        const answer = await super.startRun(input);
        await base.sleep(input.tree === 'tree-a-r1' ? 5000 : 1000);
        if (input.tree !== 'tree-a-r1') {
          base.store.failSaves(1000);
        }
        return answer;
      }
    }
    const ports = { ...base, executor: new LateAnswerExecutor({ clock: base.clock, sleep: base.sleep }) };
    planOf(ports, [aTask({ id: 'a', ownedPaths: ['src/a'] }), aTask({ id: 'b', ownedPaths: ['src/b'] })]);

    const result = await runOn(ports, { runId: 'run-y', spec: SPEC });

    expect(result.reason).toContain('storage_failed');
    expect([...ports.executor.runs.values()].map((run) => [run.tree, run.status])).toEqual([
      ['tree-a-r1', 'stopped'],
      ['tree-b-r1', 'stopped'],
    ]);
    expect(ports.slots.liveCount()).toBe(0);
  });

  test('an unexpected error in a task runner stops its live run and frees its lease before the task fails', async () => {
    const base = fakePorts();
    class OnceBrokenSink extends FakeSink {
      private broken = false;

      override emit(event: TraceEvent): void {
        if (event.type === 'executor_event' && !this.broken) {
          this.broken = true;
          throw new Error('sink write failed');
        }
        super.emit(event);
      }
    }
    const ports = { ...base, sink: new OnceBrokenSink() };
    planOf(ports, [aTask({ id: 'only' })]);
    ports.executor.onStart((_input, runId) => {
      ports.executor.pushEvent(runId, { kind: 'wake', seq: 1, trigger: 'node_finished', nodeId: 'code', detail: null });
    });

    await runOn(ports, { runId: 'run-e', spec: SPEC });

    expect(ports.executor.runs.get('executor-run-1')?.status).toBe('stopped');
    const state = await ports.store.load('run-e');
    expect(state?.tasks['only']?.failReason).toContain('internal_error');
    expect(state?.runs['executor-run-1']?.state).toBe('stopped');
    expect(ports.slots.liveCount()).toBe(0);
  });

  test('a state change is saved before its trace event: the cursor of an executor event is already stored when the event is traced', async () => {
    const base = fakePorts();
    const cursors: (number | undefined)[] = [];
    class CheckingSink extends FakeSink {
      override emit(event: TraceEvent): void {
        if (event.type === 'executor_event' && event.kind === 'wake') {
          void base.store.load('run-o').then((state) => cursors.push(state?.runs['executor-run-1']?.cursor));
        }
        super.emit(event);
      }
    }
    const ports = { ...base, sink: new CheckingSink() };
    planOf(ports, [aTask({ id: 'only' })]);
    ports.executor.onStart((_input, runId) => {
      ports.executor.pushEvent(runId, { kind: 'wake', seq: 5, trigger: 'node_finished', nodeId: 'code', detail: null });
      ports.executor.pushEvent(runId, { kind: 'terminal', status: 'succeeded' });
    });

    await runOn(ports, { runId: 'run-o', spec: SPEC });

    expect(cursors).toEqual([5]);
  });
});

describe('run end', () => {
  test('a trace sink that refuses run_ended does not lose the run result', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    succeedRuns(ports);
    const emit = ports.sink.emit.bind(ports.sink);
    ports.sink.emit = (event) => {
      if (event.type === 'run_ended') {
        throw new Error('sink closed');
      }
      emit(event);
    };

    const result = await runOn(ports, { runId: 'run-e', spec: SPEC });

    expect(result.outcome).toBe('partial');
    expect(ports.memory.remembered.map((record) => record.outcome)).toEqual(['partial']);
  });
});
