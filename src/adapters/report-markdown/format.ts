/**
 * Formatting helpers for the Markdown report: durations, usage totals (cache
 * tokens included), cost summaries with their reported or computed basis,
 * and model names with their source. Every unavailable value renders as
 * unavailable with its reason, never as a zero.
 */

import type { UsageRecord, UsageTotal } from '../../domain';

import type { CostSummary } from './aggregate';

/** Renders a duration in milliseconds as a compact human string, e.g. `2m 50s`. */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

/**
 * Renders a usage total: input, output, cache read and cache write tokens
 * for measured and estimated totals (the estimated basis stated), the reason for an unavailable total, and the
 * number of unavailable parts whenever token-bearing parts sit next to
 * unavailable ones.
 */
export function formatUsageTotal(total: UsageTotal): string {
  const usage = total.usage;
  let body: string;
  if (usage.status === 'unavailable') {
    body = `unavailable (${usage.reason})`;
  } else if (usage.status === 'estimated') {
    body = `${formatTokens(usage)} (estimated: ${usage.basis})`;
  } else {
    body = formatTokens(usage);
  }
  if (usage.status !== 'unavailable' && total.unavailableParts > 0) {
    body += ` (+${total.unavailableParts} unavailable ${total.unavailableParts === 1 ? 'part' : 'parts'})`;
  }
  return body;
}

function formatTokens(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): string {
  return `${usage.inputTokens} in / ${usage.outputTokens} out / ${usage.cacheReadTokens} cache read / ${usage.cacheWriteTokens} cache write`;
}

/**
 * Renders a cost summary: the summed priced amount in USD with its basis
 * (`reported`, `computed`, or the count of each when mixed) plus the number
 * of unavailable cost parts, `unavailable` with the reasons when nothing was
 * priced, and `unavailable (no usage)` when there are no records at all.
 */
export function formatCosts(summary: CostSummary): string {
  if (summary.pricedCount > 0) {
    let body = `${formatUsd(summary.pricedUsd)} (${formatCostBasis(summary)})`;
    if (summary.unavailableParts > 0) {
      body += ` (+${summary.unavailableParts} unavailable cost ${summary.unavailableParts === 1 ? 'part' : 'parts'})`;
    }
    return body;
  }
  if (summary.unavailableParts > 0) {
    return `unavailable (${summary.reasons.join('; ')})`;
  }
  return 'unavailable (no usage)';
}

function formatCostBasis(summary: CostSummary): string {
  const computedCount = summary.pricedCount - summary.reportedCount;
  if (computedCount === 0) return 'reported';
  if (summary.reportedCount === 0) return 'computed';
  return `reported ${summary.reportedCount}, computed ${computedCount}`;
}

/** Renders a USD amount with six decimals, trailing zeros trimmed. */
export function formatUsd(amountUsd: number): string {
  return `$${Number(amountUsd.toFixed(6)).toString()}`;
}

/** One record's provider/model with its source, e.g. `zai/glm-4.7 (actual)`; `unavailable (<source>)` without a model. */
export function formatModel(record: UsageRecord): string {
  if (record.model === undefined) return `unavailable (${record.modelSource})`;
  const name = record.provider === undefined ? record.model : `${record.provider}/${record.model}`;
  return `${name} (${record.modelSource})`;
}

/**
 * The distinct provider/model names of the records with their source, in
 * first-appearance order; `unavailable` when no record names a model.
 */
export function formatModels(records: readonly UsageRecord[]): string {
  const labels: string[] = [];
  for (const record of records) {
    if (record.model === undefined) continue;
    const label = formatModel(record);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.length === 0 ? 'unavailable' : labels.join(', ');
}
