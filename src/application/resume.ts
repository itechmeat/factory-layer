/**
 * Resuming a run from its persisted state (task 3.12). Before anything is
 * judged or dispatched: every executor run that was live or still held gets
 * its lease back, every stop intent is finished (the stop is confirmed and
 * its continuation recorded, or the unconfirmed-stop rules apply), every
 * live run is re-attached with its supervisor token (a run that cannot be
 * attached is stopped as an orphan and recovered), and a re-plan in
 * progress continues from its phase. Then each task found mid-way starts at
 * the step its state names (entryFor): a confirmed stop's continuation, a
 * command intent's remaining steps, an integration intent's check of
 * `main`, a start intent's settlement (lookup by playbook, tree and time,
 * orphan stop, replacement), a live run supervised from its cursor, a run
 * that finished successfully judged, a failed, aborted or stopped run
 * recovered. A delivery intent is simply repeated, since delivery starts
 * over from a clean copy. The same derivation starts the tasks a failed
 * re-plan hands back.
 */

import { EXECUTOR_CALL_DEADLINE_MS, type ExecutorRunRef, type TaskState } from '../domain';

import { boundedDetail, withDeadline } from './deadline';
import { requestOf } from './dispatch';
import { continueReplan } from './replan';
import { latestRun, taskFailure, type RunContext } from './run-context';
import { finishStop, isHeld, stopRun, type StopIntent } from './stops';
import { taskRequest } from './task-inputs';
import type { Step } from './task-runner';

/** The task states the scheduler itself owns or that are final: no entry step. */
const NO_ENTRY: readonly TaskState[] = ['pending', 'ready', 'integrated', 'failed'];

/** Reconciles the persisted state before the scheduler runs; see the module header. */
export async function resumeRun(ctx: RunContext): Promise<void> {
  await reacquireLeases(ctx);
  for (const intent of ctx.owner.state.intents.filter((candidate): candidate is StopIntent => candidate.kind === 'stop')) {
    await finishStopIntent(ctx, intent);
  }
  await reattachLiveRuns(ctx);
  if (ctx.owner.state.intents.some((intent) => intent.kind === 'replan')) {
    await continueReplan(ctx);
  }
}

/** Every run that may still hold executor capacity holds a lease again. */
async function reacquireLeases(ctx: RunContext): Promise<void> {
  for (const run of Object.values(ctx.owner.state.runs)) {
    if (run.supervisorToken !== undefined) {
      ctx.trace.addSecret(run.supervisorToken);
    }
    if (run.state === 'live' || isHeld(run)) {
      ctx.leases.set(run.executorRunId, await ctx.slots.acquire(ctx.signal));
    }
  }
}

/** Finishes one stop intent: an unconfirmed stop is asked again; a failed-task continuation is recorded at once. */
async function finishStopIntent(ctx: RunContext, intent: StopIntent): Promise<void> {
  if (!intent.confirmed && !(await finishStop(ctx, intent))) {
    if (intent.taskId !== null) {
      await ctx.owner.fail(intent.taskId, 'stop_unconfirmed');
    }
    return;
  }
  if (intent.continuation.do === 'mark_failed') {
    await ctx.owner.fail(intent.continuation.taskId, intent.continuation.reason);
  }
}

/** Re-attaches every live run with its token; a run that cannot be attached is stopped as an orphan and recovered. */
async function reattachLiveRuns(ctx: RunContext): Promise<void> {
  for (const run of Object.values(ctx.owner.state.runs).filter((candidate) => candidate.state === 'live')) {
    const detail = await attach(ctx, run);
    if (detail === null) {
      continue;
    }
    const task = ctx.owner.task(run.taskId);
    const confirmed = await stopRun(ctx, run, 'orphan', {
      do: 'resume_recovery',
      taskId: run.taskId,
      revision: run.revision,
      attempt: Math.max(task.attemptsUsed, 1),
      reason: 'attach_failed',
      detail: ctx.trace.redact(detail),
    });
    if (!confirmed) {
      await ctx.owner.fail(run.taskId, 'stop_unconfirmed');
    }
  }
}

/** Attaches the run with its token; null when attached, else why not. */
async function attach(ctx: RunContext, run: ExecutorRunRef): Promise<string | null> {
  const token = run.supervisorToken;
  if (token === undefined) {
    return 'the run was never supervised (no token)';
  }
  const attached = await withDeadline({
    call: () => ctx.ports.executor.attach(run.executorRunId, token),
    deadlineMs: EXECUTOR_CALL_DEADLINE_MS,
    sleep: ctx.ports.sleep,
    signal: ctx.signal,
  });
  if (attached.status !== 'done') {
    return boundedDetail(attached);
  }
  return attached.value.attached ? null : attached.value.detail;
}

/** The step a task found mid-way starts at, from its persisted state; null when it has none (see the module header). */
export async function entryFor(ctx: RunContext, taskId: string): Promise<Step | null> {
  const { owner } = ctx;
  const task = owner.task(taskId);
  if (NO_ENTRY.includes(task.state)) {
    return null;
  }
  const intents = owner.state.intents.filter((intent) => 'taskId' in intent && intent.taskId === taskId);
  const stop = intents.find((intent): intent is StopIntent => intent.kind === 'stop' && intent.confirmed);
  if (stop !== undefined) {
    return continuationStep(ctx, stop);
  }
  for (const intent of intents) {
    if (intent.kind === 'command') {
      return { kind: 'command', executorRunId: intent.executorRunId, intent };
    }
    if (intent.kind === 'integrate') {
      return { kind: 'integration_check', intent };
    }
    if (intent.kind === 'start') {
      const resumeIntent = intent.revision === task.revision ? { resumeIntent: intent } : {};
      return { kind: 'dispatch', request: requestOf(intent.request), lease: null, consumeAttempt: false, ...resumeIntent };
    }
  }
  if (task.state === 'accepted' || task.state === 'integrating') {
    return { kind: 'integrate' };
  }
  return runEntry(ctx, taskId, task.state, latestRun(ctx, taskId));
}

/** The step of a task by its latest run, when no intent names one. */
async function runEntry(ctx: RunContext, taskId: string, state: TaskState, last: ExecutorRunRef | undefined): Promise<Step | null> {
  if (last === undefined) {
    return { kind: 'dispatch', request: taskRequest(ctx, taskId), lease: null, consumeAttempt: false };
  }
  const recoverFrom = (reason: string, detail: string, live: boolean): Step => ({
    kind: 'recover',
    rc: { taskId, failure: taskFailure(ctx, taskId, { reason, detail }), ref: last, live },
  });
  switch (last.state) {
    case 'live':
      return state === 'recovering'
        ? recoverFrom('resumed', 'the recovery of the live run was interrupted by a restart', true)
        : { kind: 'supervise', executorRunId: last.executorRunId };
    case 'succeeded':
      return state === 'recovering'
        ? recoverFrom('resumed', 'the recovery after the run was interrupted by a restart', false)
        : { kind: 'judge', executorRunId: last.executorRunId };
    case 'failed':
    case 'aborted':
      return recoverFrom(`run_${last.state}`, `the run ended ${last.state}`, false);
    case 'stopped':
      return recoverFrom('run_stopped', 'the run was stopped', false);
    case 'unconfirmed':
      await ctx.owner.fail(taskId, 'stop_unconfirmed');
      return null;
  }
}

/** The step of a confirmed stop's continuation. */
async function continuationStep(ctx: RunContext, stop: StopIntent): Promise<Step | null> {
  const next = stop.continuation;
  switch (next.do) {
    case 'resume_recovery':
      return {
        kind: 'recover',
        rc: {
          taskId: next.taskId,
          failure: taskFailure(ctx, next.taskId, { reason: next.reason, detail: next.detail }),
          ref: ctx.owner.state.runs[stop.executorRunId] ?? null,
          live: false,
        },
      };
    case 'start_repair':
      return { kind: 'dispatch', request: requestOf(next.request), lease: null, consumeAttempt: next.consumesAttempt };
    case 'dispatch_replacement':
      return { kind: 'dispatch', request: requestOf(next.request), lease: null, consumeAttempt: false, revision: next.revision };
    case 'mark_failed':
      await ctx.owner.fail(next.taskId, next.reason);
      return null;
    case 'continue_cutoff':
    case 'continue_replan':
    case 'none':
      await ctx.owner.removeIntents(
        (intent) => intent.kind === 'stop' && intent.executorRunId === stop.executorRunId && intent.requestedAt === stop.requestedAt,
      );
      return null;
  }
}
