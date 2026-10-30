/**
 * Bounded brain decisions: one brain call raced against the decision deadline
 * and retried, with every attempt's usage collected and exactly two trace
 * events (decision_started, decision_ended). The wrapper never applies a
 * default itself; on failure it reports `defaulted` and the caller applies
 * the default of the decision kind (plan fails the run, acceptance continues
 * without checks, verdict rejects, recovery gives up, re-plan keeps the
 * plan). The deadline races through the injected sleep, so tests run it on
 * the fake clock with no real waiting.
 */

import {
  BRAIN_ABORT_GRACE_MS,
  BRAIN_DECISION_DEADLINE_MS,
  BRAIN_DECISION_RETRIES,
  type DecisionKind,
  type RecoveryChoice,
  type TraceEvent,
  type Usage,
  type UsageRecord,
  type Verdict,
} from '../domain';
import { BrainError, type BrainDecision, type Sleep } from '../ports';

/** The reason every default names when the brain could not decide. */
const BRAIN_UNAVAILABLE = 'brain_unavailable';
/** The usage reason recorded for a failed attempt that reported no usage. */
const THREW_REASON = 'brain call threw';
/** The detail of a decision the caller's signal cancelled. */
const CANCELLED_DETAIL = 'cancelled by the caller signal';
/** The usage reason recorded for a timed out call that ignored the abort and never settled. */
const ABANDONED_REASON = 'brain call ignored the abort and was abandoned';
/** The usage reason recorded for a cancelled attempt whose usage is not known. */
const CANCELLED_REASON = 'cancelled';

/** Why a decision ended without an answer, as the caller and the trace see it. */
export interface DecisionFailure {
  readonly reason: 'failed' | 'timeout' | 'cancelled';
  readonly detail: string;
}

/**
 * One bounded decision: answered with the brain's decision, or defaulted with
 * the failure and the usage of every attempt (a failed attempt contributes
 * the error-carried records, or one synthesized unavailable record when the
 * error carried none; a cancelled attempt whose call is still in flight
 * contributes one unavailable record with reason `cancelled`).
 */
export type DecisionOutcome<D> =
  | { readonly ok: true; readonly decision: D; readonly usage: readonly UsageRecord[]; readonly attempts: number }
  | {
      readonly ok: false;
      readonly defaulted: true;
      readonly failure: DecisionFailure;
      readonly usage: readonly UsageRecord[];
      readonly attempts: number;
    };

/** Where a decision happens, carried on both of its trace events. */
export interface DecisionCorrelation {
  readonly taskId?: string;
  readonly revision?: number;
  readonly attempt?: number;
  readonly executorRunId?: string;
  readonly nodeId?: string;
}

/** Everything one bounded decision needs; nothing comes from the ambient world. */
export interface BoundedDecisionInfo<D> {
  /** The brain method this call decides; it labels both events. */
  readonly kind: DecisionKind;
  /** The id that ties the started and ended events together. */
  readonly decisionId: string;
  /** The factory run the decision belongs to; every trace event names it. */
  readonly runId: string;
  /** The task or executor correlation, present on the events where it applies. */
  readonly correlation?: DecisionCorrelation;
  /** The one brain call of this decision kind; the wrapper owns the signal. */
  readonly call: (signal: AbortSignal) => BrainDecision<D> | Promise<BrainDecision<D>>;
  /** The trace sink in function form; called exactly twice. */
  readonly emit: (event: TraceEvent) => void;
  /** The wall clock as ISO instants; stamps the events and the records. */
  readonly now: () => string;
  /** The injected wait the deadline races through. */
  readonly sleep: Sleep;
  /** The caller's signal; aborting it ends the decision as 'cancelled' at once. */
  readonly signal?: AbortSignal;
  /** The run's resolved decision deadline in milliseconds; BRAIN_DECISION_DEADLINE_MS when absent. */
  readonly deadlineMs?: number;
}

/**
 * Runs one brain decision bounded: it emits decision_started, races the call
 * against the deadline (the run's resolved one, BRAIN_DECISION_DEADLINE_MS by
 * default) and retries it up to
 * BRAIN_DECISION_RETRIES times on any failure, then emits decision_ended with
 * the collected usage. The caller's signal cancels at once with reason
 * 'cancelled' and no further attempts; an attempt whose deadline fired
 * reports 'timeout' (a call answering after the deadline loses its decision
 * but keeps its usage); any other rejection reports 'failed'.
 */
export async function boundedDecision<D>(info: BoundedDecisionInfo<D>): Promise<DecisionOutcome<D>> {
  info.emit({
    type: 'decision_started',
    at: info.now(),
    runId: info.runId,
    decisionId: info.decisionId,
    kind: info.kind,
    ...correlationFields(info.correlation),
  });
  const outcome = await runAttempts(info, [], 1);
  info.emit({
    type: 'decision_ended',
    at: info.now(),
    runId: info.runId,
    decisionId: info.decisionId,
    kind: info.kind,
    ...correlationFields(info.correlation),
    outcome: outcome.ok ? 'answered' : 'defaulted',
    usage: [...outcome.usage],
    detail: outcome.ok ? '' : outcome.failure.detail,
  });
  return outcome;
}

/** The verdict a judge decision defaults to: reject, because the brain was unavailable. */
export function defaultVerdict(): Verdict {
  return { outcome: 'reject', reasons: [BRAIN_UNAVAILABLE], failedCheckIds: [] };
}

/** The recovery choice a recovery decision defaults to: give up, because the brain was unavailable. */
export function defaultRecovery(): RecoveryChoice {
  return { choice: 'give_up', reason: BRAIN_UNAVAILABLE };
}

/** A settled attempt: the brain answered, or the attempt failed in one of three ways. */
type AttemptAnswer<D> = { readonly tag: 'answered'; readonly decision: D; readonly usage: readonly UsageRecord[] };
type AttemptFailure =
  | { readonly tag: 'failed'; readonly reason: 'failed'; readonly detail: string; readonly records: readonly UsageRecord[] }
  | { readonly tag: 'timeout'; readonly reason: 'timeout'; readonly detail: string; readonly records: readonly UsageRecord[] }
  | { readonly tag: 'cancelled'; readonly reason: 'cancelled'; readonly detail: string; readonly records: readonly UsageRecord[] };

/** What settles first in an attempt's race: the call, the deadline, the timer's cancellation or the attempt's abort. */
type AttemptSettled<D> =
  | { readonly tag: 'answered'; readonly answer: BrainDecision<D> }
  | { readonly tag: 'rejected'; readonly error: unknown };
type RaceEvent<D> = AttemptSettled<D> | { readonly tag: 'deadline' } | { readonly tag: 'timer_cancelled' } | { readonly tag: 'aborted' };

/** Runs the attempts of one decision, accumulating every attempt's usage into `usage`. */
async function runAttempts<D>(info: BoundedDecisionInfo<D>, usage: UsageRecord[], attempt: number): Promise<DecisionOutcome<D>> {
  if (info.signal?.aborted === true) {
    return defaultOutcome('cancelled', CANCELLED_DETAIL, usage, attempt - 1);
  }
  const settled = await runAttempt(info);
  if (settled.tag === 'answered') {
    return { ok: true, decision: settled.decision, usage: [...usage, ...settled.usage], attempts: attempt };
  }
  usage.push(...settled.records);
  if (settled.tag === 'cancelled' || attempt > BRAIN_DECISION_RETRIES) {
    return defaultOutcome(settled.reason, settled.detail, usage, attempt);
  }
  return runAttempts(info, usage, attempt + 1);
}

/** Builds the failed outcome every caller applies its kind's default to. */
function defaultOutcome<D>(
  reason: DecisionFailure['reason'],
  detail: string,
  usage: readonly UsageRecord[],
  attempts: number,
): DecisionOutcome<D> {
  return { ok: false, defaulted: true, failure: { reason, detail }, usage, attempts };
}

/**
 * One attempt: the call raced against the deadline and the caller's
 * cancellation. The deadline aborts the attempt's signal; the port contract
 * ends an aborted call, so the timeout collects the call's usage, and a call
 * that breaks the contract is abandoned after BRAIN_ABORT_GRACE_MS with an
 * unavailable record.
 */
async function runAttempt<D>(info: BoundedDecisionInfo<D>): Promise<AttemptAnswer<D> | AttemptFailure> {
  const outer = info.signal;
  const attemptController = new AbortController();
  const timerController = new AbortController();
  let deadlineHit = false;

  const forwardAbort = (): void => {
    attemptController.abort();
  };
  outer?.addEventListener('abort', forwardAbort, { once: true });

  const callPromise = invokeCall(info, attemptController.signal);
  const deadlineMs = info.deadlineMs ?? BRAIN_DECISION_DEADLINE_MS;
  const deadlinePromise: Promise<RaceEvent<D>> = info.sleep(deadlineMs, timerController.signal).then(
    (): RaceEvent<D> => {
      deadlineHit = true;
      attemptController.abort();
      return { tag: 'deadline' };
    },
    (): RaceEvent<D> => ({ tag: 'timer_cancelled' }),
  );
  const abortPromise: Promise<RaceEvent<D>> = new Promise((resolve) => {
    attemptController.signal.addEventListener('abort', () => resolve({ tag: 'aborted' }), { once: true });
  });

  const race: RaceEvent<D> = await Promise.race([callPromise, deadlinePromise, abortPromise]);
  timerController.abort();
  outer?.removeEventListener('abort', forwardAbort);

  if (race.tag === 'answered') {
    return { tag: 'answered', decision: race.answer.decision, usage: race.answer.usage };
  }
  if (outer?.aborted === true) {
    // A rejection that won the race carries what the attempt spent; otherwise the call is still in flight and its usage is unknown.
    const records = race.tag === 'rejected' ? failureRecords(race.error, info.now) : [unavailableRecord(CANCELLED_REASON, info.now)];
    return { tag: 'cancelled', reason: 'cancelled', detail: CANCELLED_DETAIL, records };
  }
  if (!deadlineHit && race.tag === 'rejected') {
    return { tag: 'failed', reason: 'failed', detail: failureDetail(race.error), records: failureRecords(race.error, info.now) };
  }
  const settled = await settleWithinGrace(callPromise, info.sleep);
  if (settled === null) {
    return {
      tag: 'timeout',
      reason: 'timeout',
      detail: timeoutDetail(deadlineMs),
      records: [unavailableRecord(ABANDONED_REASON, info.now)],
    };
  }
  const records = settled.tag === 'answered' ? settled.answer.usage : failureRecords(settled.error, info.now);
  return { tag: 'timeout', reason: 'timeout', detail: timeoutDetail(deadlineMs), records };
}

/**
 * Waits for an aborted call at most BRAIN_ABORT_GRACE_MS, so a call that
 * ignores its signal cannot hang the decision; null when the grace ran out.
 */
async function settleWithinGrace<D>(callPromise: Promise<AttemptSettled<D>>, sleep: Sleep): Promise<AttemptSettled<D> | null> {
  const graceController = new AbortController();
  const grace = sleep(BRAIN_ABORT_GRACE_MS, graceController.signal).then(
    () => null,
    () => null,
  );
  const settled = await Promise.race([callPromise, grace]);
  graceController.abort();
  return settled;
}

/** Calls the brain once; every rejection becomes a tagged failure, never a thrown promise. */
async function invokeCall<D>(info: BoundedDecisionInfo<D>, signal: AbortSignal): Promise<AttemptSettled<D>> {
  try {
    return { tag: 'answered', answer: await info.call(signal) };
  } catch (error) {
    return { tag: 'rejected', error };
  }
}

/** The usage a failed attempt incurred: the BrainError's records, or one synthesized unavailable record. */
function failureRecords(error: unknown, now: () => string): readonly UsageRecord[] {
  if (error instanceof BrainError && error.usage.length > 0) {
    return error.usage;
  }
  return [unavailableRecord(THREW_REASON, now)];
}

/** One brain record whose usage, model and cost are unavailable for the reason. */
function unavailableRecord(reason: string, now: () => string): UsageRecord {
  const usage: Usage = { status: 'unavailable', reason };
  return { at: now(), source: 'brain', modelSource: 'unknown', usage, cost: { status: 'unavailable', reason } };
}

/** The human text of a rejection: the brain's detail, or the error's message. */
function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The detail of an attempt that ran past the deadline. */
function timeoutDetail(deadlineMs: number): string {
  return `brain decision exceeded its deadline of ${deadlineMs} ms`;
}

/** The correlation fields of a trace event, present only where the caller named them. */
function correlationFields(correlation: DecisionCorrelation | undefined): DecisionCorrelation {
  if (correlation === undefined) {
    return {};
  }
  return {
    ...(correlation.taskId === undefined ? {} : { taskId: correlation.taskId }),
    ...(correlation.revision === undefined ? {} : { revision: correlation.revision }),
    ...(correlation.attempt === undefined ? {} : { attempt: correlation.attempt }),
    ...(correlation.executorRunId === undefined ? {} : { executorRunId: correlation.executorRunId }),
    ...(correlation.nodeId === undefined ? {} : { nodeId: correlation.nodeId }),
  };
}
