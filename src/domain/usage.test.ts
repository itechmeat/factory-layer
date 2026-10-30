import { describe, expect, test } from 'bun:test';

import { UsageRecordSchema, aggregateUsage, computeCost, type ModelPrice, type Usage } from './usage';

type MeasuredUsage = Extract<Usage, { status: 'measured' }>;

const measured = (inputTokens: number, outputTokens: number, cache: { read?: number; write?: number } = {}): MeasuredUsage => ({
  status: 'measured',
  inputTokens,
  outputTokens,
  cacheReadTokens: cache.read ?? 0,
  cacheWriteTokens: cache.write ?? 0,
});
const reported = (inputTokens: number, outputTokens: number, reportedCostUsd: number): Usage => ({
  ...measured(inputTokens, outputTokens),
  reportedCostUsd,
});
const estimated = (inputTokens: number, outputTokens: number, basis: string): Usage => ({
  status: 'estimated',
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  basis,
});
const unavailable = (reason: string): Usage => ({ status: 'unavailable', reason });

const priced: ModelPrice = {
  available: true,
  inputUsdPerMillion: 3,
  outputUsdPerMillion: 10,
  cacheReadUsdPerMillion: 0.3,
  cacheWriteUsdPerMillion: 3.75,
};
const noPrice: ModelPrice = { available: false, reason: 'model not in the price table' };

describe('computeCost', () => {
  test('an unavailable usage stays unavailable with the usage reason', () => {
    expect(computeCost(unavailable('provider reported no usage'), priced)).toEqual({
      status: 'unavailable',
      reason: 'provider reported no usage',
    });
  });

  test('a measured usage without a price is unavailable with the price reason', () => {
    expect(computeCost(measured(1000, 500), noPrice)).toEqual({
      status: 'unavailable',
      reason: 'model not in the price table',
    });
  });

  test('a measured usage with a price is priced per million tokens', () => {
    // 500_000 input at 3 USD per million is 1.5; 250_000 output at 10 is 2.5.
    expect(computeCost(measured(500_000, 250_000), priced)).toEqual({ status: 'priced', amountUsd: 4, basis: 'computed' });
  });

  test('cache read and cache write tokens are priced at their own prices', () => {
    // 1_000_000 cache read at 0.3 is 0.3; 2_000_000 cache write at 3.75 is 7.5.
    const cost = computeCost(measured(0, 0, { read: 1_000_000, write: 2_000_000 }), priced);
    expect(cost).toEqual({ status: 'priced', amountUsd: 7.8, basis: 'computed' });
  });

  test('an estimated usage with a price is priced from the estimated tokens', () => {
    expect(computeCost(estimated(1_000_000, 0, 'prompt chars / 4'), priced)).toEqual({ status: 'priced', amountUsd: 3, basis: 'computed' });
  });

  test('a reported cost wins over the price table and is marked reported', () => {
    expect(computeCost(reported(500_000, 250_000, 0.42), priced)).toEqual({ status: 'priced', amountUsd: 0.42, basis: 'reported' });
  });

  test('a reported cost needs no price', () => {
    expect(computeCost(reported(10, 5, 0.01), noPrice)).toEqual({ status: 'priced', amountUsd: 0.01, basis: 'reported' });
  });
});

describe('aggregateUsage', () => {
  test('no parts is unavailable as no usage with no unavailable parts', () => {
    expect(aggregateUsage([])).toEqual({ usage: { status: 'unavailable', reason: 'no usage' }, unavailableParts: 0 });
  });

  test('only unavailable parts stay unavailable with every part counted', () => {
    const total = aggregateUsage([unavailable('a'), unavailable('b'), unavailable('c')]);
    expect(total).toEqual({ usage: { status: 'unavailable', reason: 'a; b; c' }, unavailableParts: 3 });
  });

  test('a measured part keeps its tokens next to an unavailable part', () => {
    const total = aggregateUsage([measured(100, 40), unavailable('node attempt reported no usage')]);
    expect(total.usage).toEqual(measured(100, 40));
    expect(total.unavailableParts).toBe(1);
  });

  test('estimated and measured parts sum as estimated over distinct bases', () => {
    const total = aggregateUsage([
      estimated(10, 5, 'chars / 4'),
      estimated(1, 1, 'padded minimum'),
      measured(20, 15, { read: 7, write: 3 }),
    ]);
    expect(total.usage).toEqual({
      status: 'estimated',
      inputTokens: 31,
      outputTokens: 21,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
      basis: 'chars / 4+padded minimum',
    });
    expect(total.unavailableParts).toBe(0);
  });

  test('an estimated part next to an unavailable part stays estimated and counts the part', () => {
    const total = aggregateUsage([estimated(10, 5, 'chars / 4'), unavailable('none')]);
    expect(total.usage).toEqual(estimated(10, 5, 'chars / 4'));
    expect(total.unavailableParts).toBe(1);
  });

  test('only measured parts sum as measured', () => {
    const total = aggregateUsage([measured(1, 2), measured(3, 4)]);
    expect(total).toEqual({ usage: measured(4, 6), unavailableParts: 0 });
  });

  test('cache tokens are summed across measured parts', () => {
    const total = aggregateUsage([measured(1, 1, { read: 10, write: 2 }), measured(1, 1, { read: 5, write: 0 })]);
    expect(total.usage).toEqual(measured(2, 2, { read: 15, write: 2 }));
  });

  test('reported costs are summed when every measured part reports one', () => {
    const total = aggregateUsage([reported(1, 1, 0.25), reported(2, 2, 0.5), unavailable('none')]);
    expect(total.usage).toEqual(reported(3, 3, 0.75));
    expect(total.unavailableParts).toBe(1);
  });

  test('the reported cost total is dropped when one measured part reports none', () => {
    const total = aggregateUsage([reported(1, 1, 0.25), measured(2, 2)]);
    expect(total.usage).toEqual(measured(3, 3));
  });

  test('the reported cost total is dropped when an estimated part is present', () => {
    const total = aggregateUsage([reported(1, 1, 0.25), estimated(2, 2, 'chars / 4')]);
    expect(total.usage).toEqual(estimated(3, 3, 'chars / 4'));
  });
});

describe('UsageRecordSchema', () => {
  const cost = { status: 'priced' as const, amountUsd: 0.0045, basis: 'computed' as const };
  const at = '2026-10-30T12:00:00.000Z';

  test('a brain record parses with per-attempt provenance', () => {
    const record = {
      at,
      source: 'brain',
      modelSource: 'actual',
      provider: 'zai',
      model: 'glm-4.7',
      usage: measured(1200, 300),
      cost,
      decisionId: 'decision-1',
      decisionKind: 'judge',
      taskId: 'task-1',
      revision: 2,
      attempt: 3,
    };
    const parsed = UsageRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
  });

  test('an executor record parses with per-node provenance', () => {
    const record = {
      at,
      source: 'executor',
      modelSource: 'unknown',
      usage: unavailable('node attempt reported no usage'),
      cost: { status: 'unavailable' as const, reason: 'node attempt reported no usage' },
      executorRunId: 'run-7',
      nodeId: 'implement',
      taskId: 'task-1',
      revision: 1,
      attempt: 1,
    };
    expect(UsageRecordSchema.safeParse(record).success).toBe(true);
  });

  test('a record with only the required fields parses', () => {
    const record = {
      at,
      source: 'brain',
      modelSource: 'expected',
      usage: estimated(1, 2, 'padded minimum'),
      cost: { status: 'unavailable' as const, reason: 'no price' },
    };
    expect(UsageRecordSchema.safeParse(record).success).toBe(true);
  });

  test('an unknown source or decision kind is rejected', () => {
    const base = { at, modelSource: 'actual', usage: measured(1, 1), cost };
    expect(UsageRecordSchema.safeParse({ ...base, source: 'osb' }).success).toBe(false);
    expect(UsageRecordSchema.safeParse({ ...base, source: 'brain', decisionKind: 'vibes' }).success).toBe(false);
  });

  test('a bad instant or an attempt below one is rejected', () => {
    const base = { source: 'brain' as const, modelSource: 'actual' as const, usage: measured(1, 1), cost };
    expect(UsageRecordSchema.safeParse({ ...base, at: 'yesterday' }).success).toBe(false);
    expect(UsageRecordSchema.safeParse({ ...base, at, attempt: 0 }).success).toBe(false);
    expect(UsageRecordSchema.safeParse({ ...base, at, revision: 1.5 }).success).toBe(false);
  });

  test('a record without a model source, or with an unknown one, is rejected', () => {
    const base = { at, source: 'executor' as const, usage: measured(1, 1), cost };
    expect(UsageRecordSchema.safeParse(base).success).toBe(false);
    expect(UsageRecordSchema.safeParse({ ...base, modelSource: 'guessed' }).success).toBe(false);
  });

  test('a priced cost without a basis, or a negative cache count, is rejected', () => {
    const base = { at, source: 'brain' as const, modelSource: 'actual' as const };
    expect(UsageRecordSchema.safeParse({ ...base, usage: measured(1, 1), cost: { status: 'priced', amountUsd: 1 } }).success).toBe(false);
    expect(UsageRecordSchema.safeParse({ ...base, usage: { ...measured(1, 1), cacheReadTokens: -1 }, cost }).success).toBe(false);
  });
});
