/**
 * The Brain port: the typed decisions the application may ask of the brain
 * (plan, correction, re-plan, acceptance checks and their review, verdict,
 * recovery choice, playbook proposal). The brain only decides; it never orchestrates and it
 * never sees an adapter or SDK type.
 */

import type { AcceptanceCheck, CheckObjection, CheckResult } from '../domain/acceptance';
import type { PlaybookDraft, RecoveryChoice, TaskFailure, TaskHistoryEntry, Verdict } from '../domain/decisions';
import type { Plan, PlanInvalidReason, PlanTask } from '../domain/plan';
import type { Spec } from '../domain/spec';
import type { UsageRecord } from '../domain/usage';
import type { ExecutorReport } from './executor';
import type { RecalledRun } from './memory';

/** One brain answer: the typed decision and the usage records it incurred. */
export interface BrainDecision<D> {
  readonly decision: D;
  readonly usage: readonly UsageRecord[];
}

/** Typed brain failure; carries the usage records already incurred. */
export class BrainError extends Error {
  readonly reason: 'failed' | 'timeout' | 'cancelled';
  readonly usage: readonly UsageRecord[];

  constructor(info: { reason: 'failed' | 'timeout' | 'cancelled'; detail: string; usage: readonly UsageRecord[] }) {
    super(info.detail);
    this.name = 'BrainError';
    this.reason = info.reason;
    this.usage = info.usage;
  }
}

/**
 * The brain of the factory. Every decision is a call the application bounds
 * and retries: the caller enforces the decision deadline (default
 * BRAIN_DECISION_DEADLINE_MS, milliseconds) and retries up to
 * BRAIN_DECISION_RETRIES times; the port itself never waits unbounded. Every
 * method rejects with BrainError ('failed', 'timeout' or 'cancelled')
 * carrying the usage incurred so far; it never hangs and never reports a
 * failure as a string. An aborted signal ends the call with reason
 * 'cancelled'.
 */
export interface Brain {
  /**
   * Produces the initial plan for a spec, informed by the recalled past
   * runs. Deadline: bounded by the caller at BRAIN_DECISION_DEADLINE_MS
   * (milliseconds), retried up to BRAIN_DECISION_RETRIES times; the signal
   * aborts early. Failure: rejects with BrainError carrying the usage
   * incurred so far; never hangs.
   */
  plan(spec: Spec, recalled: readonly RecalledRun[], signal: AbortSignal): Promise<BrainDecision<Plan>>;

  /**
   * Repairs an invalid plan from the exact validation reasons. Deadline:
   * bounded by the caller at BRAIN_DECISION_DEADLINE_MS (milliseconds),
   * retried up to BRAIN_DECISION_RETRIES times; the signal aborts early.
   * Failure: rejects with BrainError carrying the usage incurred so far;
   * never hangs. An invalid repaired plan is the application's concern: the
   * answer is still a decision.
   */
  correctPlan(spec: Spec, plan: Plan, reasons: readonly PlanInvalidReason[], signal: AbortSignal): Promise<BrainDecision<Plan>>;

  /**
   * Produces a replacement plan that keeps the integrated tasks unchanged,
   * given the failure that triggered the re-plan. Deadline: bounded by the
   * caller at BRAIN_DECISION_DEADLINE_MS (milliseconds), retried up to
   * BRAIN_DECISION_RETRIES times; the signal aborts early. Failure: rejects
   * with BrainError carrying the usage incurred so far; never hangs.
   */
  replan(spec: Spec, plan: Plan, failure: TaskFailure, integrated: readonly string[], signal: AbortSignal): Promise<BrainDecision<Plan>>;

  /**
   * Derives the acceptance checks a delivery must pass. Deadline: bounded
   * by the caller at BRAIN_DECISION_DEADLINE_MS (milliseconds), retried up
   * to BRAIN_DECISION_RETRIES times; the signal aborts early. Failure:
   * rejects with BrainError carrying the usage incurred so far; never
   * hangs. An empty array is a valid answer (no acceptance checks) and
   * caps the run outcome at `partial`.
   */
  deriveAcceptance(spec: Spec, signal: AbortSignal): Promise<BrainDecision<readonly AcceptanceCheck[]>>;

  /**
   * Reviews derived acceptance checks against the spec: an objection names
   * a check whose expectation contradicts the spec, its cited source or one
   * of the `examples` (the checks taken from the spec's own examples, which
   * are authoritative); an empty array means every check stands. `results`
   * are the check results when the checks already ran (at delivery), else
   * empty. Deadline: bounded by the caller at BRAIN_DECISION_DEADLINE_MS
   * (milliseconds), retried up to BRAIN_DECISION_RETRIES times; the signal
   * aborts early. Failure: rejects with BrainError carrying the usage
   * incurred so far; never hangs.
   */
  reviewAcceptance(
    spec: Spec,
    examples: readonly AcceptanceCheck[],
    checks: readonly AcceptanceCheck[],
    results: readonly CheckResult[],
    signal: AbortSignal,
  ): Promise<BrainDecision<readonly CheckObjection[]>>;

  /**
   * Judges a finished task from the executor report and the check results.
   * Deadline: bounded by the caller at BRAIN_DECISION_DEADLINE_MS
   * (milliseconds), retried up to BRAIN_DECISION_RETRIES times; the signal
   * aborts early. Failure: rejects with BrainError carrying the usage
   * incurred so far; never hangs.
   */
  judge(task: PlanTask, report: ExecutorReport, checkResults: readonly CheckResult[], signal: AbortSignal): Promise<BrainDecision<Verdict>>;

  /**
   * Chooses what to do with a failed attempt, given the failure and the
   * task's history. Deadline: bounded by the caller at
   * BRAIN_DECISION_DEADLINE_MS (milliseconds), retried up to
   * BRAIN_DECISION_RETRIES times; the signal aborts early. Failure: rejects
   * with BrainError carrying the usage incurred so far; never hangs.
   */
  chooseRecovery(
    task: PlanTask,
    failure: TaskFailure,
    history: readonly TaskHistoryEntry[],
    signal: AbortSignal,
  ): Promise<BrainDecision<RecoveryChoice>>;

  /**
   * Proposes a playbook for a kind of task from examples; `null` means the
   * brain found none. Deadline: bounded by the caller at
   * BRAIN_DECISION_DEADLINE_MS (milliseconds), retried up to
   * BRAIN_DECISION_RETRIES times; the signal aborts early. Failure: rejects
   * with BrainError carrying the usage incurred so far; never hangs.
   */
  proposePlaybook(taskKind: string, examples: readonly string[], signal: AbortSignal): Promise<BrainDecision<PlaybookDraft | null>>;
}
