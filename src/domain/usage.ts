/**
 * Token usage and cost as the factory records them: what one brain attempt or
 * one executor node attempt spent, priced honestly or marked unavailable, plus
 * the aggregation that keeps an unavailable part visible instead of summing it
 * to zero. Also the kinds of brain decisions records correlate with.
 */

import { z } from 'zod';

// ---- decision kinds (correlation labels for records and trace events) ----

/** What the brain was deciding when a usage record was incurred. */
export type DecisionKind =
  | 'plan'
  | 'correct_plan'
  | 'replan'
  | 'acceptance'
  | 'acceptance_review'
  | 'judge'
  | 'recovery'
  | 'playbook'
  | 'playbook_review';

export const DECISION_KINDS: readonly DecisionKind[] = [
  'plan',
  'correct_plan',
  'replan',
  'acceptance',
  'acceptance_review',
  'judge',
  'recovery',
  'playbook',
  'playbook_review',
];

// ---- usage, price, cost ----

/** The token counts every token-bearing usage carries; cache counts are 0 when the source reports none. */
interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/**
 * The token spending of one attempt. `measured` comes from a source that
 * reports tokens, optionally with the cost it charged; `estimated` states
 * the basis it was derived from; `unavailable` keeps the reason rather than
 * inventing numbers.
 */
export type Usage =
  | ({ readonly status: 'measured'; readonly reportedCostUsd?: number | undefined } & TokenCounts)
  | ({ readonly status: 'estimated'; readonly basis: string } & TokenCounts)
  | { readonly status: 'unavailable'; readonly reason: string };

/** The per-million prices of one model (input, output, cache read, cache write), or why they are unknown. */
export type ModelPrice =
  | {
      readonly available: true;
      readonly inputUsdPerMillion: number;
      readonly outputUsdPerMillion: number;
      readonly cacheReadUsdPerMillion: number;
      readonly cacheWriteUsdPerMillion: number;
    }
  | { readonly available: false; readonly reason: string };

/**
 * A priced amount in USD, `reported` when the usage's source stated it and
 * `computed` when it is tokens times prices, or why no cost could be computed.
 */
export type Cost =
  | { readonly status: 'priced'; readonly amountUsd: number; readonly basis: 'reported' | 'computed' }
  | { readonly status: 'unavailable'; readonly reason: string };

const TokenCountsSchema = {
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
};

const MeasuredUsageSchema = z.object({
  status: z.literal('measured'),
  ...TokenCountsSchema,
  reportedCostUsd: z.number().nonnegative().optional(),
});
const EstimatedUsageSchema = z.object({ status: z.literal('estimated'), ...TokenCountsSchema, basis: z.string().min(1) });
const UnavailableUsageSchema = z.object({ status: z.literal('unavailable'), reason: z.string().min(1) });

export const UsageSchema: z.ZodType<Usage> = z.discriminatedUnion('status', [
  MeasuredUsageSchema,
  EstimatedUsageSchema,
  UnavailableUsageSchema,
]);

/** Validates a model price read from a price file. */
export const ModelPriceSchema: z.ZodType<ModelPrice> = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
    inputUsdPerMillion: z.number().nonnegative(),
    outputUsdPerMillion: z.number().nonnegative(),
    cacheReadUsdPerMillion: z.number().nonnegative(),
    cacheWriteUsdPerMillion: z.number().nonnegative(),
  }),
  z.object({ available: z.literal(false), reason: z.string().min(1) }),
]);

export const CostSchema: z.ZodType<Cost> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('priced'), amountUsd: z.number(), basis: z.enum(['reported', 'computed']) }),
  z.object({ status: z.literal('unavailable'), reason: z.string().min(1) }),
]);

/** Tokens per price unit: prices are stated per million tokens. */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * Prices one attempt. An unavailable usage wins over the price question, so
 * the cost carries the usage's reason; a cost the source reported is used
 * as is (basis `reported`, no price needed); otherwise it needs an available
 * price and the amount is each token count over 1e6 times its own price
 * (input, output, cache read, cache write), basis `computed`.
 */
export function computeCost(usage: Usage, price: ModelPrice): Cost {
  if (usage.status === 'unavailable') {
    return { status: 'unavailable', reason: usage.reason };
  }
  if (usage.status === 'measured' && usage.reportedCostUsd !== undefined) {
    return { status: 'priced', amountUsd: usage.reportedCostUsd, basis: 'reported' };
  }
  if (!price.available) {
    return { status: 'unavailable', reason: price.reason };
  }
  const amountUsd =
    (usage.inputTokens / TOKENS_PER_PRICE_UNIT) * price.inputUsdPerMillion +
    (usage.outputTokens / TOKENS_PER_PRICE_UNIT) * price.outputUsdPerMillion +
    (usage.cacheReadTokens / TOKENS_PER_PRICE_UNIT) * price.cacheReadUsdPerMillion +
    (usage.cacheWriteTokens / TOKENS_PER_PRICE_UNIT) * price.cacheWriteUsdPerMillion;
  return { status: 'priced', amountUsd, basis: 'computed' };
}

// ---- aggregation ----

/** The sum of several usages plus how many of them reported nothing. */
export interface UsageTotal {
  readonly usage: Usage;
  readonly unavailableParts: number;
}

/**
 * Sums usages without ever turning an unavailable part into zero. No parts is
 * `no usage`; only unavailable parts join their reasons with '; '; any
 * estimated part makes the total estimated (distinct bases joined with '+');
 * otherwise the measured tokens (cache counts included) are summed, with a
 * reported cost total only when every measured part reported one. The
 * unavailable count rides along in every case that has token-bearing parts.
 */
export function aggregateUsage(parts: readonly Usage[]): UsageTotal {
  if (parts.length === 0) {
    return { usage: { status: 'unavailable', reason: 'no usage' }, unavailableParts: 0 };
  }
  const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let reportedCostUsd: number | undefined = 0;
  const bases: string[] = [];
  const reasons: string[] = [];
  for (const part of parts) {
    if (part.status === 'unavailable') {
      reasons.push(part.reason);
      continue;
    }
    tokens.inputTokens += part.inputTokens;
    tokens.outputTokens += part.outputTokens;
    tokens.cacheReadTokens += part.cacheReadTokens;
    tokens.cacheWriteTokens += part.cacheWriteTokens;
    if (part.status === 'estimated') {
      if (!bases.includes(part.basis)) bases.push(part.basis);
    } else {
      reportedCostUsd =
        reportedCostUsd === undefined || part.reportedCostUsd === undefined ? undefined : reportedCostUsd + part.reportedCostUsd;
    }
  }
  const unavailableParts = reasons.length;
  if (unavailableParts === parts.length) {
    return { usage: { status: 'unavailable', reason: reasons.join('; ') }, unavailableParts };
  }
  if (bases.length > 0) {
    return { usage: { status: 'estimated', ...tokens, basis: bases.join('+') }, unavailableParts };
  }
  const reported = reportedCostUsd === undefined ? {} : { reportedCostUsd };
  return { usage: { status: 'measured', ...tokens, ...reported }, unavailableParts };
}

// ---- usage records ----

/**
 * One attempt's spending with its provenance: a brain call attempt (failed
 * retries included) or one executor node attempt, with the correlation ids of
 * where it happened. The provider and model are present when known;
 * `modelSource` says whether the model is the one that `actual`ly ran, the
 * one `expected` from a profile, or `unknown`. A failed decision carries the
 * records already incurred.
 */
export const UsageRecordSchema = z.object({
  at: z.iso.datetime(),
  source: z.enum(['brain', 'executor']),
  provider: z.string().optional(),
  model: z.string().optional(),
  modelSource: z.enum(['actual', 'expected', 'unknown']),
  usage: UsageSchema,
  cost: CostSchema,
  // correlation (all optional, present where they apply)
  decisionId: z.string().optional(),
  decisionKind: z.enum(DECISION_KINDS).optional(),
  executorRunId: z.string().optional(),
  nodeId: z.string().optional(),
  taskId: z.string().optional(),
  revision: z.number().int().positive().optional(),
  attempt: z.number().int().positive().optional(),
});

export type UsageRecord = z.infer<typeof UsageRecordSchema>;
