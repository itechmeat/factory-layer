import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpConnectionError, McpToolError } from '../mcp-stdio/errors';
import { ApbExecutor } from './apb-executor';
import { answerOf, listOf, recorded } from './testing/apb-fixtures';
import { FakeApb, type FakeHandler, never, sequence } from './testing/fake-apb';

const TOKEN = 'sv-test-token-0123456789';
const RUN_ID = 'smoke-fail-1793367583063';
const tree = mkdtempSync(join(tmpdir(), 'apb-recovery-'));
const otherTree = mkdtempSync(join(tmpdir(), 'apb-recovery-other-'));
afterAll(() => {
  for (const path of [tree, otherTree]) rmSync(path, { recursive: true, force: true });
});

const FAST = { startMs: 300, callMs: 300, waitMarginMs: 50, lookupMs: 300, pollIntervalMs: 10 };
const started: FakeHandler = async () => ({ ...answerOf('playbook_run-started'), supervisor_token: TOKEN });
const dead: FakeHandler = async () => {
  throw new McpConnectionError({ command: 'apb', reason: 'connection lost', stderrTail: '', pid: 1 });
};

/** Delivers the recorded node-failure wake once, then the connection is dead. */
function wakeThenDead(): FakeHandler {
  let calls = 0;
  return async (args) => {
    calls += 1;
    return calls === 1 ? answerOf('supervisor_wait_event-node-failed') : dead(args);
  };
}

async function startOn(executor: ApbExecutor, runId = RUN_ID, where = tree): Promise<void> {
  const result = await executor.startRun({
    dispatchKey: 'k',
    playbook: 'build-task',
    tree: where,
    inputs: { taskText: 't', ownedPaths: ['a.ts'], mode: 'implement' },
  });
  expect(result).toMatchObject({ ok: true, runId });
}

/** Starts a new run on each call: `run-a` with token `token-a`, then `run-b` with `token-b`. */
function startsTwo(): FakeHandler {
  const runs = ['a', 'b'];
  return async () => {
    const name = runs.shift() ?? 'z';
    return { ...answerOf('playbook_run-started'), run_id: `run-${name}`, supervisor_token: `token-${name}-0123456789` };
  };
}

describe('recovery commands', () => {
  test('a posted command is accepted with its sequence, not applied; a declined one is not accepted', async () => {
    const apb = new FakeApb({
      playbook_run: started,
      supervisor_node_retry: async () => recorded('supervisor_node_retry').answer,
      supervisor_context_append: async () => {
        throw new McpToolError('supervisor_context_append', 'run is terminal');
      },
    });
    const executor = new ApbExecutor(async () => apb, FAST);
    await startOn(executor);
    expect(await executor.retryNode(RUN_ID, 'boom')).toEqual({ accepted: true, postedSeq: 1 });
    expect(apb.callsTo('supervisor_node_retry')[0]?.args).toEqual({ token: TOKEN, node: 'boom' });
    expect(await executor.appendContext(RUN_ID, 'hint')).toEqual({ accepted: false, postedSeq: null });
  });

  test('a command on an unknown run is a typed failure', async () => {
    const executor = new ApbExecutor(async () => new FakeApb({}), FAST);
    await expect(executor.rebindProfile('nope', 'n', 'codex')).rejects.toMatchObject({ name: 'ExecutorError', reason: 'failed' });
  });
});

describe('stop', () => {
  test('a live stop is confirmed only once run_status shows a terminal run with no live driver', async () => {
    const running = { ...answerOf('run_status-parked') };
    const apb = new FakeApb({
      playbook_run: started,
      run_stop: async () => recorded('run_stop-live').answer,
      run_status: sequence(running, recorded('run_status-aborted-driver-exiting').answer, recorded('run_status-aborted').answer),
    });
    const executor = new ApbExecutor(async () => apb, FAST);
    await startOn(executor);
    expect(await executor.stop(RUN_ID, 1000)).toMatchObject({ outcome: 'stopped' });
    expect(apb.callsTo('run_status')).toHaveLength(2);
  });

  test('a run that never ends is unconfirmed within the deadline', async () => {
    const apb = new FakeApb({
      run_stop: async () => recorded('run_stop-live').answer,
      run_status: async () => answerOf('run_status-parked'),
    });
    const begin = performance.now();
    const result = await new ApbExecutor(async () => apb, FAST).stop(RUN_ID, 200);
    expect(result).toMatchObject({ outcome: 'unconfirmed' });
    expect(performance.now() - begin).toBeLessThan(400);
  });

  test('a stop whose connection dies twice is unconfirmed with the lost connection named', async () => {
    const result = await new ApbExecutor(async () => new FakeApb({ run_stop: dead }), FAST).stop(RUN_ID, 1000);
    expect(result.outcome).toBe('unconfirmed');
    expect(result.detail).toContain('connection lost');
  });

  test('a stop whose connection dies once is finished on the replacement connection', async () => {
    const connections = [
      new FakeApb({ run_stop: dead }),
      new FakeApb({
        run_stop: async () => recorded('run_stop-live').answer,
        run_status: async () => recorded('run_status-aborted').answer,
      }),
    ];
    const result = await new ApbExecutor(async () => connections.shift() ?? new FakeApb({}), FAST).stop(RUN_ID, 1000);
    expect(result).toMatchObject({ outcome: 'stopped' });
  });
});

describe('attach', () => {
  test('a parked run attached after a restart is reported as the node failure it waits on, then quiet', async () => {
    const apb = new FakeApb({ supervisor_wait_event: async () => answerOf('supervisor_wait_event-parked') });
    const executor = new ApbExecutor(async () => apb, FAST);
    expect(await executor.attach(RUN_ID, TOKEN)).toEqual({ attached: true, detail: 'the supervisor token is valid' });
    expect(apb.secrets).toEqual([TOKEN]);
    expect(await executor.waitEvent(RUN_ID, 8, 100)).toEqual({
      event: { kind: 'wake', seq: 8, trigger: 'node_failed', nodeId: 'boom', detail: 'the run waits for its supervisor after node_failed' },
      nextAfterSeq: 8,
    });
    expect((await executor.waitEvent(RUN_ID, 8, 100)).event).toEqual({ kind: 'quiet' });
  });

  test('a failed tree lookup of an attached run leaves its tree unknown and later starts still go ahead', async () => {
    const apb = new FakeApb({
      supervisor_wait_event: async () => answerOf('supervisor_wait_event-parked'),
      run_status: async () => {
        throw new McpToolError('run_status', 'run not found');
      },
      playbook_run: started,
    });
    const executor = new ApbExecutor(async () => apb, FAST);
    expect((await executor.attach('attached-run', 'token-attached-0123456789')).attached).toBe(true);
    await startOn(executor);
    expect(apb.callsTo('run_status')).toHaveLength(1);
  });

  test('a token APB rejects is not attached, with the reason', async () => {
    const apb = new FakeApb({
      supervisor_wait_event: async () => {
        throw new McpToolError('supervisor_wait_event', 'unknown supervisor token');
      },
    });
    const result = await new ApbExecutor(async () => apb, FAST).attach(RUN_ID, TOKEN);
    expect(result.attached).toBe(false);
    expect(result.detail).toContain('unknown supervisor token');
  });
});

describe('findRuns', () => {
  test('keeps only the runs of that playbook in that tree started at or after the time', async () => {
    const runs = listOf('runs_list');
    const target = runs[1];
    const apb = new FakeApb({
      runs_list: async () => runs,
      run_status: async (args) => ({
        ...answerOf('run_status-succeeded'),
        run_id: args['run_id'],
        worktree: args['run_id'] === target?.['run_id'] ? tree : '/project/elsewhere',
      }),
    });
    const notBefore = new Date(Number(target?.['started_ts']) - 1).toISOString();
    const found = await new ApbExecutor(async () => apb, FAST).findRuns({ playbook: 'smoke-wait', tree, notBefore });
    expect(found).toEqual([{ runId: String(target?.['run_id']), status: 'succeeded' }]);
    expect(apb.callsTo('run_status').map((call) => call.args['run_id'])).not.toContain(runs.at(-1)?.['run_id']);
  });

  test('a lookup that does not answer is a typed timeout', async () => {
    const apb = new FakeApb({ runs_list: () => never() });
    await expect(
      new ApbExecutor(async () => apb, FAST).findRuns({ playbook: 'p', tree, notBefore: new Date().toISOString() }),
    ).rejects.toMatchObject({ reason: 'timeout' });
  });
});

describe('a dead apb mcp connection', () => {
  test('is replaced once: every known run is re-attached by its token and the waits continue from their cursors', async () => {
    const first = new FakeApb({ playbook_run: started, supervisor_wait_event: wakeThenDead() });
    const second = new FakeApb({ supervisor_wait_event: async () => answerOf('supervisor_wait_event-parked') });
    const connections = [first, second];
    const executor = new ApbExecutor(async () => connections.shift() ?? new FakeApb({}), FAST);
    await startOn(executor);
    expect((await executor.waitEvent(RUN_ID, 0, 100)).event).toMatchObject({ trigger: 'node_failed' });
    expect(await executor.waitEvent(RUN_ID, 8, 100)).toEqual({
      event: { kind: 'quiet' },
      nextAfterSeq: 8,
    });
    expect(first.closed).toBe(true);
    const waits = second.callsTo('supervisor_wait_event');
    expect(waits.map((call) => call.args)).toEqual([
      { token: TOKEN, timeout_ms: 0 },
      { token: TOKEN, after_seq: 8, timeout_ms: 100 },
    ]);
    expect(waits[0]?.secrets).toEqual([TOKEN]);
  });

  test('two concurrent waits that find it dead share one replacement', async () => {
    const connections = [
      new FakeApb({ playbook_run: started, supervisor_wait_event: wakeThenDead() }),
      new FakeApb({ supervisor_wait_event: async () => answerOf('supervisor_wait_event-parked') }),
    ];
    let connects = 0;
    const executor = new ApbExecutor(async () => {
      connects += 1;
      return connections.shift() ?? new FakeApb({});
    }, FAST);
    await startOn(executor);
    await executor.waitEvent(RUN_ID, 0, 100);
    const results = await Promise.all([executor.waitEvent(RUN_ID, 8, 100), executor.waitEvent(RUN_ID, 8, 100)]);
    expect(results.map((result) => result.event.kind)).toEqual(['quiet', 'quiet']);
    expect(connects).toBe(2);
  });

  test('dying again after the replacement fails every later call with a typed lost connection', async () => {
    const connections = [new FakeApb({ playbook_run: started, supervisor_wait_event: dead }), new FakeApb({ supervisor_wait_event: dead })];
    const executor = new ApbExecutor(async () => connections.shift() ?? new FakeApb({}), FAST);
    await startOn(executor);
    await expect(executor.waitEvent(RUN_ID, 8, 100)).rejects.toMatchObject({ name: 'ApbConnectionLostError', reason: 'failed' });
    await expect(executor.retryNode(RUN_ID, 'boom')).rejects.toMatchObject({ name: 'ApbConnectionLostError', reason: 'failed' });
  });

  test('a start whose connection dies is indeterminate and is not repeated', async () => {
    const second = new FakeApb({ playbook_run: started });
    const connections = [new FakeApb({ playbook_run: dead }), second];
    const executor = new ApbExecutor(async () => connections.shift() ?? new FakeApb({}), FAST);
    const result = await executor.startRun({
      dispatchKey: 'k',
      playbook: 'build-task',
      tree,
      inputs: { taskText: 't', ownedPaths: ['a'], mode: 'implement' },
    });
    expect(result).toMatchObject({ ok: false, outcome: 'indeterminate' });
    expect(second.callsTo('playbook_run')).toHaveLength(0);
  });
});

describe('re-attach after a replacement', () => {
  test('each run is re-attached on its own: a rejected token loses only its run, the others keep working', async () => {
    const first = new FakeApb({ playbook_run: startsTwo(), supervisor_wait_event: dead });
    const second = new FakeApb({
      supervisor_wait_event: async (args) => {
        if (args['token'] === 'token-a-0123456789') throw new McpToolError('supervisor_wait_event', 'unknown supervisor token');
        return answerOf('supervisor_wait_event-parked');
      },
      supervisor_node_retry: async () => recorded('supervisor_node_retry').answer,
    });
    const connections = [first, second];
    const executor = new ApbExecutor(async () => connections.shift() ?? new FakeApb({}), FAST);
    await startOn(executor, 'run-a', tree);
    await startOn(executor, 'run-b', otherTree);
    expect((await executor.waitEvent('run-b', 8, 100)).event).toMatchObject({ kind: 'wake', trigger: 'node_failed' });
    expect(await executor.retryNode('run-b', 'boom')).toEqual({ accepted: true, postedSeq: 1 });
    await expect(executor.waitEvent('run-a', 8, 100)).rejects.toMatchObject({ name: 'ApbConnectionLostError', reason: 'failed' });
    await expect(executor.retryNode('run-a', 'boom')).rejects.toMatchObject({ name: 'ApbConnectionLostError' });
  });

  test('a run whose terminal event was delivered, or whose stop was confirmed, is not re-attached', async () => {
    const first = new FakeApb({
      playbook_run: startsTwo(),
      supervisor_wait_event: async () => answerOf('supervisor_wait_event-ended'),
      run_stop: async () => recorded('run_stop-live').answer,
      run_status: async () => recorded('run_status-aborted').answer,
      runs_list: dead,
    });
    const second = new FakeApb({ runs_list: async () => [] });
    const connections = [first, second];
    const executor = new ApbExecutor(async () => connections.shift() ?? new FakeApb({}), FAST);
    await startOn(executor, 'run-a', tree);
    await startOn(executor, 'run-b', otherTree);
    expect((await executor.waitEvent('run-a', 0, 100)).event).toEqual({ kind: 'terminal', status: 'succeeded' });
    expect(await executor.stop('run-b', 1000)).toMatchObject({ outcome: 'stopped' });
    expect(await executor.findRuns({ playbook: 'build-task', tree, notBefore: new Date().toISOString() })).toEqual([]);
    expect(second.callsTo('supervisor_wait_event')).toHaveLength(0);
  });
});

describe('a start in a tree with a live run', () => {
  test('is refused before the task file is written, and APB is not asked', async () => {
    const apb = new FakeApb({ playbook_run: startsTwo() });
    const executor = new ApbExecutor(async () => apb, FAST);
    await startOn(executor, 'run-a', tree);
    const retried = await executor.startRun({
      dispatchKey: 'k',
      playbook: 'build-task',
      tree,
      inputs: { taskText: 'other', ownedPaths: ['a.ts'], mode: 'implement' },
    });
    expect(retried).toMatchObject({ ok: false, outcome: 'refused', policy: 'tree_busy' });
    expect(readFileSync(join(tree, '.factory/task.md'), 'utf8')).toBe('t\n');
    expect(apb.callsTo('playbook_run')).toHaveLength(1);
  });

  test('a run attached after a restart is located by its run_status worktree', async () => {
    const apb = new FakeApb({
      supervisor_wait_event: async () => answerOf('supervisor_wait_event-parked'),
      run_status: async () => ({ ...answerOf('run_status-parked'), worktree: otherTree }),
      playbook_run: startsTwo(),
    });
    const executor = new ApbExecutor(async () => apb, FAST);
    await executor.attach(RUN_ID, TOKEN);
    const busy = await executor.startRun({
      dispatchKey: 'k',
      playbook: 'build-task',
      tree: otherTree,
      inputs: { taskText: 'x', ownedPaths: ['a.ts'], mode: 'implement' },
    });
    expect(busy).toMatchObject({ ok: false, outcome: 'refused', policy: 'tree_busy' });
    await startOn(executor, 'run-a', tree);
    expect(apb.callsTo('run_status')).toHaveLength(1);
  });
});
