/**
 * Transactional integration (task 3.8). An accepted task's branch is merged
 * onto the current `main` in a separate integration tree; the package steps
 * and every acceptance check run there, and `main` advances (a
 * compare-and-swap, bracketed by an integrate intent) only when the package
 * steps pass and no check that passed on `main` before fails now. A
 * regression keeps `main` where it was and goes back to the task as a
 * rejection. A conflict is handed over to the task's own tree: `main` is
 * merged into the task branch there and an `integrate` run resolves it; the
 * hand-over counts as a recovery attempt. Integrations run one at a time in
 * execution order (integration-queue.ts). The integrate intent holds the
 * acceptance results `main` gets as its baseline, so a resume that finds
 * `main` already at the integration result marks the task integrated
 * without merging again (task 3.12).
 */

import { budgetReport, type CheckResult, type RunIntent, type TaskFailure } from '../domain';

import { runChecksIn } from './judge';
import type { RecoveryNext } from './live-command';
import { taskFailure, type RunContext } from './run-context';
import { treeBlocked } from './stops';
import { integrateRequest } from './task-inputs';

/** How one integration of a task ended. */
export type IntegrationOutcome =
  | { readonly kind: 'integrated' }
  | { readonly kind: 'conflict'; readonly paths: readonly string[] }
  | { readonly kind: 'rejected'; readonly failure: TaskFailure };

/** How often a moved `main` is retried before the integration counts as failed. */
const MAIN_MOVED_RETRIES = 1;

/** Integrates an accepted task; see the module header. */
export async function integrateTask(ctx: RunContext, taskId: string): Promise<IntegrationOutcome> {
  const { owner, ports } = ctx;
  const specName = owner.state.spec.name;
  if (owner.task(taskId).state !== 'integrating') {
    await owner.transition(taskId, 'integrating', 'integration of the accepted task');
  }
  for (let tries = 0; ; tries += 1) {
    const revision = owner.task(taskId).revision;
    const prepared = await ports.workspace.prepareIntegration(specName, taskId, revision);
    if (!prepared.ok) {
      ctx.trace.emit({ type: 'merge_conflict', ...owner.correlation(taskId), paths: [...prepared.paths] });
      return { kind: 'conflict', paths: prepared.paths };
    }
    ctx.trace.emit({ type: 'merge_produced', ...owner.correlation(taskId), commit: prepared.commit, baseCommit: prepared.base });
    const checks = await runChecksIn(ctx, prepared.tree, 'integration', taskId);
    const regressed = regressions(owner.state.lastMainChecks, checks.acceptance);
    const failedPackage = checks.results.filter((result) => result.checkId.startsWith('package-') && result.status !== 'passed');
    if (!checks.packageOk || regressed.length > 0) {
      const failing = [...failedPackage.map((result) => result.checkId), ...regressed];
      return {
        kind: 'rejected',
        failure: taskFailure(ctx, taskId, {
          reason: 'regression',
          detail: `integration kept off main: ${failing.join(', ')} failed`,
          failingCheckIds: failing,
        }),
      };
    }
    const intent: IntegrateIntent = {
      kind: 'integrate',
      taskId,
      revision,
      commit: prepared.commit,
      base: prepared.base,
      checks: [...checks.acceptance],
    };
    await owner.addIntent(intent);
    const advanced = await ports.workspace.advanceMain(specName, prepared.commit, prepared.base);
    if (!advanced.ok) {
      await owner.removeIntents((candidate) => candidate.kind === 'integrate' && candidate.taskId === taskId);
      if (tries < MAIN_MOVED_RETRIES) {
        continue;
      }
      return { kind: 'rejected', failure: taskFailure(ctx, taskId, { reason: 'main_moved', detail: 'main moved during the integration' }) };
    }
    await markIntegrated(ctx, intent);
    return { kind: 'integrated' };
  }
}

/** An integrate intent, as saved. */
export type IntegrateIntent = Extract<RunIntent, { kind: 'integrate' }>;

/** `main` is at the integration result: in one save the intent goes, the checks become main's baseline, the task is integrated. */
async function markIntegrated(ctx: RunContext, intent: IntegrateIntent): Promise<void> {
  await ctx.owner.transition(intent.taskId, 'integrated', 'main advanced to the integration result', {
    change: (state) => {
      state.intents = state.intents.filter((candidate) => !(candidate.kind === 'integrate' && candidate.taskId === intent.taskId));
      state.lastMainChecks = [...intent.checks];
    },
    trace: () => {
      ctx.trace.emit({ type: 'main_advanced', ...ctx.owner.correlation(intent.taskId), commit: intent.commit, baseCommit: intent.base });
    },
  });
}

/**
 * An integrate intent found on resume: when `main` already points at the
 * integration result the task is integrated without merging again;
 * otherwise the intent goes and the integration is tried again.
 */
export async function resumeIntegration(ctx: RunContext, intent: IntegrateIntent): Promise<'integrated' | 'again'> {
  const main = await ctx.ports.workspace.mainCommit(ctx.owner.state.spec.name);
  if (main === intent.commit) {
    if (ctx.owner.task(intent.taskId).state !== 'integrating') {
      await ctx.owner.transition(intent.taskId, 'integrating', 'integration found in progress on resume');
    }
    await markIntegrated(ctx, intent);
    return 'integrated';
  }
  await ctx.owner.removeIntents((candidate) => candidate.kind === 'integrate' && candidate.taskId === intent.taskId);
  return 'again';
}

/** The checks that passed on `main` before and do not pass in the integration tree now. */
function regressions(before: readonly CheckResult[] | null, now: readonly CheckResult[]): string[] {
  if (before === null) {
    return [];
  }
  const passedBefore = new Set(before.filter((result) => result.status === 'passed').map((result) => result.checkId));
  return now.filter((result) => passedBefore.has(result.checkId) && result.status !== 'passed').map((result) => result.checkId);
}

/**
 * A conflict: with an attempt left, `main` is merged into the task branch in
 * the task's tree and an `integrate` run is returned for dispatch (the
 * hand-over consumes the attempt). With none left the task goes to the
 * runtime re-plan while the run's allowance lasts, else it fails with
 * `budget_spent`.
 */
export async function handOverConflict(
  ctx: RunContext,
  taskId: string,
  paths: readonly string[],
  tree: string | null,
): Promise<RecoveryNext> {
  const { owner, limits } = ctx;
  await owner.transition(taskId, 'recovering', `merge conflict in ${paths.join(', ')}`);
  const budget = budgetReport({
    attemptsUsed: owner.task(taskId).attemptsUsed,
    attemptBudget: limits.taskAttemptBudget,
    replansUsed: owner.state.replansUsed,
    replanBudget: limits.runReplanBudget,
  });
  if (!budget.recoveryLeft) {
    if (budget.replanAvailable) {
      await ctx.replan.requestReplan(ctx, {
        taskId,
        failure: taskFailure(ctx, taskId, { reason: 'conflict', detail: `merge conflict in ${paths.join(', ')}` }),
        lastRun: null,
      });
      return { kind: 'ended' };
    }
    await owner.fail(taskId, 'budget_spent');
    return { kind: 'ended' };
  }
  if (tree !== null && treeBlocked(ctx, tree)) {
    await owner.fail(taskId, 'stop_unconfirmed');
    return { kind: 'ended' };
  }
  const handed = await ctx.ports.workspace.handOverConflict(owner.state.spec.name, taskId, owner.task(taskId).revision);
  const conflictPaths = handed.unresolvedPaths.length > 0 ? handed.unresolvedPaths : paths;
  return { kind: 'dispatch', request: integrateRequest(ctx, taskId, conflictPaths), consumeAttempt: true };
}
