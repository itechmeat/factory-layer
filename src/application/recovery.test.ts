import { describe, expect, test } from 'bun:test';

import type { RecoveryChoice, RunOptionsInput, RunState } from '../domain';
import type { CommandPostResult, ExecutorEvent } from '../ports';

import type { ReplanHook, ReplanRequest } from './run-context';
import { RunFactory, type RunFactoryHooks } from './run-factory';
import { aPlan, aSpec, aTask, cliCheck, drive, fakePorts, FakeExecutor, FakeStore, planOf, type FakePorts } from './testing';

const SPEC = aSpec();
const NODE_FAILED: ExecutorEvent = { kind: 'wake', seq: 1, trigger: 'node_failed', nodeId: 'code', detail: 'tests failed' };
const SUCCEEDED: ExecutorEvent = { kind: 'terminal', status: 'succeeded' };

function run(ports: FakePorts, options: RunOptionsInput = {}): ReturnType<RunFactory['run']> {
  return drive(ports.clock, new RunFactory(ports).run({ runId: 'run-r', spec: SPEC, options }));
}

/** Scripts the event list of each started run in start order; runs past the list succeed. */
function runsReport(ports: FakePorts, perRun: readonly (readonly ExecutorEvent[])[]): void {
  let index = 0;
  ports.executor.onStart((_input, runId) => {
    for (const event of perRun[index] ?? [SUCCEEDED]) {
      ports.executor.pushEvent(runId, event);
    }
    index += 1;
  });
}

function recoveryAnswers(ports: FakePorts, choices: readonly RecoveryChoice[]): void {
  for (const decision of choices) {
    ports.brain.script.recovery.answerWith({ decision });
  }
}

/** A store that keeps every saved state, to see intents that live only between two saves. */
class RecordingStore extends FakeStore {
  readonly saved: RunState[] = [];

  override async save(state: RunState): Promise<void> {
    await super.save(state);
    this.saved.push(structuredClone(state));
  }
}

describe('recovery', () => {
  test('a rebind on a live run persists each command step with its posted sequence and keeps waiting', async () => {
    const base = fakePorts();
    const ports = { ...base, store: new RecordingStore({ clock: base.clock }) };
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED, SUCCEEDED]]);
    recoveryAnswers(ports, [{ choice: 'rebind', profile: 'claude', hint: 'use the strong model' }]);

    const result = await run(ports);

    expect(ports.executor.commands.map((command) => [command.kind, command.postedSeq])).toEqual([
      ['append_context', 1],
      ['rebind_profile', 2],
      ['retry_node', 3],
    ]);
    const lastCommand = ports.store.saved
      .flatMap((state) => state.intents)
      .filter((intent) => intent.kind === 'command')
      .at(-1);
    expect(lastCommand).toMatchObject({
      choice: 'rebind',
      profile: 'claude',
      hint: 'use the strong model',
      steps: [
        { step: 'append_context', postedSeq: 1 },
        { step: 'rebind_node', postedSeq: 2 },
        { step: 'retry_node', postedSeq: 3 },
      ],
    });
    expect(ports.executor.starts).toHaveLength(1);
    expect(result.outcome).toBe('partial');
    expect((await ports.store.load('run-r'))?.tasks['only']).toEqual({ revision: 1, state: 'integrated', attemptsUsed: 2 });
  });

  test('a rebind to a profile other than claude becomes a repair run with the same hint', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED, SUCCEEDED], [SUCCEEDED]]);
    recoveryAnswers(ports, [{ choice: 'rebind', profile: 'codex', hint: 'try another agent' }]);

    await run(ports);

    expect(ports.executor.commands.map((command) => command.kind)).not.toContain('rebind_profile');
    const refused = ports.sink.events.find((event) => event.type === 'recovery_chosen' && event.choice === 'repair');
    expect(refused).toMatchObject({ detail: 'rebind to codex refused: only claude allowed' });
    expect(ports.executor.starts).toHaveLength(2);
    expect(JSON.stringify(ports.executor.starts[1]?.inputs)).toContain('try another agent');
  });

  test('a command step the executor does not take falls back to a stop and a repair run within the same attempt', async () => {
    const base = fakePorts();
    class RefusingExecutor extends FakeExecutor {
      override async retryNode(): Promise<CommandPostResult> {
        return { accepted: false, postedSeq: null };
      }
    }
    const ports = { ...base, executor: new RefusingExecutor({ clock: base.clock, sleep: base.sleep }) };
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED]]);
    recoveryAnswers(ports, [{ choice: 'retry', hint: 'try again' }]);

    await run(ports);

    expect(ports.sink.ofType('executor_stopped').map((event) => event.purpose)).toContain('recovery');
    expect(ports.executor.starts.map((start) => [start.playbook, start.dispatchKey])).toEqual([
      ['playbook-feature', 'run-r|only|r1|a1'],
      ['build-task', 'run-r|only|r1|a2'],
    ]);
    expect(ports.executor.starts[1]?.inputs.taskText).toContain('Hint: try again');
  });

  test('repair on a live run stops the run and confirms it before the repair run starts', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })], [cliCheck({ id: 'help' })]);
    runsReport(ports, [[NODE_FAILED]]);
    recoveryAnswers(ports, [{ choice: 'repair', failingCheckIds: ['help'] }]);

    await run(ports);

    const events = ports.sink.events.map((event) => (event.type === 'executor_stopped' ? `stopped:${event.purpose}` : event.type));
    expect(events.indexOf('stopped:recovery')).toBeLessThan(events.lastIndexOf('executor_started'));
    expect(ports.executor.starts[1]?.playbook).toBe('build-task');
    expect(ports.executor.starts[1]?.inputs.failingChecks).toEqual([
      {
        id: 'help',
        reason: 'failed; run from the package root: node <the bin entry named in package.json> "--help"; expected exit code 0',
      },
    ]);
  });

  test('a repair of a check the run does not define passes only the failure reason', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED]]);
    recoveryAnswers(ports, [{ choice: 'repair', failingCheckIds: ['package-bun-test'] }]);

    await run(ports);

    expect(ports.executor.starts[1]?.inputs.failingChecks).toEqual([{ id: 'package-bun-test', reason: 'failed' }]);
  });

  test('a repair after a finished run waits until the stop confirms the driver released the tree', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[{ kind: 'terminal', status: 'failed' }]]);
    ports.executor.onStart((_input, runId) => {
      if (runId === 'executor-run-1') {
        ports.executor.setStopOutcome(runId, { confirmed: true, delayMs: 30_000 });
      }
    });
    recoveryAnswers(ports, [{ choice: 'retry', hint: 'again' }]);

    await run(ports);

    const [first, repair] = ports.sink.ofType('executor_started');
    const release = ports.sink.ofType('executor_stopped')[0];
    expect(release?.purpose).toBe('release');
    expect(Date.parse(release?.at ?? '') - Date.parse(first?.at ?? '')).toBe(30_000);
    expect(Date.parse(repair?.at ?? '')).toBeGreaterThanOrEqual(Date.parse(release?.at ?? ''));
    expect(repair?.role).toBe('repair');
  });

  test('a finished run whose driver release is not confirmed blocks the repair and fails the task', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[{ kind: 'terminal', status: 'failed' }]]);
    ports.executor.onStart((_input, runId) => {
      ports.executor.setStopOutcome(runId, { confirmed: false });
    });
    recoveryAnswers(ports, [{ choice: 'repair', failingCheckIds: ['help'] }]);

    await run(ports);

    expect(ports.executor.starts).toHaveLength(1);
    expect((await ports.store.load('run-r'))?.tasks['only']?.failReason).toBe('stop_unconfirmed');
  });

  test('a rebind after the run finished starts a repair run with the hint and traces the downgrade', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[{ kind: 'terminal', status: 'aborted' }]]);
    recoveryAnswers(ports, [{ choice: 'rebind', profile: 'claude', hint: 'think harder' }]);

    await run(ports);

    expect(ports.sink.ofType('recovery_chosen').map((event) => event.choice)).toEqual(['rebind', 'repair']);
    expect(ports.executor.commands).toEqual([]);
    expect(ports.executor.starts[1]).toMatchObject({ playbook: 'build-task', inputs: { mode: 'repair' }, tree: 'tree-only-r1' });
    expect(ports.executor.starts[1]?.inputs.taskText).toContain('Hint: think harder');
  });

  test('spent attempts with the re-plan available go to the re-plan, which keeps the plan by default', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED]]);

    await run(ports, { taskAttemptBudget: 1 });

    expect(ports.brain.callsOf('recovery')).toEqual([]);
    expect(ports.sink.ofType('executor_stopped').map((event) => event.purpose)).toEqual(['replan']);
    expect(ports.sink.ofType('replan_started')).toHaveLength(1);
    const state = await ports.store.load('run-r');
    expect(state?.replansUsed).toBe(1);
    expect(state?.tasks['only']?.failReason).toBe('replan_unavailable');
  });

  test('a task that chooses replan on a live run is handed to the re-plan hook with its live run, which the re-plan stops', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED]]);
    recoveryAnswers(ports, [{ choice: 'replan' }]);
    const requests: ReplanRequest[] = [];
    const replan: ReplanHook = {
      async requestReplan(ctx, request) {
        requests.push(request);
        await ctx.owner.fail(request.taskId, 'replaced_by_test');
      },
    };
    const hooks: RunFactoryHooks = { replan };

    await drive(ports.clock, new RunFactory(ports, hooks).run({ runId: 'run-r', spec: SPEC }));

    expect(requests.map((request) => [request.taskId, request.failure.reason, request.lastRun?.state])).toEqual([
      ['only', 'node_failed', 'live'],
    ]);
  });

  test('spent attempts with the re-plan used fail the task and its dependants without a brain decision', async () => {
    const ports = fakePorts();
    planOf(ports, [
      aTask({ id: 'base', ownedPaths: ['src/base'] }),
      aTask({ id: 'top', dependsOn: ['base'] }),
      aTask({ id: 'side', ownedPaths: ['docs'] }),
    ]);
    ports.executor.onStart((input, runId) => {
      ports.executor.pushEvent(runId, input.tree === 'tree-base-r1' ? { kind: 'terminal', status: 'failed' } : SUCCEEDED);
    });

    const result = await run(ports, { taskAttemptBudget: 1, runReplanBudget: 0 });

    expect(ports.brain.callsOf('recovery')).toEqual([]);
    expect(ports.brain.callsOf('replan')).toEqual([]);
    const tasks = (await ports.store.load('run-r'))?.tasks;
    expect(tasks?.['base']?.failReason).toBe('budget_spent');
    expect(tasks?.['top']?.failReason).toBe('dependency_failed');
    expect(tasks?.['side']?.state).toBe('integrated');
    expect(result.outcome).toBe('partial');
  });

  test('a replan chosen with the re-plan budget spent is downgraded to a repair run and spends no re-plan', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED]]);
    recoveryAnswers(ports, [{ choice: 'replan' }]);

    await run(ports, { runReplanBudget: 0 });

    expect(ports.brain.callsOf('replan')).toEqual([]);
    expect(ports.sink.ofType('replan_started')).toEqual([]);
    expect(ports.sink.ofType('recovery_chosen').map((event) => event.choice)).toEqual(['replan', 'repair']);
    expect(ports.executor.starts[1]).toMatchObject({ playbook: 'build-task', inputs: { mode: 'repair' }, tree: 'tree-only-r1' });
    expect(ports.executor.starts[1]?.inputs.taskText).toContain('tests failed');
    const state = await ports.store.load('run-r');
    expect(state?.replansUsed).toBe(0);
    expect(state?.tasks['only']).toMatchObject({ revision: 1, state: 'integrated' });
  });

  test('give up on a live run stops the run and confirms it before the task fails', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED]]);
    recoveryAnswers(ports, [{ choice: 'give_up', reason: 'hopeless' }]);

    await run(ports);

    const types = ports.sink.events.map((event) => (event.type === 'executor_stopped' ? `stopped:${event.purpose}` : event.type));
    expect(types.indexOf('stopped:give_up')).toBeLessThan(types.lastIndexOf('task_state_changed'));
    expect((await ports.store.load('run-r'))?.tasks['only']?.failReason).toBe('given_up');
  });

  test('replan on a live run stops the run and confirms it before the re-plan decision', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED]]);
    recoveryAnswers(ports, [{ choice: 'replan' }]);
    ports.brain.script.replan.answerWith({ decision: aPlan([aTask({ id: 'only' })]) });

    await run(ports);

    const types = ports.sink.events.map((event) => (event.type === 'executor_stopped' ? `stopped:${event.purpose}` : event.type));
    const replanDecision = ports.sink.events.findIndex((event) => event.type === 'decision_started' && event.kind === 'replan');
    expect(types.indexOf('stopped:replan')).toBeLessThan(replanDecision);
    expect((await ports.store.load('run-r'))?.tasks['only']).toMatchObject({ revision: 2, state: 'integrated' });
  });

  test('spent attempts after the only re-plan of a budget of 1 was used fail the task without a decision', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.executor.onStart((_input, runId) => ports.executor.pushEvent(runId, { kind: 'terminal', status: 'failed' }));
    ports.brain.script.replan.answerWith({ decision: aPlan([aTask({ id: 'only' })]) });

    await run(ports, { taskAttemptBudget: 1, runReplanBudget: 1 });

    expect(ports.brain.callsOf('replan')).toHaveLength(1);
    expect(ports.brain.callsOf('recovery')).toEqual([]);
    expect((await ports.store.load('run-r'))?.tasks['only']).toMatchObject({ revision: 2, failReason: 'budget_spent' });
  });

  test('a run that succeeded but whose release is not confirmed keeps its succeeded state, marks its driver held, and is not judged', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[SUCCEEDED]]);
    ports.executor.onStart((_input, runId) => ports.executor.setStopOutcome(runId, { confirmed: false }));

    await run(ports);

    const state = await ports.store.load('run-r');
    expect(state?.runs['executor-run-1']).toMatchObject({ state: 'succeeded', driverHeld: true });
    expect(ports.brain.callsOf('judge')).toEqual([]);
    expect(state?.tasks['only']).toMatchObject({ state: 'failed', failReason: 'stop_unconfirmed' });
  });
});
