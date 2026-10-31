import { describe, expect, test } from 'bun:test';

import {
  BRAIN_DECISION_DEADLINE_MS,
  EXECUTOR_STALL_LIMIT_MS,
  RUN_REPLAN_BUDGET,
  RUN_TASK_CONCURRENCY,
  RunOptionsSchema,
  RuntimeSchema,
  TASK_ATTEMPT_BUDGET,
  resolveRunLimits,
} from './limits';

describe('RunOptionsSchema', () => {
  test('fills the defaults for an empty input', () => {
    expect(RunOptionsSchema.parse({})).toEqual({
      requiredRuntimes: ['bun'],
      deliverUnverified: false,
    });
  });

  test('keeps explicit values', () => {
    expect(
      RunOptionsSchema.parse({
        requiredRuntimes: ['npm'],
        deliverUnverified: true,
        outDir: 'out/box',
      }),
    ).toEqual({ requiredRuntimes: ['npm'], deliverUnverified: true, outDir: 'out/box' });
  });

  test('options saved by an older run with secrets parse without them, so no key is saved again', () => {
    expect(JSON.stringify(RunOptionsSchema.parse({ secrets: ['hush'] }))).not.toContain('hush');
  });

  test('rejects a runtime outside the supported set, naming the path', () => {
    const parsed = RunOptionsSchema.safeParse({ requiredRuntimes: ['deno'] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(['requiredRuntimes', 0]);
  });

  test('rejects an empty requiredRuntimes list', () => {
    expect(() => RunOptionsSchema.parse({ requiredRuntimes: [] })).toThrow();
  });
});

describe('run limit overrides', () => {
  test('without overrides the limits are the factory constants', () => {
    expect(resolveRunLimits(RunOptionsSchema.parse({}))).toEqual({
      taskAttemptBudget: TASK_ATTEMPT_BUDGET,
      runReplanBudget: RUN_REPLAN_BUDGET,
      runTaskConcurrency: RUN_TASK_CONCURRENCY,
      executorStallLimitMs: EXECUTOR_STALL_LIMIT_MS,
      brainDecisionDeadlineMs: BRAIN_DECISION_DEADLINE_MS,
    });
  });

  test('a run overrides each budget and limit through validated options', () => {
    const options = RunOptionsSchema.parse({
      taskAttemptBudget: 5,
      runReplanBudget: 0,
      runTaskConcurrency: 1,
      executorStallLimitMs: 30_000,
      brainDecisionDeadlineMs: 5_000,
    });
    expect(resolveRunLimits(options)).toEqual({
      taskAttemptBudget: 5,
      runReplanBudget: 0,
      runTaskConcurrency: 1,
      executorStallLimitMs: 30_000,
      brainDecisionDeadlineMs: 5_000,
    });
  });

  test('rejects overrides outside their range, naming the field', () => {
    for (const [field, value] of [
      ['taskAttemptBudget', 0],
      ['runReplanBudget', -1],
      ['runTaskConcurrency', 1.5],
      ['executorStallLimitMs', 0],
      ['brainDecisionDeadlineMs', -5],
    ] as const) {
      const parsed = RunOptionsSchema.safeParse({ [field]: value });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual([field]);
    }
  });
});

describe('RuntimeSchema', () => {
  test('accepts exactly the supported runtimes', () => {
    expect(RuntimeSchema.parse('bun')).toBe('bun');
    expect(RuntimeSchema.parse('npm')).toBe('npm');
    expect(() => RuntimeSchema.parse('yarn')).toThrow();
  });
});
