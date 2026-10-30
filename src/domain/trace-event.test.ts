import { describe, expect, test } from 'bun:test';

import { TraceEventSchema } from './trace-event';
import type { DecisionEndedEvent, ExecutorObservedEvent } from './trace-event';

describe('TraceEventSchema', () => {
  test('parses a fully correlated executor event', () => {
    const event: ExecutorObservedEvent = {
      type: 'executor_event',
      at: '2026-01-15T09:00:00.000Z',
      runId: 'run-2026-01-15-todo-cli',
      specName: 'todo-cli',
      taskId: 'api',
      revision: 2,
      attempt: 1,
      executorRunId: 'apb-run-42',
      nodeId: 'implement',
      kind: 'wake',
      trigger: 'node_failed',
      seq: 12,
      detail: 'node implement failed',
    };
    const parsed = TraceEventSchema.parse(event);
    expect(parsed).toEqual(event);
  });

  test('parses a decision_ended event with usage records', () => {
    const event: DecisionEndedEvent = {
      type: 'decision_ended',
      at: '2026-01-15T09:01:00.000Z',
      runId: 'run-2026-01-15-todo-cli',
      specName: 'todo-cli',
      decisionId: 'decision-7',
      decisionKind: 'judge',
      kind: 'judge',
      outcome: 'answered',
      usage: [
        {
          at: '2026-01-15T09:00:59.000Z',
          source: 'brain',
          modelSource: 'actual',
          provider: 'test-provider',
          model: 'test-model',
          usage: { status: 'measured', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: { status: 'priced', amountUsd: 0.01, basis: 'computed' },
          decisionId: 'decision-7',
          decisionKind: 'judge',
        },
      ],
      detail: 'verdict reached',
    };
    const parsed = TraceEventSchema.parse(event);
    expect(parsed).toEqual(event);
  });

  test('rejects an unknown type', () => {
    const parsed = TraceEventSchema.safeParse({
      type: 'teleported',
      at: '2026-01-15T09:00:00.000Z',
      runId: 'run-2026-01-15-todo-cli',
    });
    expect(parsed.success).toBe(false);
  });

  test('rejects a bad instant, naming the path', () => {
    const parsed = TraceEventSchema.safeParse({
      type: 'run_started',
      at: '2026-01-15 09:00:00',
      runId: 'run-2026-01-15-todo-cli',
      specName: 'todo-cli',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.path).toContain('at');
  });
});
