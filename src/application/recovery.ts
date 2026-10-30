/**
 * Recovery of a failed attempt (task 3.6). The task enters `recovering`. With
 * its attempts spent (the run's resolved budget) it goes to the runtime
 * re-plan while the run's allowance lasts, else it fails with
 * `budget_spent` without a brain decision, its live run stopped and
 * confirmed first. Otherwise the brain chooses (defaulting to give up) and
 * the choice is applied: on a live run, `retry` and `rebind` become a
 * command on the run (live-command.ts), `repair` and `give_up` first stop
 * the run and confirm it (the stop intent carries the repair run to start
 * or the failure to record), and `replan` hands the run to the re-plan,
 * which stops it (with the run's re-plan budget spent, `replan` becomes a
 * repair run with the failure as the hint, traced as downgraded); on a finished run, `retry` and `rebind` start a follow-up
 * run with the hint (a rebind traced as downgraded), `repair` starts one
 * with the failing checks, `replan` asks for the re-plan and `give_up`
 * fails the task. The follow-up of an integrate run is another integrate
 * run on the paths still unresolved. A follow-up run never starts in a tree
 * a run may still hold. An unconfirmed stop fails the task with
 * `stop_unconfirmed` and skips the continuation. From the cutoff on, or once
 * a re-plan took the task over, recovery ends without touching the task (a
 * late decision is discarded as stale). Dependants of a failed task are
 * failed by the scheduler.
 */

import { budgetReport, type ExecutorRunRef, type RecoveryChoice, type TaskFailure } from '../domain';

import { defaultRecovery } from './decisions';
import { requestRecord, type DispatchRequest } from './dispatch';
import { postCommand, type RecoveryNext } from './live-command';
import { discardedAsStale, halted, recordHistory, taskSignal, type RunContext } from './run-context';
import { stopRun, treeBlocked } from './stops';
import { followUpRequest } from './task-inputs';

/** A failed attempt to recover: the failure, the task's last run and whether that run is still live. */
export interface RecoveryCase {
  readonly taskId: string;
  readonly failure: TaskFailure;
  readonly ref: ExecutorRunRef | null;
  readonly live: boolean;
}

const ENDED: RecoveryNext = { kind: 'ended' };

/** Recovers the case; see the module header for every path. */
export async function recover(ctx: RunContext, rc: RecoveryCase): Promise<RecoveryNext> {
  const { owner, limits } = ctx;
  if (halted(ctx, rc.taskId)) {
    return ENDED;
  }
  if (owner.task(rc.taskId).state !== 'recovering') {
    await owner.transition(rc.taskId, 'recovering', rc.failure.reason);
  }
  const budget = budgetReport({
    attemptsUsed: owner.task(rc.taskId).attemptsUsed,
    attemptBudget: limits.taskAttemptBudget,
    replansUsed: owner.state.replansUsed,
    replanBudget: limits.runReplanBudget,
  });
  if (!budget.recoveryLeft) {
    return budgetSpent(ctx, rc, budget.replanAvailable);
  }
  const decided = await ctx.decider.decide(
    'recovery',
    owner.correlation(rc.taskId),
    (signal) => ctx.ports.brain.chooseRecovery(owner.planTask(rc.taskId), rc.failure, ctx.history.get(rc.taskId) ?? [], signal),
    taskSignal(ctx, rc.taskId),
  );
  if (discardedAsStale(ctx, rc.taskId, 'the recovery choice') || halted(ctx, rc.taskId)) {
    return ENDED;
  }
  const choice = decided.ok ? decided.decision : defaultRecovery();
  ctx.trace.emit({ type: 'recovery_chosen', ...owner.correlation(rc.taskId), choice: choice.choice, detail: describe(choice) });
  recordHistory(ctx, rc.taskId, 'recovered', describe(choice));
  return apply(ctx, rc, choice, budget.replanAvailable);
}

/** No attempt left: the re-plan while available, else the task fails without a decision (its live run stopped first). */
async function budgetSpent(ctx: RunContext, rc: RecoveryCase, replanAvailable: boolean): Promise<RecoveryNext> {
  if (replanAvailable) {
    return askReplan(ctx, rc);
  }
  return giveUp(ctx, rc, 'budget_spent', 'budget_spent');
}

/** Applies the brain's choice to the live or finished run; a `replan` past the run's re-plan budget becomes a repair run. */
async function apply(ctx: RunContext, rc: RecoveryCase, choice: RecoveryChoice, replanAvailable: boolean): Promise<RecoveryNext> {
  const live = rc.live && rc.ref !== null;
  switch (choice.choice) {
    case 'give_up':
      return giveUp(ctx, rc, 'give_up', 'given_up');
    case 'replan':
      if (replanAvailable) {
        return askReplan(ctx, rc);
      }
      ctx.trace.emit({
        type: 'recovery_chosen',
        ...ctx.owner.correlation(rc.taskId),
        choice: 'repair',
        detail: 'replan downgraded to a repair run because the run has no re-plan left',
      });
      return repair(ctx, rc, `Re-planning is not available. Resolve the last failure within the task: ${rc.failure.detail}`, []);
    case 'repair':
      return repair(ctx, rc, null, choice.failingCheckIds);
    case 'retry':
    case 'rebind':
      if (live && rc.ref !== null && rc.failure.nodeId !== null) {
        return postCommand(ctx, rc.ref, choice, rc.failure.nodeId);
      }
      if (choice.choice === 'rebind' && !live) {
        ctx.trace.emit({
          type: 'recovery_chosen',
          ...ctx.owner.correlation(rc.taskId),
          choice: 'repair',
          detail: 'rebind downgraded to a repair run because the run has finished',
        });
      }
      return repair(ctx, rc, choice.hint, []);
  }
}

/** Fails the task, stopping its live run first (an unconfirmed stop fails it with `stop_unconfirmed`). */
async function giveUp(ctx: RunContext, rc: RecoveryCase, purpose: 'give_up' | 'budget_spent', reason: string): Promise<RecoveryNext> {
  if (rc.live && rc.ref !== null) {
    const confirmed = await stopRun(ctx, rc.ref, purpose, { do: 'mark_failed', taskId: rc.taskId, reason });
    if (!confirmed) {
      return failed(ctx, rc.taskId, 'stop_unconfirmed');
    }
  }
  return failed(ctx, rc.taskId, reason);
}

/**
 * A follow-up run in the task's tree (consuming an attempt when dispatched):
 * a live run is stopped first with the run to start in its stop intent; a
 * tree a run may still hold blocks it.
 */
async function repair(ctx: RunContext, rc: RecoveryCase, hint: string | null, failingCheckIds: readonly string[]): Promise<RecoveryNext> {
  const checks = failingCheckIds.length > 0 ? failingCheckIds : rc.failure.failingCheckIds;
  const request: DispatchRequest = await followUpRequest(ctx, rc.ref, rc.taskId, { hint, failingCheckIds: checks });
  if (rc.live && rc.ref !== null) {
    const task = ctx.owner.task(rc.taskId);
    const confirmed = await stopRun(ctx, rc.ref, 'recovery', {
      do: 'start_repair',
      taskId: rc.taskId,
      revision: task.revision,
      attempt: Math.max(task.attemptsUsed, 1),
      request: requestRecord(request),
      consumesAttempt: true,
    });
    if (!confirmed) {
      return failed(ctx, rc.taskId, 'stop_unconfirmed');
    }
  } else if (rc.ref !== null && treeBlocked(ctx, rc.ref.tree)) {
    return failed(ctx, rc.taskId, 'stop_unconfirmed');
  }
  return { kind: 'dispatch', request, consumeAttempt: true };
}

/** Hands the task to the runtime re-plan, which stops its live run with the others. */
async function askReplan(ctx: RunContext, rc: RecoveryCase): Promise<RecoveryNext> {
  await ctx.replan.requestReplan(ctx, { taskId: rc.taskId, failure: rc.failure, lastRun: rc.ref });
  return ENDED;
}

async function failed(ctx: RunContext, taskId: string, reason: string): Promise<RecoveryNext> {
  await ctx.owner.fail(taskId, reason);
  return ENDED;
}

/** A short text of the choice for the trace and the history. */
function describe(choice: RecoveryChoice): string {
  switch (choice.choice) {
    case 'retry':
      return `retry: ${choice.hint}`;
    case 'rebind':
      return `rebind to ${choice.profile}: ${choice.hint}`;
    case 'repair':
      return `repair: ${choice.failingCheckIds.join(', ')}`;
    case 'replan':
      return 'replan';
    case 'give_up':
      return `give up: ${choice.reason}`;
  }
}
