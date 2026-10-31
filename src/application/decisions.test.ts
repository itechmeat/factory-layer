import { describe, expect, test } from 'bun:test';

import {
  BRAIN_ABORT_GRACE_MS,
  BRAIN_DECISION_DEADLINE_MS,
  BRAIN_DECISION_RETRIES,
  BRAIN_PLAN_RETRIES,
  RecoveryChoiceSchema,
  type UsageRecord,
  type Verdict,
} from '../domain';
import { BrainError, type BrainDecision, type Sleep } from '../ports';

import { boundedDecision, defaultRecovery, defaultVerdict, type DecisionOutcome } from './decisions';
import { aTask, anExecutorReport, FakeBrain, FakeClock, FakeSink, fakeSleep } from './testing';

/** The usage record the fake brain reports for an attempt started at its base instant. */
const FAKE_RECORD: UsageRecord = {
  at: '2026-01-01T00:00:00.000Z',
  source: 'brain',
  modelSource: 'actual',
  provider: 'fake',
  model: 'fake-brain-1',
  usage: { status: 'measured', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  cost: { status: 'unavailable', reason: 'no price table in the fake brain' },
};

/** The deterministic fixtures and injected time one test runs on. */
interface Env {
  readonly brain: FakeBrain;
  readonly clock: FakeClock;
  readonly sink: FakeSink;
  readonly sleep: Sleep;
}

function env(): Env {
  const clock = new FakeClock();
  return { clock, brain: new FakeBrain({ clock, sleep: fakeSleep(clock) }), sink: new FakeSink(), sleep: fakeSleep(clock) };
}

/** One bounded judge decision on the env, with the correlation a real caller would pass. */
function decide(
  environment: Env,
  call: (signal: AbortSignal) => BrainDecision<Verdict> | Promise<BrainDecision<Verdict>>,
  overrides: { readonly signal?: AbortSignal; readonly deadlineMs?: number; readonly kind?: 'judge' | 'plan' } = {},
): Promise<DecisionOutcome<Verdict>> {
  return boundedDecision<Verdict>({
    kind: overrides.kind ?? 'judge',
    decisionId: 'decision-1',
    runId: 'run-1',
    correlation: { taskId: 'task-1', revision: 1, attempt: 1 },
    call,
    emit: (event) => environment.sink.emit(event),
    now: () => environment.clock.now().toISOString(),
    sleep: environment.sleep,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.deadlineMs === undefined ? {} : { deadlineMs: overrides.deadlineMs }),
  });
}

/** Drains the pending fake-clock microtasks; nothing ever really waits. */
async function settleMicrotasks(): Promise<void> {
  for (let round = 0; round < 25; round += 1) {
    await Promise.resolve();
  }
}

describe('boundedDecision', () => {
  test('answers after a failed attempt, collecting the usage of every attempt', async () => {
    const environment = env();
    environment.brain.failNext('judge', 1, 'brain down');
    environment.brain.script.judge.defaultAnswer({ decision: { outcome: 'accept' } });

    const outcome = await decide(environment, (signal) => environment.brain.judge(aTask(), anExecutorReport(), [], signal));

    expect(environment.brain.callsOf('judge')).toHaveLength(2);
    expect(outcome).toEqual({ ok: true, decision: { outcome: 'accept' }, usage: [FAKE_RECORD, FAKE_RECORD], attempts: 2 });
    const ended = environment.sink.ofType('decision_ended')[0];
    expect(ended?.outcome).toBe('answered');
    expect(ended?.detail).toBe('');
    expect(ended?.usage).toEqual([FAKE_RECORD, FAKE_RECORD]);
  });

  test('defaults after every retry failed and emits exactly started and ended', async () => {
    const environment = env();
    environment.brain.failNext('judge', 3, 'brain down');

    const outcome = await decide(environment, (signal) => environment.brain.judge(aTask(), anExecutorReport(), [], signal));

    expect(environment.brain.callsOf('judge')).toHaveLength(3);
    expect(outcome).toEqual({
      ok: false,
      defaulted: true,
      failure: { reason: 'failed', detail: 'brain down' },
      usage: [FAKE_RECORD, FAKE_RECORD, FAKE_RECORD],
      attempts: 3,
    });
    expect(environment.sink.events).toHaveLength(2);
    expect(environment.sink.ofType('decision_started')[0]).toEqual({
      type: 'decision_started',
      at: '2026-01-01T00:00:00.000Z',
      runId: 'run-1',
      decisionId: 'decision-1',
      kind: 'judge',
      taskId: 'task-1',
      revision: 1,
      attempt: 1,
    });
    expect(environment.sink.ofType('decision_ended')[0]).toEqual({
      type: 'decision_ended',
      at: '2026-01-01T00:00:00.000Z',
      runId: 'run-1',
      decisionId: 'decision-1',
      kind: 'judge',
      taskId: 'task-1',
      revision: 1,
      attempt: 1,
      outcome: 'defaulted',
      usage: [FAKE_RECORD, FAKE_RECORD, FAKE_RECORD],
      detail: 'brain down',
    });
  });

  test('a deadline hit aborts the attempt signal, retries to the end and ends as timeout', async () => {
    const environment = env();
    environment.brain.script.judge.defaultAnswer({ decision: { outcome: 'accept' }, delayMs: 10 * BRAIN_DECISION_DEADLINE_MS });
    let attemptSignal: AbortSignal | undefined;
    const pending = decide(environment, (signal) => {
      attemptSignal = signal;
      return environment.brain.judge(aTask(), anExecutorReport(), [], signal);
    });

    for (let round = 0; round < 1 + BRAIN_DECISION_RETRIES; round += 1) {
      await settleMicrotasks();
      environment.clock.advanceMs(BRAIN_DECISION_DEADLINE_MS);
    }
    const outcome = await pending;

    expect(attemptSignal?.aborted).toBe(true);
    expect(environment.brain.callsOf('judge')).toHaveLength(3);
    expect(environment.brain.callsOf('judge')[2]?.endedAt).toBeNull();
    if (outcome.ok) {
      throw new TypeError('expected a default');
    }
    expect(outcome.failure).toEqual({ reason: 'timeout', detail: 'brain decision exceeded its deadline of 90000 ms' });
    expect(outcome.attempts).toBe(3);
    expect(outcome.usage).toHaveLength(3);
    expect(outcome.usage[0]?.at).toBe('2026-01-01T00:00:00.000Z');
    expect(outcome.usage[1]?.at).toBe('2026-01-01T00:01:30.000Z');
    expect(outcome.usage[2]?.at).toBe('2026-01-01T00:03:00.000Z');
    expect(outcome.usage[2]?.usage).toEqual({
      status: 'measured',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const ended = environment.sink.ofType('decision_ended')[0];
    expect(ended?.at).toBe('2026-01-01T00:04:30.000Z');
    expect(ended?.outcome).toBe('defaulted');
  });

  test('the plan, which the run cannot go on without, gets more attempts than other decisions', async () => {
    const environment = env();
    environment.brain.script.judge.defaultAnswer({ decision: { outcome: 'accept' }, delayMs: 10 * BRAIN_DECISION_DEADLINE_MS });
    const pending = decide(environment, (signal) => environment.brain.judge(aTask(), anExecutorReport(), [], signal), { kind: 'plan' });

    for (let round = 0; round < 1 + BRAIN_PLAN_RETRIES; round += 1) {
      await settleMicrotasks();
      environment.clock.advanceMs(BRAIN_DECISION_DEADLINE_MS);
    }
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(1 + BRAIN_PLAN_RETRIES);
    expect(BRAIN_PLAN_RETRIES).toBeGreaterThan(BRAIN_DECISION_RETRIES);
  });

  test('a deadline from the run options replaces the constant', async () => {
    const environment = env();
    environment.brain.script.judge.defaultAnswer({ decision: { outcome: 'accept' }, delayMs: 10 * BRAIN_DECISION_DEADLINE_MS });
    const pending = decide(environment, (signal) => environment.brain.judge(aTask(), anExecutorReport(), [], signal), { deadlineMs: 1000 });

    for (let round = 0; round < 1 + BRAIN_DECISION_RETRIES; round += 1) {
      await settleMicrotasks();
      environment.clock.advanceMs(1000);
    }
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(environment.clock.now().toISOString()).toBe('2026-01-01T00:00:03.000Z');
    expect(environment.sink.ofType('decision_ended')[0]?.detail).toBe('brain decision exceeded its deadline of 1000 ms');
  });

  test('a call that ignores the abort is abandoned after the grace and settles as timeout', async () => {
    const environment = env();
    let calls = 0;
    const pending = decide(environment, () => {
      calls += 1;
      return new Promise<BrainDecision<Verdict>>(() => {
        // Never settles: the call ignores its abort signal.
      });
    });

    for (let round = 0; round < 1 + BRAIN_DECISION_RETRIES; round += 1) {
      await settleMicrotasks();
      environment.clock.advanceMs(BRAIN_DECISION_DEADLINE_MS);
      await settleMicrotasks();
      environment.clock.advanceMs(BRAIN_ABORT_GRACE_MS);
    }
    const outcome = await pending;

    expect(calls).toBe(3);
    if (outcome.ok) {
      throw new TypeError('expected a default');
    }
    expect(outcome.failure.reason).toBe('timeout');
    expect(outcome.attempts).toBe(3);
    expect(outcome.usage).toHaveLength(3);
    for (const record of outcome.usage) expect(record.usage.status).toBe('unavailable');
  });

  test('the caller signal cancels at once, aborts the in-flight attempt and does not retry', async () => {
    const environment = env();
    const controller = new AbortController();
    environment.brain.script.judge.defaultAnswer({ decision: { outcome: 'accept' }, delayMs: 10 * BRAIN_DECISION_DEADLINE_MS });
    let attemptSignal: AbortSignal | undefined;
    const pending = decide(
      environment,
      (signal) => {
        attemptSignal = signal;
        return environment.brain.judge(aTask(), anExecutorReport(), [], signal);
      },
      { signal: controller.signal },
    );

    controller.abort();
    const outcome = await pending;

    expect(attemptSignal?.aborted).toBe(true);
    expect(environment.brain.callsOf('judge')).toHaveLength(1);
    expect(outcome).toEqual({
      ok: false,
      defaulted: true,
      failure: { reason: 'cancelled', detail: 'cancelled by the caller signal' },
      usage: [
        {
          at: '2026-01-01T00:00:00.000Z',
          source: 'brain',
          modelSource: 'unknown',
          usage: { status: 'unavailable', reason: 'cancelled' },
          cost: { status: 'unavailable', reason: 'cancelled' },
        },
      ],
      attempts: 1,
    });
    expect(environment.sink.ofType('decision_ended')[0]?.usage).toHaveLength(1);
  });

  test('a cancelled attempt keeps the usage its brain error carried', async () => {
    const environment = env();
    const controller = new AbortController();

    const outcome = await decide(
      environment,
      () => {
        controller.abort();
        throw new BrainError({ reason: 'cancelled', detail: 'aborted mid-stream', usage: [FAKE_RECORD] });
      },
      { signal: controller.signal },
    );

    expect(outcome).toEqual({
      ok: false,
      defaulted: true,
      failure: { reason: 'cancelled', detail: 'cancelled by the caller signal' },
      usage: [FAKE_RECORD],
      attempts: 1,
    });
  });

  test('a decision whose caller already aborted makes no call at all', async () => {
    const environment = env();
    const controller = new AbortController();
    controller.abort();

    const outcome = await decide(
      environment,
      () => environment.brain.judge(aTask(), anExecutorReport(), [], new AbortController().signal),
      {
        signal: controller.signal,
      },
    );

    expect(environment.brain.calls).toHaveLength(0);
    expect(environment.sink.events).toHaveLength(2);
    expect(outcome).toEqual({
      ok: false,
      defaulted: true,
      failure: { reason: 'cancelled', detail: 'cancelled by the caller signal' },
      usage: [],
      attempts: 0,
    });
  });

  test('a foreign rejection is synthesized as unavailable usage and retried', async () => {
    const environment = env();
    let calls = 0;

    const outcome = await decide(environment, () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('mcp connection lost');
      }
      const answer: BrainDecision<Verdict> = { decision: { outcome: 'accept' }, usage: [] };
      return Promise.resolve(answer);
    });

    expect(calls).toBe(2);
    expect(outcome).toEqual({
      ok: true,
      decision: { outcome: 'accept' },
      usage: [
        {
          at: '2026-01-01T00:00:00.000Z',
          source: 'brain',
          modelSource: 'unknown',
          usage: { status: 'unavailable', reason: 'brain call threw' },
          cost: { status: 'unavailable', reason: 'brain call threw' },
        },
      ],
      attempts: 2,
    });
  });

  test('a BrainError without usage gets one synthesized unavailable record too', async () => {
    const environment = env();
    let calls = 0;

    const outcome = await decide(environment, () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new BrainError({ reason: 'failed', detail: 'empty usage', usage: [] }));
      }
      return Promise.resolve({ decision: { outcome: 'accept' }, usage: [] });
    });

    expect(calls).toBe(2);
    if (!outcome.ok) {
      throw new TypeError('expected an answer');
    }
    expect(outcome.attempts).toBe(2);
    expect(outcome.usage).toEqual([
      {
        at: '2026-01-01T00:00:00.000Z',
        source: 'brain',
        modelSource: 'unknown',
        usage: { status: 'unavailable', reason: 'brain call threw' },
        cost: { status: 'unavailable', reason: 'brain call threw' },
      },
    ]);
  });
});

describe('decision defaults', () => {
  test('the verdict default rejects because the brain was unavailable', () => {
    const verdict = defaultVerdict();
    expect(verdict).toEqual({ outcome: 'reject', reasons: ['brain_unavailable'], failedCheckIds: [] });
  });

  test('the recovery default gives up because the brain was unavailable', () => {
    const recovery = defaultRecovery();
    expect(recovery).toEqual({ choice: 'give_up', reason: 'brain_unavailable' });
    expect(RecoveryChoiceSchema.parse(recovery)).toEqual(recovery);
  });
});
