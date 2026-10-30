import { describe, expect, test } from 'bun:test';

import { TASK_STATES, TaskRunStateSchema, TaskStateSchema, assertTransition, isReady, resetForReplan, type TaskRunState } from './task';

describe('TASK_STATES', () => {
  test('the state schema parses every state and rejects the rest', () => {
    for (const state of TASK_STATES) {
      expect(TaskStateSchema.safeParse(state).success).toBe(true);
    }
    expect(TaskStateSchema.safeParse('queued').success).toBe(false);
  });
});

describe('canTransition', () => {});

describe('assertTransition', () => {
  test('pending to accepted throws naming both states', () => {
    expect(() => assertTransition('pending', 'accepted')).toThrow(/pending -> accepted/);
  });

  test('an allowed transition does not throw', () => {
    expect(() => assertTransition('pending', 'ready')).not.toThrow();
    expect(() => assertTransition('integrating', 'recovering')).not.toThrow();
  });
});

describe('isReady', () => {
  test('ready when every dependency is integrated', () => {
    expect(isReady(['a', 'b'], (id) => (id === 'a' || id === 'b' ? 'integrated' : undefined))).toBe(true);
  });

  test('not ready while a dependency is running', () => {
    expect(isReady(['a'], (id) => (id === 'a' ? 'running' : undefined))).toBe(false);
  });

  test('not ready while one dependency is integrated and another is only accepted', () => {
    expect(isReady(['a', 'b'], (id) => (id === 'a' ? 'integrated' : 'accepted'))).toBe(false);
  });

  test('ready with no dependencies', () => {
    expect(isReady([], () => 'failed')).toBe(true);
  });

  test('not ready when a dependency has no recorded state', () => {
    expect(isReady(['ghost'], () => undefined)).toBe(false);
  });
});

describe('TaskRunStateSchema', () => {
  test('parses a live entry without a fail reason', () => {
    expect(TaskRunStateSchema.parse({ revision: 1, state: 'running', attemptsUsed: 1 })).toEqual({
      revision: 1,
      state: 'running',
      attemptsUsed: 1,
    });
  });

  test('rejects a zero revision, a negative attempt count and an unknown state', () => {
    expect(TaskRunStateSchema.safeParse({ revision: 0, state: 'pending', attemptsUsed: 0 }).success).toBe(false);
    expect(TaskRunStateSchema.safeParse({ revision: 1, state: 'pending', attemptsUsed: -1 }).success).toBe(false);
    expect(TaskRunStateSchema.safeParse({ revision: 1, state: 'queued', attemptsUsed: 0 }).success).toBe(false);
  });
});

describe('resetForReplan', () => {
  test('gives a new revision, a pending state and a fresh budget', () => {
    const previous: TaskRunState = { revision: 2, state: 'failed', attemptsUsed: 3, failReason: 'verdict_rejected' };
    expect(resetForReplan(previous, 3)).toEqual({ revision: 3, state: 'pending', attemptsUsed: 0 });
  });
});
