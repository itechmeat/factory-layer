import { describe, expect, test } from 'bun:test';

import { ApbExecutor } from './apb-executor';
import { answerOf, eventsOf, recorded } from './testing/apb-fixtures';
import { FakeApb } from './testing/fake-apb';

const FAST = { startMs: 300, callMs: 300, waitMarginMs: 50, lookupMs: 300, pollIntervalMs: 10 };

type Event = Record<string, unknown>;

function agentEvents(): Event[] {
  return eventsOf('run_events-agent-succeeded');
}

function reportOf(report: unknown, events: Event[]): Promise<Awaited<ReturnType<ApbExecutor['report']>>> {
  const apb = new FakeApb({ run_report: async () => report, run_events: async () => ({ events }) });
  return new ApbExecutor(async () => apb, FAST).report('implement-task-1793367914147');
}

describe('report: usage per attempt', () => {
  test('a finished agent attempt carries its tokens, cache tokens, the reported cost and the model the CLI named', async () => {
    const report = await reportOf(recorded('run_report-agent-succeeded').answer, agentEvents());
    expect(report.usage).toEqual([
      {
        at: new Date(1_793_367_924_932).toISOString(),
        source: 'executor',
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        modelSource: 'actual',
        usage: {
          status: 'measured',
          inputTokens: 8,
          outputTokens: 774,
          cacheReadTokens: 68_687,
          cacheWriteTokens: 7663,
          reportedCostUsd: 0.045_276_699_999_999_996,
        },
        cost: { status: 'priced', amountUsd: 0.045_276_699_999_999_996, basis: 'reported' },
        executorRunId: 'implement-task-1793367914147',
        nodeId: 'implement',
        attempt: 1,
      },
    ]);
    expect(report.nodes.map(({ nodeId, outcome, attempts }) => ({ nodeId, outcome, attempts }))).toEqual([
      { nodeId: 'implement', outcome: 'succeeded', attempts: 1 },
    ]);
    expect(report.nodes[0]?.summary).toStartWith("Added hello.ts exporting hello() returning 'hi'");
  });

  test('an attempt without usage, and one that never finished, are unavailable with the reason; the others are unaffected', async () => {
    const events = agentEvents();
    const started = events.find((event) => event['type'] === 'attempt_started') ?? {};
    const finished = events.find((event) => event['type'] === 'attempt_finished') ?? {};
    const noUsage = { ...finished, seq: 101, usage: null };
    events.push({ ...started, seq: 100 }, noUsage, { ...started, seq: 102, ts: 1_793_367_999_000 });
    const report = await reportOf(recorded('run_report-agent-succeeded').answer, events);
    expect(report.usage.map((record) => [record.attempt, record.usage.status])).toEqual([
      [1, 'measured'],
      [2, 'unavailable'],
      [3, 'unavailable'],
    ]);
    expect(report.usage[1]?.usage).toEqual({ status: 'unavailable', reason: 'the agent CLI reported no usage for the attempt' });
    expect(report.usage[2]?.usage).toEqual({ status: 'unavailable', reason: 'the attempt never finished' });
    expect(report.usage[2]?.at).toBe(new Date(1_793_367_999_000).toISOString());
  });

  test('an attempt left open does not shift the pairing: a finish belongs to the latest open start of its node', async () => {
    const events = agentEvents();
    const started = events.find((event) => event['type'] === 'attempt_started') ?? {};
    const finished = events.find((event) => event['type'] === 'attempt_finished') ?? {};
    events.push(
      { ...started, seq: 100, ts: 1_793_367_990_000 },
      { ...started, seq: 101, ts: 1_793_367_995_000 },
      { ...finished, seq: 102, ts: 1_793_367_999_000 },
    );
    const report = await reportOf(recorded('run_report-agent-succeeded').answer, events);
    expect(report.usage.map((record) => [record.attempt, record.usage.status, record.at])).toEqual([
      [1, 'measured', new Date(1_793_367_924_932).toISOString()],
      [2, 'unavailable', new Date(1_793_367_990_000).toISOString()],
      [3, 'measured', new Date(1_793_367_999_000).toISOString()],
    ]);
    expect(report.usage[1]?.usage).toEqual({ status: 'unavailable', reason: 'the attempt never finished' });
  });

  test('a model the CLI did not name falls back to the expected one, marked; without either it is unknown', async () => {
    const expectedOnly = answerOf('run_report-agent-succeeded');
    expectedOnly['attempt_models'] = [{ node: 'implement', attempt: 1, agent: 'claude', expected: 'claude-sonnet-5-5', model: null }];
    expect((await reportOf(expectedOnly, agentEvents())).usage[0]).toMatchObject({ model: 'claude-sonnet-5-5', modelSource: 'expected' });

    const none = answerOf('run_report-agent-succeeded');
    delete none['attempt_models'];
    const events = agentEvents().map((event) => (event['type'] === 'attempt_started' ? { ...event, model: null } : event));
    const record = (await reportOf(none, events)).usage[0];
    expect(record).toMatchObject({ modelSource: 'unknown', provider: 'claude' });
    expect(record?.model).toBeUndefined();
  });
});

describe('report: run and node states', () => {
  test('a retried script node counts both starts, has no usage, and a run the factory did not stop stays aborted', async () => {
    const events = eventsOf('run_events-script-retried-stopped');
    const report = await reportOf(recorded('run_report-aborted').answer, events);
    expect(report.status).toBe('aborted');
    expect(report.nodes).toEqual([{ nodeId: 'boom', outcome: 'failed', summary: 'smoke-fail: about to exit 1', attempts: 2 }]);
    expect(report.usage).toEqual([]);
  });

  test('a run the factory stopped is reported stopped', async () => {
    const apb = new FakeApb({
      run_stop: async () => recorded('run_stop-live').answer,
      run_status: async () => recorded('run_status-aborted').answer,
      run_report: async () => recorded('run_report-aborted').answer,
      run_events: async () => recorded('run_events-script-retried-stopped').answer,
      supervisor_wait_event: async () => answerOf('supervisor_wait_event-parked'),
    });
    const executor = new ApbExecutor(async () => apb, FAST);
    await executor.attach('smoke-fail-1793367583063', 'sv-token-0123456789');
    await executor.stop('smoke-fail-1793367583063', 500);
    expect((await executor.report('smoke-fail-1793367583063')).status).toBe('stopped');
  });

  test('a run that is not finished has no report yet', async () => {
    const running = { ...answerOf('run_report-aborted'), run_status: 'running' };
    await expect(reportOf(running, [])).rejects.toMatchObject({ name: 'ExecutorError', reason: 'failed' });
  });
});
