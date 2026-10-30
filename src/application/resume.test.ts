import { describe, expect, test } from 'bun:test';

import type { RecoveryChoice, RunOptionsInput, RunState } from '../domain';
import type { ExecutorEvent } from '../ports';

import { RunFactory, type RunResult } from '.';
import { aPlan, aSpec, aTask, crashingPorts, drive, fakePorts, planOf, restartedPorts, type CrashPoint, type FakePorts } from './testing';

const SPEC = aSpec();
const RUN_ID = 'run-z';
const NODE_FAILED: ExecutorEvent = { kind: 'wake', seq: 1, trigger: 'node_failed', nodeId: 'code', detail: 'tests failed' };
const SUCCEEDED: ExecutorEvent = { kind: 'terminal', status: 'succeeded' };

/** Runs until the crash point, freezes that process, and resumes the run in a fresh one over the same world. */
async function crashThenResume(
  ports: FakePorts,
  point: CrashPoint,
  options: RunOptionsInput = {},
): Promise<{ readonly result: RunResult; readonly resumed: FakePorts }> {
  const crash = crashingPorts(ports, point);
  const first = new RunFactory(crash.ports).run({ runId: RUN_ID, spec: SPEC, options });
  await drive(
    ports.clock,
    Promise.race([
      crash.crashed,
      first.then(() => {
        throw new Error('the run ended before the crash point');
      }),
    ]),
  );
  const resumed = restartedPorts(ports);
  const result = await drive(ports.clock, new RunFactory(resumed).resume(RUN_ID));
  return { result, resumed };
}

/** Scripts the events of each started run in start order; runs past the list succeed at once. */
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

function at(when: CrashPoint['when'], matches: (state: RunState) => boolean): CrashPoint {
  return { when, matches };
}

const commandSteps = (state: RunState): { readonly step: string; readonly postedSeq?: number | undefined }[] =>
  state.intents.flatMap((intent) => (intent.kind === 'command' ? intent.steps : []));

async function stored(ports: FakePorts): Promise<RunState | null> {
  return ports.store.load(RUN_ID);
}

describe('resume from a start intent', () => {
  test('a start without its mapping is found by its tree, stopped as an orphan, and only then replaced', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, []);
    const point = at('before', (state) => Object.keys(state.runs).length > 0);

    const { result, resumed } = await crashThenResume(ports, point);

    expect(resumed.sink.ofType('orphan_found').map((event) => event.executorRunId)).toEqual(['executor-run-1']);
    const types = resumed.sink.events.map((event) => (event.type === 'executor_stopped' ? `stopped:${event.purpose}` : event.type));
    expect(types.indexOf('stopped:orphan')).toBeLessThan(types.indexOf('executor_started', types.indexOf('stopped:orphan')));
    expect(ports.executor.starts.map((start) => start.dispatchKey)).toEqual([`${RUN_ID}|only|r1|a1`, `${RUN_ID}|only|r2|a1`]);
    expect(result.outcome).toBe('partial');
    expect((await stored(ports))?.tasks['only']).toEqual({ revision: 2, state: 'integrated', attemptsUsed: 1 });
  });

  test('a start whose run never appeared is dispatched again as a new revision in a new tree after the settle window', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, []);
    const point = at('after', (state) => state.intents.some((intent) => intent.kind === 'start'));

    await crashThenResume(ports, point);

    expect(ports.executor.starts.map((start) => start.tree)).toEqual(['tree-only-r2']);
    const state = await stored(ports);
    expect(state?.abandonedTrees.map((tree) => tree.tree)).toEqual(['tree-only-r1']);
    expect(state?.tasks['only']).toEqual({ revision: 2, state: 'integrated', attemptsUsed: 1 });
  });
});

describe('resume of live work', () => {
  test('a live run is re-attached and waited on after its persisted cursor; no new run starts', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [
      [
        { kind: 'wake', seq: 4, trigger: 'node_finished', nodeId: 'plan', detail: null },
        { kind: 'wake', seq: 7, trigger: 'node_finished', nodeId: 'code', detail: null },
        SUCCEEDED,
      ],
    ]);
    const point = at('after', (state) => state.runs['executor-run-1']?.cursor === 7);

    const { result, resumed } = await crashThenResume(ports, point);

    expect(ports.executor.starts).toHaveLength(1);
    expect(resumed.sink.ofType('executor_event').map((event) => event.kind)).toEqual(['terminal']);
    expect(result.outcome).toBe('partial');
    expect((await stored(ports))?.tasks['only']?.state).toBe('integrated');
  });

  test('a run that finished successfully before the crash is judged on resume', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[SUCCEEDED]]);
    const point = at('after', (state) => state.runs['executor-run-1']?.state === 'succeeded');

    const { resumed } = await crashThenResume(ports, point);

    expect(resumed.sink.ofType('verdict').map((event) => event.taskId)).toEqual(['only']);
    expect(ports.executor.starts).toHaveLength(1);
    expect((await stored(ports))?.tasks['only']?.state).toBe('integrated');
  });

  test('a run that ended failed before the crash is sent to recovery on resume', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[{ kind: 'terminal', status: 'failed' }]]);
    recoveryAnswers(ports, [{ choice: 'retry', hint: 'again' }]);
    const point = at('after', (state) => state.runs['executor-run-1']?.state === 'failed');

    await crashThenResume(ports, point);

    expect(ports.brain.callsOf('recovery')[0]?.args['failure']).toMatchObject({ reason: 'run_failed' });
    expect(ports.executor.starts.map((start) => [start.playbook, start.dispatchKey])).toEqual([
      ['playbook-feature', `${RUN_ID}|only|r1|a1`],
      ['repair', `${RUN_ID}|only|r1|a2`],
    ]);
  });
});

describe('resume of a command intent', () => {
  test('a crash between the context append and the retry posts the retry within the same attempt', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED, SUCCEEDED]]);
    recoveryAnswers(ports, [{ choice: 'retry', hint: 'again' }]);
    const point = at('after', (state) => commandSteps(state)[0]?.postedSeq !== undefined);

    await crashThenResume(ports, point);

    expect(ports.executor.commands.map((command) => [command.kind, command.postedSeq])).toEqual([
      ['append_context', 1],
      ['retry_node', 2],
    ]);
    expect(ports.executor.starts).toHaveLength(1);
    expect((await stored(ports))?.tasks['only']).toEqual({ revision: 1, state: 'integrated', attemptsUsed: 2 });
  });

  test('a crash between the rebind and the retry posts only the retry', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED, SUCCEEDED]]);
    recoveryAnswers(ports, [{ choice: 'rebind', profile: 'strong', hint: 'think' }]);
    const point = at('after', (state) => commandSteps(state)[1]?.postedSeq !== undefined);

    await crashThenResume(ports, point);

    expect(ports.executor.commands.map((command) => command.kind)).toEqual(['append_context', 'rebind_profile', 'retry_node']);
    expect((await stored(ports))?.tasks['only']).toEqual({ revision: 1, state: 'integrated', attemptsUsed: 2 });
  });

  test('a retry posted without its saved sequence is not posted again: the run is stopped and one repair run starts with the hint', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED]]);
    recoveryAnswers(ports, [{ choice: 'retry', hint: 'use the cache' }]);
    const point = at('before', (state) => commandSteps(state)[1]?.postedSeq !== undefined);

    const { resumed } = await crashThenResume(ports, point);

    expect(ports.executor.commands.map((command) => command.kind)).toEqual(['append_context', 'retry_node']);
    const stops = resumed.sink.ofType('executor_stopped').filter((event) => event.purpose !== 'release');
    expect(stops.map((event) => [event.executorRunId, event.purpose])).toEqual([['executor-run-1', 'recovery']]);
    expect(ports.executor.starts.map((start) => start.dispatchKey)).toEqual([`${RUN_ID}|only|r1|a1`, `${RUN_ID}|only|r1|a2`]);
    expect(ports.executor.starts[1]?.inputs.taskText).toContain('Hint: use the cache');
    expect((await stored(ports))?.tasks['only']).toEqual({ revision: 1, state: 'integrated', attemptsUsed: 2 });
  });
});

describe('resume of stop intents', () => {
  test('a crash after the stop for a repair was confirmed starts the repair run and does not judge the stopped run', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED]]);
    recoveryAnswers(ports, [{ choice: 'repair', failingCheckIds: ['help'] }]);
    const point = at('after', (state) => state.intents.some((intent) => intent.kind === 'stop' && intent.confirmed));

    const { resumed } = await crashThenResume(ports, point);

    expect(ports.executor.starts.map((start) => [start.playbook, start.dispatchKey])).toEqual([
      ['playbook-feature', `${RUN_ID}|only|r1|a1`],
      ['repair', `${RUN_ID}|only|r1|a2`],
    ]);
    expect(ports.executor.starts[1]?.inputs.failingChecks).toEqual([{ id: 'help', reason: 'failed' }]);
    const judged = resumed.sink.ofType('decision_started').filter((event) => event.kind === 'judge');
    expect(judged.map((event) => event.attempt)).toEqual([2]);
  });

  test('a stop for give up interrupted before its answer is confirmed on resume and the task is marked failed', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED]]);
    recoveryAnswers(ports, [{ choice: 'give_up', reason: 'hopeless' }]);
    const point = at('after', (state) => state.intents.some((intent) => intent.kind === 'stop'));

    const { resumed } = await crashThenResume(ports, point);

    expect(resumed.sink.ofType('executor_stopped').map((event) => [event.purpose, event.confirmed])).toEqual([['give_up', true]]);
    expect((await stored(ports))?.tasks['only']).toMatchObject({ state: 'failed', failReason: 'given_up' });
  });

  test('a stop still unconfirmed on resume skips its continuation and fails the task with stop_unconfirmed', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[NODE_FAILED]]);
    recoveryAnswers(ports, [{ choice: 'repair', failingCheckIds: ['help'] }]);
    const point = at('after', (state) => state.intents.some((intent) => intent.kind === 'stop'));
    ports.executor.onStart((_input, runId) => ports.executor.setStopOutcome(runId, { confirmed: false }));

    await crashThenResume(ports, point);

    expect(ports.executor.starts).toHaveLength(1);
    const state = await stored(ports);
    expect(state?.tasks['only']).toMatchObject({ state: 'failed', failReason: 'stop_unconfirmed' });
    expect(state?.runs['executor-run-1']?.state).toBe('unconfirmed');
  });

  test('a crash midway through stopping runs for a re-plan stops the second run and continues the re-plan before any dispatch', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'a', ownedPaths: ['src/a'] }), aTask({ id: 'c', ownedPaths: ['src/c'] })]);
    ports.executor.onStart((input, runId) => {
      if (input.tree === 'tree-c-r1') {
        ports.executor.pushEvent(runId, NODE_FAILED);
      } else if (input.tree !== 'tree-a-r1') {
        ports.executor.pushEvent(runId, SUCCEEDED);
      }
    });
    ports.brain.script.replan.answerWith({
      decision: aPlan([aTask({ id: 'a', ownedPaths: ['src/a'] }), aTask({ id: 'c', ownedPaths: ['src/c'] })]),
    });
    const point = at('after', (state) => Object.values(state.runs).some((run) => run.state === 'stopped'));

    const { resumed } = await crashThenResume(ports, point, { taskAttemptBudget: 1 });

    const types = resumed.sink.events.map((event) => (event.type === 'executor_stopped' ? `stopped:${event.purpose}` : event.type));
    expect(types.filter((type) => type === 'stopped:replan')).toHaveLength(1);
    expect(types.indexOf('stopped:replan')).toBeLessThan(types.indexOf('executor_started'));
    expect(types.indexOf('replan_ended')).toBeLessThan(types.indexOf('executor_started'));
    expect(ports.brain.callsOf('replan')).toHaveLength(1);
    const state = await stored(ports);
    expect(state?.tasks['a']).toMatchObject({ revision: 2, state: 'integrated' });
    expect(state?.tasks['c']).toMatchObject({ revision: 2, state: 'integrated' });
  });
});

describe('resume of integration and delivery', () => {
  test('main already advanced to the integration result marks the task integrated without merging again', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[SUCCEEDED]]);
    const point = at('before', (state) => state.lastMainChecks !== null);

    const { resumed } = await crashThenResume(ports, point);

    expect(resumed.sink.ofType('merge_produced')).toEqual([]);
    expect(resumed.sink.ofType('main_advanced').map((event) => event.taskId)).toEqual(['only']);
    expect((await stored(ports))?.tasks['only']?.state).toBe('integrated');
  });

  test('an integration whose main was not advanced is tried again', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[SUCCEEDED]]);
    const point = at('after', (state) => state.intents.some((intent) => intent.kind === 'integrate'));

    const { resumed } = await crashThenResume(ports, point);

    expect(resumed.sink.ofType('merge_produced').map((event) => event.taskId)).toEqual(['only']);
    expect((await stored(ports))?.tasks['only']?.state).toBe('integrated');
  });

  test('a delivery interrupted by the crash is repeated from the start', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[SUCCEEDED]]);
    const point = at('after', (state) => state.intents.some((intent) => intent.kind === 'deliver'));

    const { result, resumed } = await crashThenResume(ports, point, { outDir: 'out/x' });

    expect(resumed.sink.ofType('delivery_done')).toHaveLength(1);
    expect(ports.workspace.deliveries).toHaveLength(1);
    expect(result).toMatchObject({ outcome: 'partial', deliveredDir: 'out/x', verified: true });
    expect((await stored(ports))?.intents).toEqual([]);
  });

  test('a run that already ended returns its recorded outcome, and an unknown run fails without a state', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    runsReport(ports, [[SUCCEEDED]]);
    await drive(ports.clock, new RunFactory(ports).run({ runId: RUN_ID, spec: SPEC }));

    const again = await drive(ports.clock, new RunFactory(ports).resume(RUN_ID));
    const unknown = await drive(ports.clock, new RunFactory(ports).resume('run-unknown'));

    expect(again.outcome).toBe('partial');
    expect(unknown).toMatchObject({ outcome: 'failed', reason: 'resume_unavailable: no saved state' });
  });
});

describe('decision ids across a resume', () => {
  test('the decisions of a resumed run never reuse an id of the run before the crash', async () => {
    const ports = fakePorts();
    planOf(ports, [
      aTask({ id: 'a', ownedPaths: ['src/a'] }),
      aTask({ id: 'b', ownedPaths: ['src/b'], dependsOn: ['a'] }),
      aTask({ id: 'c', ownedPaths: ['src/c'], dependsOn: ['a'] }),
      aTask({ id: 'd', ownedPaths: ['src/d'], dependsOn: ['a'] }),
    ]);
    runsReport(ports, []);
    const point = at('after', (state) => state.tasks['a']?.state === 'integrated');

    const { resumed } = await crashThenResume(ports, point);

    const ids = (sink: FakePorts['sink']): string[] => sink.ofType('decision_started').map((event) => event.decisionId ?? '');
    const before = ids(ports.sink);
    const after = ids(resumed.sink);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((id) => before.includes(id))).toEqual([]);
  });
});
