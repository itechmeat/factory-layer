import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpToolError } from '../mcp-stdio/errors';
import { ApbExecutor } from './apb-executor';
import { NO_FAILING_CHECKS } from './start-inputs';
import type { StartRunInput } from '../../ports/executor';
import { answerOf, recorded } from './testing/apb-fixtures';
import { after, FakeApb, type FakeHandler, never, sequence } from './testing/fake-apb';

const TOKEN = 'sv-test-token-0123456789';
const RUN_ID = 'smoke-fail-1793367583063';
const tree = mkdtempSync(join(tmpdir(), 'apb-executor-'));
afterAll(() => rmSync(tree, { recursive: true, force: true }));

/** The recorded start answer with a token the test can look for. */
const started: FakeHandler = async () => ({ ...answerOf('playbook_run-started'), supervisor_token: TOKEN });

const FAST = { startMs: 300, callMs: 300, waitMarginMs: 50, lookupMs: 300, pollIntervalMs: 10 };

function executorOver(apb: FakeApb): ApbExecutor {
  return new ApbExecutor(async () => apb, FAST);
}

function input(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    dispatchKey: 'run-1/t1/1/1',
    playbook: 'implement-task',
    tree,
    inputs: { taskText: '# Task\nDo it.', ownedPaths: ['src/a.ts', 'src/a.test.ts'] },
    ...overrides,
  };
}

/** An executor that already started the recorded run. */
async function startedExecutor(handlers: Record<string, FakeHandler>): Promise<{ executor: ApbExecutor; apb: FakeApb }> {
  const apb = new FakeApb({ playbook_run: started, ...handlers });
  const executor = executorOver(apb);
  expect(await executor.startRun(input())).toMatchObject({ ok: true, runId: RUN_ID });
  return { executor, apb };
}

describe('startRun', () => {
  test('writes the task file, passes typed inputs as one-per-line params and registers the token before any later call', async () => {
    const { executor, apb } = await startedExecutor({ supervisor_wait_event: async () => answerOf('supervisor_wait_event-parked') });
    expect(readFileSync(join(tree, '.factory/task.md'), 'utf8')).toBe('# Task\nDo it.\n');
    expect(apb.callsTo('playbook_run')[0]?.args).toEqual({
      id: 'implement-task',
      supervise: 'self',
      worktree: tree,
      params: { task_file: '.factory/task.md', owned_paths: 'src/a.ts\nsrc/a.test.ts' },
    });
    await executor.waitEvent(RUN_ID, 8, 100);
    expect(apb.callsTo('supervisor_wait_event')[0]?.secrets).toEqual([TOKEN]);
  });

  test('a hint-only repair (no check has run) starts with failing_checks pointing at the failure in the task file', async () => {
    const apb = new FakeApb({ playbook_run: started });
    const result = await executorOver(apb).startRun(input({ playbook: 'repair' }));
    expect(result.ok).toBe(true);
    const [params] = apb.callsTo('playbook_run').map((call) => call.args['params']);
    expect(params).toMatchObject({ failing_checks: NO_FAILING_CHECKS });
  });

  test('failing checks and conflict paths go one per line', async () => {
    const apb = new FakeApb({ playbook_run: started });
    const executor = executorOver(apb);
    const failingChecks = [
      { id: 'c1', reason: 'exit 1' },
      { id: 'c2', reason: 'timeout' },
    ];
    await executor.startRun(input({ playbook: 'repair', inputs: { taskText: 't', ownedPaths: ['a.ts'], failingChecks } }));
    const integrateTree = join(tree, 'integrate');
    mkdirSync(integrateTree, { recursive: true });
    await executor.startRun(
      input({ playbook: 'integrate', tree: integrateTree, inputs: { taskText: 't', ownedPaths: [], conflictPaths: ['a.ts', 'b.ts'] } }),
    );
    const [repair, integrate] = apb.callsTo('playbook_run').map((call) => call.args['params']);
    expect(repair).toMatchObject({ failing_checks: 'c1: exit 1\nc2: timeout' });
    expect(integrate).toEqual({ task_file: '.factory/task.md', conflict_paths: 'a.ts\nb.ts' });
  });

  test('an unknown playbook is mapped by the params it declares, and refused when one has no input', async () => {
    const apb = new FakeApb({ playbook_get: async () => ({ id: 'custom', params: [{ name: 'task_file' }, { name: 'budget_note' }] }) });
    const result = await executorOver(apb).startRun(input({ playbook: 'custom' }));
    expect(result).toEqual({ ok: false, outcome: 'refused', policy: 'missing_input', detail: 'missing input for params: budget_note' });
    expect(apb.callsTo('playbook_run')).toHaveLength(0);
  });

  test('a missing tree is refused without creating it', async () => {
    const apb = new FakeApb({ playbook_run: started });
    const result = await executorOver(apb).startRun(input({ tree: join(tree, 'absent') }));
    expect(result).toMatchObject({ ok: false, outcome: 'refused' });
    expect(apb.calls).toHaveLength(0);
  });

  test('a policy refusal names the policy and registers no run', async () => {
    const apb = new FakeApb({ playbook_run: async () => recorded('playbook_run-untrusted').answer });
    const executor = executorOver(apb);
    const result = await executor.startRun(input());
    expect(result).toMatchObject({ ok: false, outcome: 'refused', policy: 'untrusted_requires_acknowledge' });
    expect(!result.ok && result.detail).toContain('untrusted_requires_acknowledge');
    await expect(executor.waitEvent('smoke-untrusted-1', 0, 100)).rejects.toThrow(/not known/);
  });

  test('APB declining the start (a busy tree) is a refusal with its message', async () => {
    const message = String(recorded('playbook_run-shared-workdir').answer);
    const apb = new FakeApb({
      playbook_run: async () => {
        throw new McpToolError('playbook_run', message);
      },
    });
    const result = await executorOver(apb).startRun(input());
    expect(result).toMatchObject({ ok: false, outcome: 'refused' });
    expect(!result.ok && result.detail).toContain('another write-run holds the workdir');
  });

  test('a start whose answer does not come back in time is indeterminate', async () => {
    const apb = new FakeApb({ playbook_run: () => never() });
    expect(await executorOver(apb).startRun(input())).toMatchObject({ ok: false, outcome: 'indeterminate' });
  });

  test('an unreadable start answer is indeterminate', async () => {
    const apb = new FakeApb({ playbook_run: async () => ({ run_id: RUN_ID }) });
    expect(await executorOver(apb).startRun(input())).toMatchObject({ ok: false, outcome: 'indeterminate' });
  });
});

describe('waitEvent', () => {
  test('a node failure wake, then the parked run is quiet with the cursor kept', async () => {
    const { executor, apb } = await startedExecutor({
      supervisor_wait_event: sequence(answerOf('supervisor_wait_event-node-failed'), answerOf('supervisor_wait_event-parked')),
    });
    expect(await executor.waitEvent(RUN_ID, 0, 1000)).toEqual({
      event: { kind: 'wake', seq: 8, trigger: 'node_failed', nodeId: 'boom', detail: 'smoke-fail: about to exit 1' },
      nextAfterSeq: 8,
    });
    expect(await executor.waitEvent(RUN_ID, 8, 1000)).toEqual({ event: { kind: 'quiet' }, nextAfterSeq: 8 });
    const [first] = apb.callsTo('supervisor_wait_event');
    expect(first?.args).toEqual({ token: TOKEN, after_seq: 0, timeout_ms: 1000 });
    expect(first?.timeoutMs).toBe(1050);
  });

  test('a node timeout wake is a node failure with the reason timeout', async () => {
    const wake = answerOf('supervisor_wait_event-node-failed');
    wake['wake'] = { seq: 9, trigger: 'node_timeout', node: 'implement', detail: null };
    const { executor } = await startedExecutor({ supervisor_wait_event: async () => wake });
    expect((await executor.waitEvent(RUN_ID, 0, 100)).event).toEqual({
      kind: 'wake',
      seq: 9,
      trigger: 'node_failed',
      nodeId: 'implement',
      detail: 'timeout',
    });
  });

  test('a null next cursor keeps the previous one', async () => {
    const { executor } = await startedExecutor({ supervisor_wait_event: async () => answerOf('supervisor_wait_event-timeout') });
    expect(await executor.waitEvent(RUN_ID, 17, 100)).toEqual({ event: { kind: 'quiet' }, nextAfterSeq: 17 });
  });

  test('an anomaly, a review and a non-terminal end are stalls of their kind; a host task needs the host', async () => {
    const anomaly = {
      ...answerOf('supervisor_wait_event-node-failed'),
      wake: { seq: 3, trigger: 'anomaly', node: 'n', detail: 'no progress' },
    };
    const review = { ...answerOf('supervisor_wait_event-timeout'), reason: 'review', pending_review: { node: 'gate' } };
    const ended = { ...answerOf('supervisor_wait_event-ended'), run_status: 'paused' };
    const host = { ...answerOf('supervisor_wait_event-timeout'), reason: 'host_task', pending_tasks: [] };
    const { executor } = await startedExecutor({ supervisor_wait_event: sequence(anomaly, review, ended, host) });
    const events = [];
    for (let index = 0; index < 4; index += 1) events.push((await executor.waitEvent(RUN_ID, 1, 100)).event);
    expect(events).toEqual([
      { kind: 'wake', seq: 3, trigger: 'stalled', nodeId: 'n', detail: 'no progress' },
      { kind: 'wake', seq: 1, trigger: 'review', nodeId: null, detail: 'the run waits on a review gate' },
      { kind: 'wake', seq: 1, trigger: 'stalled', nodeId: null, detail: 'the run stopped moving in status paused' },
      { kind: 'needs_host' },
    ]);
  });

  test('a run aborted after the factory stopped it is reported stopped; one aborted otherwise stays aborted', async () => {
    const aborted = { ...answerOf('supervisor_wait_event-ended'), run_status: 'aborted' };
    const handlers = {
      supervisor_wait_event: async () => aborted,
      run_stop: async () => recorded('run_stop-live').answer,
      run_status: async () => answerOf('run_status-parked'),
    };
    const unstopped = await startedExecutor(handlers);
    expect((await unstopped.executor.waitEvent(RUN_ID, 0, 100)).event).toEqual({ kind: 'terminal', status: 'aborted' });
    const stopped = await startedExecutor(handlers);
    expect(await stopped.executor.stop(RUN_ID, 50)).toMatchObject({ outcome: 'unconfirmed' });
    expect((await stopped.executor.waitEvent(RUN_ID, 0, 100)).event).toEqual({ kind: 'terminal', status: 'stopped' });
  });

  test('a wait that outlives its slice and margin is a typed timeout', async () => {
    const { executor } = await startedExecutor({ supervisor_wait_event: (args) => after(Number(args['timeout_ms']) + 500, {}) });
    await expect(executor.waitEvent(RUN_ID, 0, 50)).rejects.toMatchObject({ name: 'ExecutorError', reason: 'timeout' });
  });
});
