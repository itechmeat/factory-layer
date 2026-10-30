/**
 * The start of a run (task 3.2): recall similar past runs (bounded, a
 * failure traced and ignored), then ask the brain for the plan and for the
 * acceptance checks concurrently: both decisions are issued before either
 * answer is awaited, so their trace intervals overlap. An invalid first
 * plan goes back to the brain once with every reason (separate from the
 * runtime re-plan allowance); a second invalid plan, or a plan decision that
 * fails every attempt, ends the run as failed before any task starts, and
 * the acceptance decision still in flight is cancelled. The checks are
 * settled against the spec (acceptance-review: the spec's example checks
 * first, contradicting or objected derived checks dropped) while planning
 * goes on. An acceptance decision that fails every attempt leaves the run
 * with only the example checks and marks it `acceptance_unavailable`.
 *
 * The planning signal includes the run's cutoff: a cutoff reached during
 * planning cancels the decisions, and RunFactory ends the run as failed.
 */

import { validatePlan, type AcceptanceCheck, type Plan, type Spec } from '../domain';
import type { Brain, Memory, Sleep } from '../ports';

import { exampleChecks, settleChecks } from './acceptance-review';
import type { Decider } from './decide';
import type { DecisionOutcome } from './decisions';
import { recallPastRuns } from './run-memory';
import type { RunTrace } from './run-trace';

/** The plan and checks a run starts with, or why it cannot start. */
export type PlanningOutcome =
  | {
      readonly ok: true;
      readonly plan: Plan;
      readonly acceptanceChecks: readonly AcceptanceCheck[];
      readonly acceptanceUnavailable: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/** Everything the start needs; the run's state does not exist before the plan does. */
export interface PlanningInfo {
  readonly spec: Spec;
  readonly brain: Brain;
  readonly memory: Memory;
  readonly sleep: Sleep;
  readonly trace: RunTrace;
  readonly decider: Decider;
  readonly signal: AbortSignal;
}

/** Plans the run; see the module header. */
export async function planRun(info: PlanningInfo): Promise<PlanningOutcome> {
  const { spec, brain, decider, trace } = info;
  const recalled = await recallPastRuns(info);
  const acceptanceController = new AbortController();
  const acceptance = deriveChecks(info, acceptanceController.signal);
  const planned = await planWithCorrection(
    info,
    decider.decide('plan', {}, (signal) => brain.plan(spec, recalled, signal)),
  );
  if (!planned.ok) {
    acceptanceController.abort();
    await acceptance;
    return planned;
  }
  const checks = await acceptance;
  if (checks.ok) {
    trace.emit({ type: 'acceptance_produced', checkIds: checks.checks.map((check) => check.id) });
    return { ok: true, plan: planned.plan, acceptanceChecks: checks.checks, acceptanceUnavailable: false };
  }
  trace.emit({ type: 'acceptance_unavailable', reason: trace.redact(checks.detail) });
  return { ok: true, plan: planned.plan, acceptanceChecks: checks.checks, acceptanceUnavailable: true };
}

/** The settled checks, or the example checks alone with the reason the derivation failed. */
async function deriveChecks(
  info: PlanningInfo,
  signal: AbortSignal,
): Promise<{ readonly ok: boolean; readonly checks: readonly AcceptanceCheck[]; readonly detail: string }> {
  const { spec, brain, decider } = info;
  const examples = exampleChecks(spec);
  const derived = await decider.decide('acceptance', {}, (decisionSignal) => brain.deriveAcceptance(spec, decisionSignal), signal);
  if (!derived.ok) return { ok: false, checks: examples, detail: derived.failure.detail };
  return { ok: true, checks: await settleChecks(info, examples, derived.decision, signal), detail: '' };
}

/** Awaits the first plan and corrects it once when invalid. */
async function planWithCorrection(
  info: PlanningInfo,
  first: Promise<DecisionOutcome<Plan>>,
): Promise<{ readonly ok: true; readonly plan: Plan } | { readonly ok: false; readonly reason: string }> {
  const { spec, brain, decider, trace } = info;
  const initial = await first;
  if (!initial.ok) {
    return { ok: false, reason: `plan_unavailable: ${initial.failure.detail}` };
  }
  const reasons = validatePlan(initial.decision);
  if (reasons.length === 0) {
    trace.emit({ type: 'plan_produced', source: 'initial', taskCount: initial.decision.tasks.length });
    return { ok: true, plan: initial.decision };
  }
  trace.emit({ type: 'plan_rejected', source: 'initial', reasons: [...reasons] });
  const corrected = await decider.decide('correct_plan', {}, (signal) => brain.correctPlan(spec, initial.decision, reasons, signal));
  if (!corrected.ok) {
    return { ok: false, reason: `plan_unavailable: ${corrected.failure.detail}` };
  }
  const left = validatePlan(corrected.decision);
  if (left.length > 0) {
    trace.emit({ type: 'plan_rejected', source: 'correction', reasons: [...left] });
    return { ok: false, reason: 'plan_invalid: the corrected plan is still invalid' };
  }
  trace.emit({ type: 'plan_produced', source: 'correction', taskCount: corrected.decision.tasks.length });
  return { ok: true, plan: corrected.decision };
}
