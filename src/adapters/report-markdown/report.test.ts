/**
 * Tests for the Markdown report adapter: every report section rendered from
 * one fixture trace, the empty intervention sentence, tolerance of partial
 * traces.
 */

import { describe, expect, test } from 'bun:test';

import type {
  DecisionEndedEvent,
  DecisionStartedEvent,
  ExecutorStartedEvent,
  InterventionRecordedEvent,
  RunEndedEvent,
  RunStartedEvent,
  TaskStateChangedEvent,
  TraceEvent,
  UsageRecord,
} from '../../domain';
import { taskStats } from './aggregate';
import { renderReport } from './report';

// ---- fixture time helpers (ISO UTC instants, offsets in seconds) ----

const T0 = '2026-10-30T10:00:00.000Z';
const at = (offsetSeconds: number): string => new Date(Date.parse(T0) + offsetSeconds * 1000).toISOString();

// ---- typed event builders ----

function runStarted(offset: number): RunStartedEvent {
  return { type: 'run_started', at: at(offset), runId: 'run-1', specName: 'todo-cli' };
}

function runEnded(offset: number, outcome: 'succeeded' | 'partial' | 'failed', reason: string | null): RunEndedEvent {
  return { type: 'run_ended', at: at(offset), runId: 'run-1', outcome, reason };
}

function stateChange(
  offset: number,
  taskId: string,
  from: TaskStateChangedEvent['from'],
  to: TaskStateChangedEvent['to'],
): TaskStateChangedEvent {
  return { type: 'task_state_changed', at: at(offset), runId: 'run-1', taskId, revision: 1, from, to, reason: 'test' };
}

function executorStarted(offset: number, taskId: string, attempt: number): ExecutorStartedEvent {
  return {
    type: 'executor_started',
    at: at(offset),
    runId: 'run-1',
    taskId,
    revision: 1,
    attempt,
    dispatchKey: `run-1|${taskId}|r1|a${attempt}`,
    playbook: 'cli-feature',
    tree: `${taskId}-r1`,
    role: 'task',
  };
}

function decisionStarted(offset: number, decisionId: string, kind: DecisionStartedEvent['kind'], taskId?: string): DecisionStartedEvent {
  return taskId === undefined
    ? { type: 'decision_started', at: at(offset), runId: 'run-1', decisionId, kind }
    : { type: 'decision_started', at: at(offset), runId: 'run-1', taskId, decisionId, kind };
}

function decisionEnded(
  offset: number,
  decisionId: string,
  kind: DecisionEndedEvent['kind'],
  taskId: string | undefined,
  outcome: DecisionEndedEvent['outcome'],
  usage: readonly UsageRecord[],
): DecisionEndedEvent {
  return taskId === undefined
    ? { type: 'decision_ended', at: at(offset), runId: 'run-1', decisionId, kind, outcome, usage: [...usage], detail: 'test' }
    : { type: 'decision_ended', at: at(offset), runId: 'run-1', taskId, decisionId, kind, outcome, usage: [...usage], detail: 'test' };
}

function measuredRecord(
  offset: number,
  info: {
    source: UsageRecord['source'];
    inTok: number;
    outTok: number;
    costUsd: number;
    modelSource: UsageRecord['modelSource'];
    costBasis?: 'reported' | 'computed';
    cacheRead?: number;
    cacheWrite?: number;
    provider?: string;
    model?: string;
    taskId?: string;
    nodeId?: string;
  },
): UsageRecord {
  const basis = info.costBasis ?? 'computed';
  return {
    at: at(offset),
    source: info.source,
    ...(info.provider === undefined ? {} : { provider: info.provider }),
    ...(info.model === undefined ? {} : { model: info.model }),
    modelSource: info.modelSource,
    usage: {
      status: 'measured',
      inputTokens: info.inTok,
      outputTokens: info.outTok,
      cacheReadTokens: info.cacheRead ?? 0,
      cacheWriteTokens: info.cacheWrite ?? 0,
      ...(basis === 'reported' ? { reportedCostUsd: info.costUsd } : {}),
    },
    cost: { status: 'priced', amountUsd: info.costUsd, basis },
    ...(info.taskId === undefined ? {} : { taskId: info.taskId }),
    ...(info.nodeId === undefined ? {} : { nodeId: info.nodeId }),
  };
}

function unavailableRecord(offset: number, source: UsageRecord['source'], reason: string, taskId?: string): UsageRecord {
  return {
    at: at(offset),
    source,
    modelSource: 'unknown',
    usage: { status: 'unavailable', reason },
    cost: { status: 'unavailable', reason },
    ...(taskId === undefined ? {} : { taskId }),
  };
}

// ---- the full fixture trace ----

function fullTrace(): TraceEvent[] {
  return [
    runStarted(0),
    // An unpaired decision start: tolerated, never becomes an interval.
    decisionStarted(1, 'd-plan-1', 'plan'),
    // task-a: dispatched once, judged, accepted, integrated.
    stateChange(5, 'task-a', 'pending', 'ready'),
    executorStarted(10, 'task-a', 1),
    stateChange(12, 'task-a', 'ready', 'running'),
    decisionStarted(20, 'd-judge-1', 'judge', 'task-a'),
    decisionStarted(30, 'd-acc-1', 'acceptance'),
    decisionEnded(40, 'd-judge-1', 'judge', 'task-a', 'answered', [
      measuredRecord(40, {
        source: 'brain',
        modelSource: 'actual',
        inTok: 100,
        outTok: 50,
        costUsd: 0.00105,
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        taskId: 'task-a',
      }),
    ]),
    decisionEnded(70, 'd-acc-1', 'acceptance', undefined, 'answered', [
      {
        at: at(70),
        source: 'brain',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        modelSource: 'actual',
        usage: { status: 'estimated', inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, basis: 'node count' },
        cost: { status: 'priced', amountUsd: 0.0021, basis: 'computed' },
      },
    ]),
    {
      type: 'checks_run',
      at: at(60),
      runId: 'run-1',
      taskId: 'task-a',
      revision: 1,
      scope: 'task',
      results: [
        { checkId: 'cli-help', status: 'failed', reasons: ['exit code mismatch: expected 0, got 1'], detail: '' },
        { checkId: 'cli-version', status: 'passed', reasons: [], detail: '' },
      ],
    },
    stateChange(41, 'task-a', 'running', 'judging'),
    stateChange(75, 'task-a', 'judging', 'accepted'),
    stateChange(120, 'task-a', 'accepted', 'integrating'),
    stateChange(180, 'task-a', 'integrating', 'integrated'),
    {
      type: 'executor_ended',
      at: at(180),
      runId: 'run-1',
      taskId: 'task-a',
      revision: 1,
      attempt: 1,
      status: 'succeeded',
      usage: [
        measuredRecord(180, {
          source: 'executor',
          modelSource: 'actual',
          inTok: 300,
          outTok: 150,
          cacheRead: 1000,
          cacheWrite: 50,
          costUsd: 0.00315,
          costBasis: 'reported',
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          taskId: 'task-a',
          nodeId: 'implement',
        }),
      ],
    },
    // task-b: two attempts, one recovery, failed in the end.
    executorStarted(10, 'task-b', 1),
    executorStarted(60, 'task-b', 2),
    decisionStarted(65, 'd-rec-1', 'recovery', 'task-b'),
    decisionEnded(90, 'd-rec-1', 'recovery', 'task-b', 'defaulted', [unavailableRecord(90, 'brain', 'provider reported none', 'task-b')]),
    // A re-plan that starts the instant the recovery ends: touching intervals, not an overlap.
    decisionStarted(90, 'd-replan-1', 'replan'),
    decisionEnded(95, 'd-replan-1', 'replan', undefined, 'answered', []),
    {
      type: 'recovery_chosen',
      at: at(92),
      runId: 'run-1',
      taskId: 'task-b',
      revision: 1,
      attempt: 2,
      choice: 'retry',
      detail: 'rerun the failing node',
    },
    stateChange(93, 'task-b', 'running', 'failed'),
    {
      type: 'executor_ended',
      at: at(240),
      runId: 'run-1',
      taskId: 'task-b',
      revision: 1,
      attempt: 2,
      status: 'failed',
      usage: [
        measuredRecord(240, {
          source: 'executor',
          modelSource: 'expected',
          inTok: 400,
          outTok: 200,
          costUsd: 0.0042,
          provider: 'openai',
          model: 'gpt-5.2',
          taskId: 'task-b',
        }),
        // No taskId on the record: it correlates through the event's task.
        measuredRecord(240, { source: 'executor', modelSource: 'unknown', inTok: 10, outTok: 5, costUsd: 0.00015 }),
      ],
    },
    // A run-level executor run (no task id): its unavailable usage belongs to
    // no task row and only shows in the totals.
    {
      type: 'executor_ended',
      at: at(200),
      runId: 'run-1',
      status: 'failed',
      usage: [unavailableRecord(200, 'executor', 'integrate run reported none')],
    },
    // task-c: ready but never dispatched.
    stateChange(6, 'task-c', 'pending', 'ready'),
    // A delivery check that errored: errored counts as failed here.
    {
      type: 'checks_run',
      at: at(230),
      runId: 'run-1',
      scope: 'delivery',
      results: [{ checkId: 'http-health', status: 'errored', reasons: ['server did not start'], detail: '' }],
    },
    runEnded(240, 'partial', null),
  ];
}

describe('renderReport', () => {
  test('renders every section from a full trace', () => {
    const markdown = renderReport(fullTrace(), { title: 'Run report: todo-cli' });

    // Title and run framing.
    expect(markdown).toContain('# Run report: todo-cli');
    expect(markdown).toContain('- Outcome: partial');
    expect(markdown).toContain(`- Wall time: 4m (${T0} -> ${at(240)})`);

    // Task rows: final state, attempts, wall time, models with their source, tokens with cache, cost with its basis.
    expect(markdown).toContain(
      '| task-a | integrated | 1 | 2m 50s | anthropic/claude-sonnet-4 (actual) | 400 in / 200 out / 1000 cache read / 50 cache write | $0.0042 (reported 1, computed 1) |',
    );
    expect(markdown).toContain(
      '| task-b | failed | 2 | 1m 23s | openai/gpt-5.2 (expected) | 410 in / 205 out / 0 cache read / 0 cache write (+1 unavailable part) | $0.00435 (computed) (+1 unavailable cost part) |',
    );
    // Never dispatched: wall time is a dash, tokens and cost are unavailable, never zero.
    expect(markdown).toContain('| task-c | ready | 0 | - | unavailable | unavailable (no usage) | unavailable (no usage) |');

    // Totals: the aggregate over every record in the trace, unavailable parts stated.
    expect(markdown).toContain(
      '- Tokens: 1010 in / 505 out / 1000 cache read / 50 cache write (estimated: node count) (+2 unavailable parts)',
    );
    expect(markdown).toContain('- Cost: $0.01065 (reported 1, computed 4) (+2 unavailable cost parts)');

    // Executor usage: one line per executor record, its model with the model source.
    expect(markdown).toContain(
      '- task-a, attempt 1, node implement: anthropic/claude-sonnet-4 (actual), 300 in / 150 out / 1000 cache read / 50 cache write, $0.00315 (reported)',
    );
    expect(markdown).toContain(
      '- task-b, attempt 2, node -: openai/gpt-5.2 (expected), 400 in / 200 out / 0 cache read / 0 cache write, $0.0042 (computed)',
    );
    expect(markdown).toContain(
      '- task-b, attempt 2, node -: unavailable (unknown), 10 in / 5 out / 0 cache read / 0 cache write, $0.00015 (computed)',
    );
    expect(markdown).toContain(
      '- run, attempt -, node -: unavailable (unknown), unavailable (integrate run reported none), unavailable (integrate run reported none)',
    );

    // Brain usage per decision kind; the unpaired plan start adds no kind.
    expect(markdown).toContain(
      '- acceptance: 200 in / 100 out / 0 cache read / 0 cache write (estimated: node count), cost $0.0021 (computed)',
    );
    expect(markdown).toContain('- judge: 100 in / 50 out / 0 cache read / 0 cache write, cost $0.00105 (computed)');
    expect(markdown).toContain('- recovery: unavailable (provider reported none), cost unavailable (provider reported none)');
    expect(markdown).not.toContain('- plan:');

    // Decision intervals and the overlapping pair; the unpaired start is absent.
    expect(markdown).toContain(`- judge@task-a: ${at(20)} -> ${at(40)}`);
    expect(markdown).toContain(`- acceptance: ${at(30)} -> ${at(70)}`);
    expect(markdown).toContain('- judge@task-a overlaps acceptance');
    expect(markdown).toContain('- acceptance overlaps recovery@task-b');
    expect(markdown).toContain(`- replan: ${at(90)} -> ${at(95)}`);
    expect(markdown).not.toContain('recovery@task-b overlaps replan');
    expect(markdown).not.toContain('plan@');

    // Recoveries and failed checks (failed AND errored).
    expect(markdown).toContain('- task-b: retry (rerun the failing node)');
    expect(markdown).toContain('- cli-help (failed, task): exit code mismatch: expected 0, got 1');
    expect(markdown).toContain('- http-health (errored, delivery): server did not start');

    // Empty intervention log: the exact sentence.
    expect(markdown).toContain('No human intervention was recorded.');
  });

  test('lists a recorded intervention instead of the empty sentence', () => {
    const intervention: InterventionRecordedEvent = {
      type: 'intervention_recorded',
      at: at(250),
      runId: 'run-1',
      note: 'approved one extra attempt for task-b',
    };
    const markdown = renderReport([...fullTrace(), intervention], { title: 'Run report: todo-cli' });

    expect(markdown).toContain(`- ${at(250)}: approved one extra attempt for task-b`);
    expect(markdown).not.toContain('No human intervention was recorded.');
  });

  test('tolerates a trace with no run_ended event', () => {
    const markdown = renderReport([runStarted(0)], { title: 'Partial trace' });

    expect(markdown).toContain('- Outcome: unavailable');
    expect(markdown).toContain('- Wall time: unavailable');
    expect(markdown).toContain('No tasks were recorded.');
    expect(markdown).toContain('No executor usage was recorded.');
    expect(markdown).toContain('No human intervention was recorded.');
  });

  test('renders the empty trace without throwing', () => {
    const markdown = renderReport([], { title: 'Nothing happened' });
    expect(markdown).toContain('# Nothing happened');
    expect(markdown).toContain('- Outcome: unavailable');
  });

  test('the attempts of a task count its task runs, not its repair or integrate runs', () => {
    const repair: ExecutorStartedEvent = { ...executorStarted(3, 'task-a', 1), role: 'repair', dispatchKey: 'run-1|task-a|r1|a1|repair' };
    const integrate: ExecutorStartedEvent = {
      ...executorStarted(4, 'task-a', 2),
      role: 'integrate',
      dispatchKey: 'run-1|task-a|r1|a2|int',
    };
    const events = [runStarted(0), executorStarted(1, 'task-a', 1), executorStarted(2, 'task-a', 2), repair, integrate];
    expect(taskStats(events).find((row) => row.taskId === 'task-a')?.attempts).toBe(2);
  });
});
