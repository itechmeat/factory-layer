import { describe, expect, test } from 'bun:test';

import type { RunOptionsInput } from '../domain';

import { RunFactory } from '.';
import { aSpec, aTask, cliCheck, drive, fakePorts, planOf, succeedRuns, type FakePorts } from './testing';

const SPEC = aSpec();

function run(ports: FakePorts, options: RunOptionsInput = {}): ReturnType<RunFactory['run']> {
  return drive(ports.clock, new RunFactory(ports).run({ runId: 'run-i', spec: SPEC, options }));
}

/** The failure the first recovery decision saw. */
function recoveryFailure(ports: FakePorts): unknown {
  return ports.brain.callsOf('recovery')[0]?.args['failure'];
}

describe('integration', () => {
  test('a merge that breaks a check passing on main keeps main unchanged and sends the regression to recovery', async () => {
    const ports = fakePorts();
    planOf(
      ports,
      [aTask({ id: 'a', ownedPaths: ['src/a'] }), aTask({ id: 'b', ownedPaths: ['src/b'], dependsOn: ['a'] })],
      [cliCheck({ id: 'help' })],
    );
    ports.checks.setResultsForDir('tree-b-r1', [{ checkId: 'help', status: 'failed', reasons: ['exit 1'], detail: '' }]);
    ports.brain.script.recovery.answerWith({ decision: { choice: 'give_up', reason: 'stop' } });
    succeedRuns(ports);

    const result = await run(ports);

    expect(ports.sink.ofType('main_advanced').map((event) => event.taskId)).toEqual(['a']);
    expect(recoveryFailure(ports)).toMatchObject({ reason: 'regression', failingCheckIds: ['help'] });
    expect(await ports.workspace.mainCommit(SPEC.name)).toBe('integrate-1');
    expect(result.outcome).toBe('partial');
  });

  test('the integrate intent goes in the same save that marks the task integrated', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'a', ownedPaths: ['src/a'] })]);
    succeedRuns(ports);
    const saved: { readonly state: string; readonly intent: boolean }[] = [];
    const save = ports.store.save.bind(ports.store);
    ports.store.save = async (state) => {
      saved.push({ state: state.tasks['a']?.state ?? '', intent: state.intents.some((intent) => intent.kind === 'integrate') });
      await save(state);
    };

    await run(ports);

    const withIntent = saved.findIndex((entry) => entry.intent);
    const firstWithout = saved.findIndex((entry, index) => index > withIntent && !entry.intent);
    expect(saved[firstWithout]?.state).toBe('integrated');
  });

  test('main that moved since the merge base is never overwritten; the task goes to recovery', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.workspace.setIntegration(SPEC.name, 'only', 1, { outcome: 'ok', commit: 'merge-1', base: 'stale-main' });
    ports.brain.script.recovery.answerWith({ decision: { choice: 'give_up', reason: 'stop' } });
    succeedRuns(ports);

    await run(ports);

    expect(ports.sink.ofType('main_advanced')).toEqual([]);
    expect(await ports.workspace.mainCommit(SPEC.name)).toBe('main-1');
    expect(recoveryFailure(ports)).toMatchObject({ reason: 'main_moved' });
    expect((await ports.store.load('run-i'))?.intents).toEqual([]);
  });

  test('a conflict is handed over to an integrate run in the task tree and counts as an attempt', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.workspace.queueIntegration(SPEC.name, 'only', 1, { outcome: 'conflict', paths: ['src/index.ts'] });
    ports.workspace.queueIntegration(SPEC.name, 'only', 1, { outcome: 'ok' });
    ports.executor.onStart((input) => {
      if (input.playbook === 'integrate') {
        ports.workspace.markResolved(input.tree);
      }
    });
    succeedRuns(ports);

    await run(ports);

    expect(ports.workspace.handovers).toEqual([{ specName: SPEC.name, taskId: 'only', revision: 1, unresolvedPaths: ['src/index.ts'] }]);
    const integrate = ports.executor.starts[1];
    expect(integrate).toMatchObject({ playbook: 'integrate', tree: 'tree-only-r1', dispatchKey: 'run-i|only|r1|a2' });
    expect(integrate?.inputs.conflictPaths).toEqual(['src/index.ts']);
    expect((await ports.store.load('run-i'))?.tasks['only']).toEqual({ revision: 1, state: 'integrated', attemptsUsed: 2 });
  });

  test('an integrate run that leaves unresolved paths goes to recovery', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.workspace.setIntegration(SPEC.name, 'only', 1, { outcome: 'conflict', paths: ['src/index.ts'] });
    ports.brain.script.recovery.answerWith({ decision: { choice: 'give_up', reason: 'stop' } });
    succeedRuns(ports);

    await run(ports);

    expect(recoveryFailure(ports)).toMatchObject({ reason: 'conflict_unresolved' });
    expect(ports.sink.ofType('main_advanced')).toEqual([]);
  });

  test('a conflict with no attempt left and no re-plan fails the task without a hand-over', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.workspace.setIntegration(SPEC.name, 'only', 1, { outcome: 'conflict', paths: ['src/index.ts'] });
    succeedRuns(ports);

    await run(ports, { taskAttemptBudget: 1, runReplanBudget: 0 });

    expect(ports.workspace.handovers).toEqual([]);
    expect((await ports.store.load('run-i'))?.tasks['only']?.failReason).toBe('budget_spent');
  });

  test('a retry after an unresolved conflict starts another integrate run on the paths still unresolved, not a repair run', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.workspace.queueIntegration(SPEC.name, 'only', 1, { outcome: 'conflict', paths: ['src/index.ts'] });
    ports.workspace.queueIntegration(SPEC.name, 'only', 1, { outcome: 'ok' });
    ports.brain.script.recovery.answerWith({ decision: { choice: 'retry', hint: 'resolve the import' } });
    let integrateRuns = 0;
    ports.executor.onStart((input) => {
      if (input.playbook === 'integrate') {
        integrateRuns += 1;
        if (integrateRuns === 2) {
          ports.workspace.markResolved(input.tree);
        }
      }
    });
    succeedRuns(ports);

    await run(ports);

    expect(recoveryFailure(ports)).toMatchObject({ reason: 'conflict_unresolved' });
    const retry = ports.executor.starts[2];
    expect(retry).toMatchObject({ playbook: 'integrate', tree: 'tree-only-r1' });
    expect(retry?.inputs.conflictPaths).toEqual(['src/index.ts']);
    expect(retry?.inputs.taskText).toContain('Hint: resolve the import');
    expect((await ports.store.load('run-i'))?.tasks['only']?.state).toBe('integrated');
  });

  test('a failed integrate run that resolved every conflict is followed by a repair run, not another integrate run', async () => {
    const ports = fakePorts();
    planOf(ports, [aTask({ id: 'only' })]);
    ports.workspace.queueIntegration(SPEC.name, 'only', 1, { outcome: 'conflict', paths: ['src/index.ts'] });
    ports.workspace.queueIntegration(SPEC.name, 'only', 1, { outcome: 'ok' });
    ports.brain.script.recovery.answerWith({ decision: { choice: 'retry', hint: 'fix the tests' } });
    ports.executor.onStart((input, runId) => {
      if (input.playbook === 'integrate') {
        ports.workspace.markResolved(input.tree);
        ports.executor.pushEvent(runId, { kind: 'terminal', status: 'failed' });
      }
    });
    succeedRuns(ports, { when: (input) => input.playbook !== 'integrate' });

    await run(ports);

    expect(ports.executor.starts[2]).toMatchObject({ playbook: 'build-task', inputs: { mode: 'repair' }, tree: 'tree-only-r1' });
  });
});
