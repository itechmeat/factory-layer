import { describe, expect, test } from 'bun:test';

import { McpClosedError, McpConnectionError, McpToolError } from '../mcp-stdio/errors';
import { after, FakeApb, type FakeHandler, never, sequence } from './testing/fake-apb';
import { followRun, type FollowRunRequest } from './follow-run';

const TOKEN = 'sv-test-token-0123456789';
const RUN_ID = 'smoke-1';
const WORKTREE = '/project/work/smoke-a';

const started: FakeHandler = async () => ({ run_id: RUN_ID, supervisor_token: TOKEN, capabilities: ['observe'] });

function wait(reason: string, runStatus: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reason,
    run_status: runStatus,
    next_after_seq: null,
    pending_review: null,
    pending_supervisor: null,
    wake: null,
    ...extra,
  };
}

function status(runStatus: string, driverAlive: boolean | null): Record<string, unknown> {
  return { run_id: RUN_ID, run_status: runStatus, driver_alive: driverAlive, worktree: WORKTREE, nodes: {} };
}

const stopped: FakeHandler = async () => ({ outcome: 'signaled_live_driver', run_id: RUN_ID });

/** Small, fast budgets; each test overrides what it exercises. */
const FAST: FollowRunRequest = {
  playbookId: 'smoke',
  worktree: WORKTREE,
  runLimitMs: 2000,
  cleanupBudgetMs: 1000,
  waitSliceMs: 500,
  waitMarginMs: 50,
  pollIntervalMs: 10,
};

describe('followRun: success and own endings', () => {
  test('follows a supervised run to success, walking the event stream forward', async () => {
    const apb = new FakeApb({
      playbook_run: started,
      supervisor_wait_event: sequence(
        wait('timeout', 'running'),
        wait('wake', 'running', { next_after_seq: 7, wake: { seq: 7, trigger: 'anomaly', node: null } }),
        wait('ended', 'succeeded', { next_after_seq: 7 }),
      ),
    });
    const outcome = await followRun(apb, FAST);
    expect(outcome).toMatchObject({ kind: 'succeeded', runId: RUN_ID });
    expect(apb.callsTo('playbook_run')[0]?.args).toEqual({ id: 'smoke', supervise: 'self', worktree: WORKTREE });
    const waits = apb.callsTo('supervisor_wait_event');
    expect(waits.map((call) => call.args['after_seq'])).toEqual([undefined, undefined, 7]);
    expect(waits.every((call) => call.args['token'] === TOKEN)).toBe(true);
    expect(apb.callsTo('run_stop')).toHaveLength(0);
  });

  test('registers the supervisor token as a secret before the first call that carries it', async () => {
    const apb = new FakeApb({ playbook_run: started, supervisor_wait_event: sequence(wait('ended', 'succeeded')) });
    await followRun(apb, FAST);
    expect(apb.secrets).toEqual([TOKEN]);
    expect(apb.callsTo('supervisor_wait_event')[0]?.secrets).toEqual([TOKEN]);
  });

  test('a run that fails on its own is reported failed without a stop', async () => {
    const apb = new FakeApb({ playbook_run: started, supervisor_wait_event: sequence(wait('ended', 'failed')) });
    expect(await followRun(apb, FAST)).toMatchObject({ kind: 'failed', runId: RUN_ID, status: 'failed' });
    expect(apb.callsTo('run_stop')).toHaveLength(0);
  });

  test('a refused start is a typed outcome and nothing else is called', async () => {
    const apb = new FakeApb({
      playbook_run: async () => {
        throw new McpToolError('playbook_run', 'playbook is not trusted');
      },
    });
    const outcome = await followRun(apb, FAST);
    expect(outcome).toMatchObject({ kind: 'start_failed', recovery: { kind: 'not_started' } });
    expect(outcome.kind === 'start_failed' && outcome.detail).toContain('not trusted');
    expect(apb.calls).toHaveLength(1);
  });

  test('a policy refusal of the start names the policy', async () => {
    const apb = new FakeApb({
      playbook_run: async () => ({
        policy_refusal: {
          policy: 'untrusted_requires_acknowledge',
          detail: 'run again with acknowledge_untrusted: true after user confirmation',
          id: 'smoke',
        },
      }),
    });
    const outcome = await followRun(apb, FAST);
    expect(outcome).toMatchObject({ kind: 'start_failed', recovery: { kind: 'not_started' } });
    expect(outcome.kind === 'start_failed' && outcome.detail).toContain('untrusted_requires_acknowledge');
    expect(apb.calls).toHaveLength(1);
  });
});

describe('followRun: the stop path', () => {
  /** The usual `run_status` answers: running, then terminal with the driver alive, then gone (`null`). */
  const driverGoneAsNull = (): FakeHandler => sequence(status('running', true), status('aborted', true), status('aborted', null));
  const cases: { name: string; waitAnswer: FakeHandler; reason: string; runStatus?: FakeHandler }[] = [
    {
      name: 'a host-task wait stops at once',
      waitAnswer: sequence(wait('host_task', 'running', { pending_tasks: [{ node: 'x' }] })),
      reason: 'pending_tasks',
    },
    {
      name: 'pending tasks on an ordinary wake stop at once',
      waitAnswer: sequence(wait('wake', 'running', { pending_tasks: [] })),
      reason: 'pending_tasks',
    },
    {
      name: 'a review gate is a stall',
      waitAnswer: sequence(wait('review', 'running', { pending_review: { node: 'gate' } })),
      reason: 'stalled',
    },
    {
      name: 'a parked run waiting for its supervisor is a stall',
      waitAnswer: sequence(wait('wake', 'running', { pending_supervisor: { node: 'n' } })),
      reason: 'stalled',
    },
    {
      name: 'an ended wait on a run that is not terminal is a stall',
      waitAnswer: sequence(wait('ended', 'paused')),
      reason: 'stalled',
    },
    {
      name: 'a failing wait is an error',
      waitAnswer: async () => {
        throw new McpToolError('supervisor_wait_event', 'engine error');
      },
      reason: 'error',
    },
    {
      name: 'an unexpected wait answer is an error',
      waitAnswer: sequence({ reason: 'surprise', run_status: 'running' }),
      reason: 'error',
    },
    {
      name: 'a terminal run whose driver is still alive is polled until driver_alive is false',
      waitAnswer: sequence(wait('host_task', 'running')),
      reason: 'pending_tasks',
      runStatus: sequence(status('aborted', true), status('aborted', true), status('aborted', false)),
    },
  ];
  for (const { name, waitAnswer, reason, runStatus } of cases) {
    test(`${name}: run_stop, then polled to terminal with the driver gone`, async () => {
      const apb = new FakeApb({
        playbook_run: started,
        supervisor_wait_event: waitAnswer,
        run_stop: stopped,
        run_status: runStatus ?? driverGoneAsNull(),
      });
      const outcome = await followRun(apb, FAST);
      expect(outcome).toMatchObject({ kind: 'stopped', runId: RUN_ID, reason, finalStatus: 'aborted' });
      expect(apb.callsTo('supervisor_wait_event')).toHaveLength(1);
      expect(apb.callsTo('run_stop')[0]?.args).toEqual({ run_id: RUN_ID });
      expect(apb.callsTo('run_status')).toHaveLength(3);
    });
  }

  test('the run limit stops a run that keeps running', async () => {
    const apb = new FakeApb({
      playbook_run: started,
      supervisor_wait_event: async (args) => after(Number(args['timeout_ms']), wait('timeout', 'running')),
      run_stop: stopped,
      run_status: sequence(status('aborted', false)),
    });
    const begin = performance.now();
    const outcome = await followRun(apb, { ...FAST, runLimitMs: 300 });
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'run_limit', finalStatus: 'aborted' });
    expect(performance.now() - begin).toBeLessThan(600);
  });

  test('a stop on a run that already finished is still observed terminal', async () => {
    const apb = new FakeApb({
      playbook_run: started,
      supervisor_wait_event: sequence(wait('host_task', 'running')),
      run_stop: async () => {
        throw new McpToolError('run_stop', 'boom');
      },
      run_status: sequence(status('succeeded', null)),
    });
    expect(await followRun(apb, FAST)).toMatchObject({ kind: 'stopped', finalStatus: 'succeeded' });
  });

  test('a run that never becomes terminal is a cleanup timeout within the budget', async () => {
    const apb = new FakeApb({
      playbook_run: started,
      supervisor_wait_event: sequence(wait('host_task', 'running')),
      run_stop: stopped,
      run_status: sequence(status('running', true)),
    });
    const begin = performance.now();
    const outcome = await followRun(apb, { ...FAST, cleanupBudgetMs: 200 });
    expect(outcome).toMatchObject({ kind: 'cleanup_timeout', reason: 'pending_tasks', lastStatus: 'running' });
    expect(performance.now() - begin).toBeLessThan(450);
  });
});

describe('followRun: absolute deadlines', () => {
  test('a supervisor wait in flight cannot overrun the run deadline', async () => {
    const apb = new FakeApb({
      playbook_run: started,
      supervisor_wait_event: () => never(),
      run_stop: stopped,
      run_status: sequence(status('aborted', null)),
    });
    const request = { ...FAST, runLimitMs: 400, waitSliceMs: 10_000, waitMarginMs: 100 };
    const outcome = await followRun(apb, request);
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'run_limit' });
    const [waitCall] = apb.callsTo('supervisor_wait_event');
    expect(Number(waitCall?.args['timeout_ms'])).toBeLessThanOrEqual(300);
    expect(waitCall?.timeoutMs).toBeLessThanOrEqual(400);
    const stopAt = apb.callsTo('run_stop')[0]?.at ?? Infinity;
    expect(stopAt).toBeLessThan(400 + 60);
  });

  test('a wait cut short by the run deadline is the run limit, not an error', async () => {
    const apb = new FakeApb({
      playbook_run: started,
      supervisor_wait_event: () => never(),
      run_stop: stopped,
      run_status: sequence(status('aborted', null)),
    });
    const outcome = await followRun(apb, { ...FAST, runLimitMs: 200, waitMarginMs: 500 });
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'run_limit' });
  });

  test('inside the last wait margin the follower keeps waiting in shrinking slices, not in a busy loop', async () => {
    const apb = new FakeApb({
      playbook_run: started,
      supervisor_wait_event: async (args) => after(Number(args['timeout_ms']), wait('timeout', 'running')),
      run_stop: stopped,
      run_status: sequence(status('aborted', null)),
    });
    const outcome = await followRun(apb, { ...FAST, runLimitMs: 300, waitMarginMs: 250 });
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'run_limit' });
    const slices = apb.callsTo('supervisor_wait_event').map((call) => Number(call.args['timeout_ms']));
    expect(slices.length).toBeLessThan(15);
  });

  test('slow cleanup calls cannot exceed the cleanup budget', async () => {
    const apb = new FakeApb({
      playbook_run: started,
      supervisor_wait_event: sequence(wait('host_task', 'running')),
      run_stop: () => never(),
      run_status: () => never(),
    });
    const begin = performance.now();
    const outcome = await followRun(apb, { ...FAST, cleanupBudgetMs: 300 });
    const elapsed = performance.now() - begin;
    expect(outcome).toMatchObject({ kind: 'cleanup_timeout', reason: 'pending_tasks' });
    expect(elapsed).toBeLessThan(300 + 100);
    const stopCall = apb.callsTo('run_stop')[0];
    expect(stopCall?.timeoutMs).toBeLessThanOrEqual(300);
    for (const call of apb.callsTo('run_status')) {
      expect((call.timeoutMs ?? Infinity) + call.at).toBeLessThanOrEqual((stopCall?.at ?? 0) + 300 + 5);
    }
  });
});

interface FakeRun {
  readonly run_id: string;
  readonly playbook: string;
  readonly started_ts: number;
  readonly worktree: string | null;
}

/** A fake whose `playbook_run` creates the run, then never answers. */
function slowStart(created: FakeRun | undefined, others: readonly FakeRun[], targetStatus: FakeHandler): FakeApb {
  const runs: FakeRun[] = [...others];
  const statusOf = (run: FakeRun) => async () => ({
    run_id: run.run_id,
    run_status: 'running',
    driver_alive: true,
    worktree: run.worktree,
  });
  return new FakeApb({
    playbook_run: async () => {
      if (created !== undefined) runs.push({ ...created, started_ts: Date.now() });
      return never();
    },
    runs_list: async () => runs.map((run) => ({ ...run, status: 'running', progress: {} })),
    run_status: async (args) => {
      const run = runs.find((candidate) => candidate.run_id === args['run_id']);
      if (run === undefined) throw new McpToolError('run_status', 'no such run');
      return run.run_id === created?.run_id ? targetStatus(args) : statusOf(run)();
    },
    run_stop: stopped,
  });
}

describe('followRun: an indeterminate start', () => {
  const target: FakeRun = { run_id: 'smoke-9', playbook: 'smoke', started_ts: 0, worktree: WORKTREE };
  const decoys: FakeRun[] = [
    { run_id: 'smoke-old', playbook: 'smoke', started_ts: Date.now() - 60_000, worktree: WORKTREE },
    { run_id: 'smoke-elsewhere', playbook: 'smoke', started_ts: Date.now() + 60_000, worktree: '/project/work/b' },
    { run_id: 'other-here', playbook: 'other', started_ts: Date.now() + 60_000, worktree: WORKTREE },
  ];
  const targetStatus = sequence(
    { run_id: 'smoke-9', run_status: 'running', driver_alive: true, worktree: WORKTREE },
    { run_id: 'smoke-9', run_status: 'running', driver_alive: true, worktree: WORKTREE },
    { run_id: 'smoke-9', run_status: 'aborted', driver_alive: null, worktree: WORKTREE },
  );

  test('a start that times out is found by playbook, worktree and start time, then stopped', async () => {
    const apb = slowStart(target, decoys, targetStatus);
    const begin = performance.now();
    const outcome = await followRun(apb, { ...FAST, runLimitMs: 200 });
    expect(outcome).toMatchObject({
      kind: 'start_failed',
      recovery: { kind: 'stopped', runId: 'smoke-9', finalStatus: 'aborted' },
    });
    expect(apb.callsTo('run_stop').map((call) => call.args['run_id'])).toEqual(['smoke-9']);
    expect(performance.now() - begin).toBeLessThan(200 + 1000);
  });

  test('a start that created no run reports it not found within the cleanup budget', async () => {
    const apb = slowStart(undefined, decoys, targetStatus);
    const begin = performance.now();
    const outcome = await followRun(apb, { ...FAST, runLimitMs: 200, cleanupBudgetMs: 300 });
    expect(outcome).toMatchObject({ kind: 'start_failed', recovery: { kind: 'not_found' } });
    expect(apb.callsTo('run_stop')).toHaveLength(0);
    expect(performance.now() - begin).toBeLessThan(200 + 300 + 100);
  });

  test('a recovered run that never ends is a cleanup timeout', async () => {
    const apb = slowStart(target, [], sequence({ run_id: 'smoke-9', run_status: 'running', driver_alive: true, worktree: WORKTREE }));
    const outcome = await followRun(apb, { ...FAST, runLimitMs: 200, cleanupBudgetMs: 300 });
    expect(outcome).toMatchObject({
      kind: 'start_failed',
      recovery: { kind: 'cleanup_timeout', runId: 'smoke-9', lastStatus: 'running' },
    });
  });
});

describe('followRun: a start whose lookup cannot run', () => {
  const dead = (): FakeHandler => async () => {
    throw new McpConnectionError({ command: 'apb', reason: 'connection lost', stderrTail: '', pid: 1 });
  };

  test('a dead connection at the start gives up at once with an unknown recovery', async () => {
    const apb = new FakeApb({
      playbook_run: dead(),
      runs_list: dead(),
      run_status: dead(),
      run_stop: dead(),
    });
    const begin = performance.now();
    const outcome = await followRun(apb, { ...FAST, cleanupBudgetMs: 1000 });
    expect(outcome).toMatchObject({ kind: 'start_failed', recovery: { kind: 'unknown' } });
    expect(outcome.kind === 'start_failed' && outcome.recovery.kind === 'unknown' && outcome.recovery.detail).toContain('connection lost');
    expect(apb.callsTo('runs_list')).toHaveLength(0);
    expect(performance.now() - begin).toBeLessThan(100);
  });

  test('a connection that dies during the lookup stops it at once with an unknown recovery', async () => {
    const apb = new FakeApb({ playbook_run: () => never(), runs_list: dead(), run_status: dead(), run_stop: dead() });
    const begin = performance.now();
    const outcome = await followRun(apb, { ...FAST, runLimitMs: 200, cleanupBudgetMs: 1000 });
    expect(outcome).toMatchObject({ kind: 'start_failed', recovery: { kind: 'unknown' } });
    expect(apb.callsTo('runs_list')).toHaveLength(1);
    expect(performance.now() - begin).toBeLessThan(200 + 100);
  });

  test('a closed client during the lookup is an unknown recovery too', async () => {
    const apb = new FakeApb({
      playbook_run: () => never(),
      runs_list: async () => {
        throw new McpClosedError('runs_list');
      },
    });
    const outcome = await followRun(apb, { ...FAST, runLimitMs: 200, cleanupBudgetMs: 1000 });
    expect(outcome).toMatchObject({ kind: 'start_failed', recovery: { kind: 'unknown' } });
    expect(apb.callsTo('runs_list')).toHaveLength(1);
  });

  test('a lookup that never once listed the runs is unknown, not not_found', async () => {
    const apb = new FakeApb({
      playbook_run: () => never(),
      runs_list: async () => {
        throw new McpToolError('runs_list', 'engine error');
      },
    });
    const outcome = await followRun(apb, { ...FAST, runLimitMs: 200, cleanupBudgetMs: 200 });
    expect(outcome).toMatchObject({ kind: 'start_failed', recovery: { kind: 'unknown' } });
    expect(outcome.kind === 'start_failed' && outcome.recovery.kind === 'unknown' && outcome.recovery.detail).toContain('engine error');
    expect(apb.callsTo('runs_list').length).toBeGreaterThan(1);
  });
});

describe('followRun: a connection that dies while the run is followed', () => {
  test('the stop path gives up at once as a cleanup timeout instead of polling a dead connection', async () => {
    const dead: FakeHandler = async () => {
      throw new McpConnectionError({ command: 'apb', reason: 'connection lost', stderrTail: '', pid: 1 });
    };
    const apb = new FakeApb({ playbook_run: started, supervisor_wait_event: dead, run_stop: dead, run_status: dead });
    const begin = performance.now();
    const outcome = await followRun(apb, { ...FAST, cleanupBudgetMs: 1000 });
    expect(outcome).toMatchObject({ kind: 'cleanup_timeout', runId: RUN_ID, reason: 'error', lastStatus: undefined });
    expect(outcome.kind === 'cleanup_timeout' && outcome.detail).toContain('connection lost');
    expect(apb.callsTo('run_status')).toHaveLength(0);
    expect(performance.now() - begin).toBeLessThan(1000);
  });

  const pipeClosed: FakeHandler = async () => {
    throw new McpConnectionError({ command: 'apb', reason: 'pipe closed', stderrTail: '', pid: 1 });
  };

  test('a connection lost at run_stop is named in the detail, not passed off as a budget expiry', async () => {
    const apb = new FakeApb({ playbook_run: started, supervisor_wait_event: sequence(wait('ended', 'paused')), run_stop: pipeClosed });
    const outcome = await followRun(apb, FAST);
    expect(outcome).toMatchObject({ kind: 'cleanup_timeout', reason: 'stalled', lastStatus: undefined });
    expect(outcome.kind === 'cleanup_timeout' && outcome.detail).toContain('in status paused');
    expect(outcome.kind === 'cleanup_timeout' && outcome.detail).toContain('connection lost: MCP server "apb": pipe closed');
  });

  /** `run_status` answers running once, then the connection is gone. */
  const runningThenClosed = (): FakeHandler => {
    let calls = 0;
    return async (args) => {
      calls += 1;
      return calls === 1 ? status('running', true) : pipeClosed(args);
    };
  };

  test('a connection lost while polling run_status is named in the detail with the last status seen', async () => {
    const apb = new FakeApb({
      playbook_run: started,
      supervisor_wait_event: sequence(wait('ended', 'paused')),
      run_stop: stopped,
      run_status: runningThenClosed(),
    });
    const outcome = await followRun(apb, FAST);
    expect(outcome).toMatchObject({ kind: 'cleanup_timeout', reason: 'stalled', lastStatus: 'running' });
    expect(outcome.kind === 'cleanup_timeout' && outcome.detail).toContain('connection lost: MCP server "apb": pipe closed');
  });
});
