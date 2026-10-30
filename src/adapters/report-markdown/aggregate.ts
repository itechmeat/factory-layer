/**
 * Computations behind the Markdown report: what the trace says about tasks,
 * decisions and usage. Pure functions over trace events alone; they tolerate
 * partial traces (missing run ends, unpaired decision starts, events out of
 * order) by returning what the events prove and leaving the rest unavailable.
 */

import { DECISION_KINDS } from '../../domain';

import type { DecisionEndedEvent, DecisionKind, RunOutcome, TraceEvent, UsageRecord } from '../../domain';

export interface DecisionInterval {
  readonly decisionId: string;
  readonly kind: DecisionKind;
  readonly taskId: string | null;
  readonly startAt: string;
  readonly endAt: string;
}

/** The priced total, how many priced parts there were (and how many of them were reported), and the unavailable parts. */
export interface CostSummary {
  readonly pricedUsd: number;
  readonly pricedCount: number;
  readonly reportedCount: number;
  readonly unavailableParts: number;
  readonly reasons: readonly string[];
}

export interface TaskStats {
  readonly taskId: string;
  readonly finalState: string | null;
  readonly attempts: number;
  readonly wallTimeMs: number | null;
  readonly records: readonly UsageRecord[];
}

export interface RunFraming {
  readonly outcome: RunOutcome | null;
  readonly reason: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

const parse = (iso: string): number => Date.parse(iso);

/** The run framing events: outcome, reason and the start and end instants. */
export function runFraming(events: readonly TraceEvent[]): RunFraming {
  let outcome: RunOutcome | null = null;
  let reason: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  for (const event of events) {
    if (event.type === 'run_started') {
      startedAt = pickEarliest(startedAt, event.at);
    }
    if (event.type === 'run_ended') {
      endedAt = pickLatest(endedAt, event.at);
      outcome = event.outcome;
      reason = event.reason;
    }
  }
  return { outcome, reason, startedAt, endedAt };
}

function pickEarliest(current: string | null, candidate: string): string {
  return current === null || parse(candidate) < parse(current) ? candidate : current;
}

function pickLatest(current: string | null, candidate: string): string {
  return current === null || parse(candidate) > parse(current) ? candidate : current;
}

/**
 * Pairs decision_started and decision_ended events by decision id (first
 * occurrence wins) and returns the paired intervals sorted by start time.
 * An unpaired start produces no interval.
 */
export function decisionIntervals(events: readonly TraceEvent[]): readonly DecisionInterval[] {
  const starts = new Map<string, Extract<TraceEvent, { type: 'decision_started' }>>();
  const ends = new Map<string, DecisionEndedEvent>();
  for (const event of events) {
    // A decision without an id cannot be paired with its counterpart.
    if (event.type === 'decision_started' && event.decisionId !== undefined && !starts.has(event.decisionId)) {
      starts.set(event.decisionId, event);
    }
    if (event.type === 'decision_ended' && event.decisionId !== undefined && !ends.has(event.decisionId)) {
      ends.set(event.decisionId, event);
    }
  }
  const intervals: DecisionInterval[] = [];
  for (const [decisionId, start] of starts) {
    const end = ends.get(decisionId);
    if (end === undefined) continue;
    intervals.push({ decisionId, kind: end.kind, taskId: start.taskId ?? null, startAt: start.at, endAt: end.at });
  }
  return intervals.toSorted((a, b) => parse(a.startAt) - parse(b.startAt));
}

/** The label of one decision: kind@taskId, or just the kind at run level. */
export function decisionLabel(interval: DecisionInterval): string {
  return interval.taskId === null ? interval.kind : `${interval.kind}@${interval.taskId}`;
}

/**
 * The pairs of decision intervals that were in flight at the same time:
 * [s1, e1] and [s2, e2] overlap when s1 < e2 and s2 < e1 (touching ends do
 * not count).
 */
export function overlappingPairs(intervals: readonly DecisionInterval[]): readonly (readonly [DecisionInterval, DecisionInterval])[] {
  const pairs: (readonly [DecisionInterval, DecisionInterval])[] = [];
  for (let i = 0; i < intervals.length; i++) {
    const first = intervals[i];
    if (first === undefined) continue;
    for (let j = i + 1; j < intervals.length; j++) {
      const second = intervals[j];
      if (second === undefined) continue;
      if (parse(first.startAt) < parse(second.endAt) && parse(second.startAt) < parse(first.endAt)) {
        pairs.push([first, second]);
      }
    }
  }
  return pairs;
}

/** Every usage record the trace carries: brain decisions plus executor runs. */
export function allUsageRecords(events: readonly TraceEvent[]): readonly UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const event of events) {
    if (event.type === 'decision_ended' || event.type === 'executor_ended') {
      records.push(...event.usage);
    }
  }
  return records;
}

/** One executor usage record with the task and attempt it belongs to (the record's own, else its event's). */
export interface ExecutorRecordRow {
  readonly taskId: string | null;
  readonly attempt: number | null;
  readonly record: UsageRecord;
}

/** Every executor usage record in trace order, correlated through its executor_ended event where it names nothing itself. */
export function executorRecords(events: readonly TraceEvent[]): readonly ExecutorRecordRow[] {
  const rows: ExecutorRecordRow[] = [];
  for (const event of events) {
    if (event.type !== 'executor_ended') continue;
    for (const record of event.usage) {
      rows.push({ taskId: record.taskId ?? event.taskId ?? null, attempt: record.attempt ?? event.attempt ?? null, record });
    }
  }
  return rows;
}

/** The usage records of the decision_ended events of one decision kind. */
export function usageOfKind(events: readonly TraceEvent[], kind: DecisionKind): readonly UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const event of events) {
    if (event.type === 'decision_ended' && event.kind === kind) {
      records.push(...event.usage);
    }
  }
  return records;
}

/** The decision kinds the trace has decision_ended events for, kind order. */
export function decisionKindsPresent(events: readonly TraceEvent[]): readonly DecisionKind[] {
  const present = new Set<DecisionKind>();
  for (const event of events) {
    if (event.type === 'decision_ended') present.add(event.kind);
  }
  return DECISION_KINDS.filter((kind) => present.has(kind));
}

/** The per-task rows: attempts (distinct task runs), final state, wall time and usage records. */
export function taskStats(events: readonly TraceEvent[]): readonly TaskStats[] {
  const framing = runFraming(events);
  const order: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.taskId !== undefined && !seen.has(event.taskId)) {
      seen.add(event.taskId);
      order.push(event.taskId);
    }
  }

  return order.map((taskId) => {
    const ownEvents = events.filter((event) => event.taskId === taskId);
    const dispatches = ownEvents.filter((event) => event.type === 'executor_started');
    // An attempt is one task run (revision, attempt); repair and integrate runs work inside an attempt.
    const attempts = new Set(
      dispatches
        .filter((event) => event.role === 'task')
        .map((event, index) =>
          event.revision === undefined || event.attempt === undefined
            ? `#${String(index)}`
            : `${String(event.revision)}/${String(event.attempt)}`,
        ),
    ).size;
    const firstDispatchAt = dispatches.reduce<string | null>((earliest, event) => pickEarliest(earliest, event.at), null);

    let finalState: string | null = null;
    let lastStateAt: string | null = null;
    for (const event of ownEvents) {
      if (event.type === 'task_state_changed' && (lastStateAt === null || parse(event.at) >= parse(lastStateAt))) {
        lastStateAt = event.at;
        finalState = event.to;
      }
    }

    const records = recordsForTask(events, taskId);
    const wallTimeMs =
      attempts === 0 || firstDispatchAt === null ? null : endOfTask(lastStateAt, framing.endedAt, firstDispatchAt) - parse(firstDispatchAt);

    return { taskId, finalState, attempts, wallTimeMs, records };
  });
}

function endOfTask(lastStateAt: string | null, runEndedAt: string | null, firstDispatchAt: string): number {
  if (lastStateAt !== null) return parse(lastStateAt);
  if (runEndedAt !== null) return parse(runEndedAt);
  return parse(firstDispatchAt);
}

/**
 * The usage records of one task: the usage of its decision_ended events plus
 * the executor_ended records that correlate with it, either by their own task
 * id or through the task id of their event.
 */
function recordsForTask(events: readonly TraceEvent[], taskId: string): readonly UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const event of events) {
    if (event.type === 'decision_ended' && event.taskId === taskId) {
      records.push(...event.usage);
    }
    if (event.type === 'executor_ended') {
      if (event.taskId !== taskId) continue;
      for (const record of event.usage) {
        if (record.taskId === undefined || record.taskId === taskId) records.push(record);
      }
    }
  }
  return records;
}

/** Sums the priced costs of the records, counts the reported ones and the unavailable parts. */
export function sumCosts(records: readonly UsageRecord[]): CostSummary {
  let pricedUsd = 0;
  let pricedCount = 0;
  let reportedCount = 0;
  const reasons: string[] = [];
  for (const record of records) {
    if (record.cost.status === 'priced') {
      pricedUsd += record.cost.amountUsd;
      pricedCount++;
      if (record.cost.basis === 'reported') reportedCount++;
    } else {
      reasons.push(record.cost.reason);
    }
  }
  return { pricedUsd, pricedCount, reportedCount, unavailableParts: reasons.length, reasons };
}
