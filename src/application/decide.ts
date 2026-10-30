/**
 * The run's brain decisions and usage pricing: every decision goes through
 * boundedDecision with the run's resolved deadline, a deterministic decision
 * id (unique per run: a resumed session prefixes its resume instant) and the run's cancellation signal, and every usage record that reaches
 * the trace (brain attempts and executor node attempts) is priced with the
 * cost table when its source reported tokens and a model but no cost.
 */

import { computeCost, type DecisionKind, type UsageRecord } from '../domain';
import type { BrainDecision, CostTable, Sleep } from '../ports';

import { boundedDecision, type DecisionCorrelation, type DecisionOutcome } from './decisions';
import type { RunTrace } from './run-trace';

/** Where a usage record belongs; filled in where the record names nothing. */
export interface RecordCorrelation {
  readonly taskId?: string;
  readonly revision?: number;
  readonly attempt?: number;
  readonly executorRunId?: string;
}

/**
 * Prices the records that carry tokens and a model but no cost, and adds the
 * correlation fields a record does not name yet. Records with a cost (or
 * without a model) are kept as they are: nothing is invented.
 */
export function priceRecords(records: readonly UsageRecord[], costs: CostTable, correlation: RecordCorrelation = {}): UsageRecord[] {
  return records.map((record) => {
    const cost =
      record.cost.status === 'unavailable' && record.usage.status !== 'unavailable' && record.model !== undefined
        ? computeCost(record.usage, costs.price(record.model))
        : record.cost;
    return { ...correlation, ...record, cost };
  });
}

export class Decider {
  private readonly trace: RunTrace;
  private readonly sleep: Sleep;
  private readonly costs: CostTable;
  private readonly deadlineMs: number;
  private readonly signal: AbortSignal;
  private readonly prefix: string;
  private nextNumber = 1;

  /** `epoch` (a resumed session's) prefixes every decision id, so ids stay unique across resumes of one run. */
  constructor(info: { trace: RunTrace; sleep: Sleep; costs: CostTable; deadlineMs: number; signal: AbortSignal; epoch?: string }) {
    this.trace = info.trace;
    this.prefix = info.epoch === undefined ? '' : `${info.epoch}-`;
    this.sleep = info.sleep;
    this.costs = info.costs;
    this.deadlineMs = info.deadlineMs;
    this.signal = info.signal;
  }

  /**
   * One bounded decision of the kind; `signal` (when given) cancels it too,
   * besides the run's own signal. The caller applies the kind's default when
   * the outcome is not ok.
   */
  decide<D>(
    kind: DecisionKind,
    correlation: DecisionCorrelation,
    call: (signal: AbortSignal) => Promise<BrainDecision<D>>,
    signal?: AbortSignal,
  ): Promise<DecisionOutcome<D>> {
    const decisionId = `${this.prefix}${kind}-${this.nextNumber}`;
    this.nextNumber += 1;
    return boundedDecision<D>({
      kind,
      decisionId,
      runId: this.trace.runId,
      correlation,
      call,
      emit: (event) => {
        this.trace.emitEvent(event.type === 'decision_ended' ? { ...event, usage: priceRecords(event.usage, this.costs) } : event);
      },
      now: () => this.trace.now(),
      sleep: this.sleep,
      signal: signal === undefined ? this.signal : AbortSignal.any([this.signal, signal]),
      deadlineMs: this.deadlineMs,
    });
  }
}
