/**
 * One task's attempt loop, run as its own promise so tasks progress (and
 * judge) concurrently: dispatch a run, supervise it, judge a finished task
 * run (or, after an integrate run, check the conflict is resolved), wait for
 * the task's turn to integrate, and on every failure go through recovery,
 * which says where to go next. A runner starts at any step: the scheduler
 * starts a ready task at its dispatch, and a task found mid-way (on resume,
 * or after a failed re-plan) at the step its persisted state names
 * (resume.ts). The loop ends when the task is integrated, failed or handed
 * to the runtime re-plan, at the cutoff, and when a re-plan takes the task
 * over (a result that arrives then is discarded as stale). Every task state
 * change goes through the run owner. An unexpected error stops the task's
 * live runs (bounded, without the state) and fails the task
 * (`internal_error`); a storage failure or the run's abort ends the loop and
 * reaches the scheduler.
 */

import type { ExecutorRunRef } from '../domain';

import { dispatchRun, moveToRevision, type DispatchRequest, type StartIntent } from './dispatch';
import { handOverConflict, integrateTask, resumeIntegration, type IntegrateIntent } from './integration';
import { judgeTask } from './judge';
import { resumeCommand, type CommandIntent, type RecoveryNext } from './live-command';
import { recover, type RecoveryCase } from './recovery';
import { cutoffPassed, discardedAsStale, halted, taskFailure, taskSignal, type RunContext } from './run-context';
import { StorageFailure } from './run-owner';
import type { Lease } from './run-slots';
import { stopQuietly } from './stops';
import { collectReport, supervise } from './supervise';

/** Where a task's loop is, or where a runner starts. */
export type Step =
  | {
      readonly kind: 'dispatch';
      readonly request: DispatchRequest;
      readonly lease: Promise<Lease> | null;
      readonly consumeAttempt: boolean;
      readonly revision?: number;
      readonly resumeIntent?: StartIntent;
    }
  | { readonly kind: 'supervise'; readonly executorRunId: string }
  | { readonly kind: 'judge'; readonly executorRunId: string }
  | { readonly kind: 'recover'; readonly rc: RecoveryCase }
  | { readonly kind: 'command'; readonly executorRunId: string; readonly intent: CommandIntent }
  | { readonly kind: 'integrate' }
  | { readonly kind: 'integration_check'; readonly intent: IntegrateIntent }
  | { readonly kind: 'ended' };

/** Runs the task from the step to its end; see the module header. */
export async function runTask(ctx: RunContext, taskId: string, first: Step): Promise<void> {
  let step: Step = first;
  let lastRun: ExecutorRunRef | null = null;
  try {
    while (step.kind !== 'ended') {
      ctx.signal.throwIfAborted();
      if (halted(ctx, taskId)) {
        await releaseUnused(ctx, step);
        return;
      }
      if (step.kind === 'supervise' || step.kind === 'judge' || step.kind === 'command') {
        lastRun = mustRun(ctx, step.executorRunId);
      }
      step = await advance(ctx, taskId, step, lastRun);
    }
  } catch (error) {
    if (error instanceof StorageFailure || ctx.signal.aborted) {
      throw error;
    }
    if (halted(ctx, taskId)) {
      return;
    }
    await failOnError(ctx, taskId, error);
  }
}

/** One step of the loop. */
async function advance(
  ctx: RunContext,
  taskId: string,
  step: Exclude<Step, { kind: 'ended' }>,
  lastRun: ExecutorRunRef | null,
): Promise<Step> {
  switch (step.kind) {
    case 'dispatch':
      return dispatchStep(ctx, step);
    case 'supervise':
      return superviseStep(ctx, taskId, mustRun(ctx, step.executorRunId));
    case 'judge':
      return judgeStep(ctx, taskId, mustRun(ctx, step.executorRunId), null);
    case 'recover':
      return next(await recover(ctx, step.rc));
    case 'command':
      return next(await resumeCommand(ctx, mustRun(ctx, step.executorRunId), step.intent));
    case 'integration_check':
      return (await resumeIntegration(ctx, step.intent)) === 'integrated' ? { kind: 'ended' } : { kind: 'integrate' };
    case 'integrate':
      return integrateStep(ctx, taskId, lastRun);
  }
}

/** The lease a step was started with goes back when the step does not run. */
async function releaseUnused(ctx: RunContext, step: Step): Promise<void> {
  if (step.kind === 'dispatch' && step.lease !== null) {
    await step.lease.then(
      (lease) => ctx.slots.release(lease),
      () => undefined,
    );
  }
}

async function dispatchStep(ctx: RunContext, step: Extract<Step, { kind: 'dispatch' }>): Promise<Step> {
  const taskId = step.request.taskId;
  const lease = await (step.lease ?? ctx.slots.acquire(taskSignal(ctx, taskId)));
  if (halted(ctx, taskId)) {
    ctx.slots.release(lease);
    return { kind: 'ended' };
  }
  if (step.revision !== undefined) {
    await moveToRevision(ctx, taskId, step.revision);
  }
  const dispatched = await dispatchRun(ctx, step.request, lease, {
    consumeAttempt: step.consumeAttempt,
    ...(step.resumeIntent === undefined ? {} : { resumeIntent: step.resumeIntent }),
  });
  return dispatched.kind === 'started' ? { kind: 'supervise', executorRunId: dispatched.executorRunId } : { kind: 'ended' };
}

async function superviseStep(ctx: RunContext, taskId: string, ref: ExecutorRunRef): Promise<Step> {
  const outcome = await supervise(ctx, ref.executorRunId);
  if (outcome.kind === 'ended' || discardedAsStale(ctx, taskId, `the ${outcome.kind} run`)) {
    return { kind: 'ended' };
  }
  if (outcome.kind === 'failed') {
    return { kind: 'recover', rc: { taskId, failure: outcome.failure, ref, live: outcome.live } };
  }
  return judgeStep(ctx, taskId, ref, outcome.report);
}

/** A run that finished successfully: an integrate run is checked for unresolved paths, a task or repair run is judged. */
async function judgeStep(
  ctx: RunContext,
  taskId: string,
  ref: ExecutorRunRef,
  known: Parameters<typeof judgeTask>[3] | null,
): Promise<Step> {
  if (ref.role === 'integrate') {
    return afterIntegrateRun(ctx, taskId, ref);
  }
  const report = known ?? (await collectReport(ctx, ref, 'succeeded'));
  await commit(ctx, taskId, ref);
  const judged = await judgeTask(ctx, ctx.owner.planTask(taskId), ref.tree, report);
  if (judged.accepted === null) {
    return { kind: 'ended' };
  }
  if (judged.accepted) {
    return { kind: 'integrate' };
  }
  return { kind: 'recover', rc: { taskId, failure: judged.failure, ref, live: false } };
}

/** An integrate run finished: with no unresolved path left, commit and integrate again; else recover with another integrate run. */
async function afterIntegrateRun(ctx: RunContext, taskId: string, ref: ExecutorRunRef): Promise<Step> {
  const unresolved = await ctx.ports.workspace.unresolvedPaths(ref.tree);
  if (unresolved.length > 0) {
    const failure = taskFailure(ctx, taskId, { reason: 'conflict_unresolved', detail: `still unresolved: ${unresolved.join(', ')}` });
    return { kind: 'recover', rc: { taskId, failure, ref, live: false } };
  }
  await commit(ctx, taskId, ref);
  if (ctx.owner.task(taskId).state !== 'judging') {
    await ctx.owner.transition(taskId, 'judging', 'the integrate run finished');
  }
  await ctx.owner.transition(taskId, 'accepted', 'the conflict is resolved, integration is tried again');
  return { kind: 'integrate' };
}

async function integrateStep(ctx: RunContext, taskId: string, lastRun: ExecutorRunRef | null): Promise<Step> {
  const outcome = await ctx.integrations.run(taskId, taskSignal(ctx, taskId), async () =>
    cutoffPassed(ctx) ? null : integrateTask(ctx, taskId),
  );
  if (outcome === null || outcome.kind === 'integrated' || outcome.kind === 'halted') {
    return { kind: 'ended' };
  }
  if (outcome.kind === 'conflict') {
    return next(await handOverConflict(ctx, taskId, outcome.paths, lastRun?.tree ?? null));
  }
  return { kind: 'recover', rc: { taskId, failure: outcome.failure, ref: lastRun, live: false } };
}

/** Commits the run's work on the task branch. */
async function commit(ctx: RunContext, taskId: string, ref: ExecutorRunRef): Promise<void> {
  const task = ctx.owner.task(taskId);
  await ctx.ports.workspace.commitTask(ref.tree, `${taskId} r${task.revision} attempt ${task.attemptsUsed} (${ref.role} run)`);
}

/** An unexpected error: the task's live runs are stopped (bounded, without the state) and the task fails. */
async function failOnError(ctx: RunContext, taskId: string, error: unknown): Promise<void> {
  const detail = ctx.trace.redact(error instanceof Error ? error.message : String(error));
  const live = Object.values(ctx.owner.state.runs).filter((run) => run.taskId === taskId && run.state === 'live');
  for (const run of live) {
    const confirmed = await stopQuietly(ctx, run.executorRunId, 'give_up', { taskId, executorRunId: run.executorRunId });
    await ctx.owner.update((state) => {
      const saved = state.runs[run.executorRunId];
      if (saved !== undefined) {
        state.runs[run.executorRunId] = { ...saved, state: confirmed ? 'stopped' : 'unconfirmed' };
      }
    });
  }
  await ctx.owner.fail(taskId, `internal_error: ${detail}`);
}

function next(recovery: RecoveryNext): Step {
  if (recovery.kind === 'dispatch') {
    return { kind: 'dispatch', request: recovery.request, lease: null, consumeAttempt: recovery.consumeAttempt };
  }
  return recovery;
}

function mustRun(ctx: RunContext, executorRunId: string): ExecutorRunRef {
  const run = ctx.owner.state.runs[executorRunId];
  if (run === undefined) {
    throw new Error(`unknown executor run ${executorRunId}`);
  }
  return run;
}
