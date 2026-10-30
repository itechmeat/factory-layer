/**
 * Bounded executor stops and the unconfirmed-stop rules. A stop the run
 * issues is bracketed by a stop intent (purpose and continuation, design
 * D2a), bounded by EXECUTOR_STOP_DEADLINE_MS, saved, then traced, and only a
 * confirmed stop (terminal and driver gone) frees the run's lease. A
 * confirmed stop whose continuation is task work (a recovery, a repair, a
 * replacement, a failed task) keeps its intent, marked confirmed, until that
 * continuation has its persisted result. An unconfirmed stop records the run
 * as `unconfirmed`: its lease stays held, its tree is not used again, and
 * the caller does not perform the continuation. The release check of a run
 * that ended by itself uses the same bounded stop without an intent and
 * keeps the run's terminal state (an unconfirmed release only marks the
 * driver as held). Held runs are checked again on demand (the scheduler,
 * the sweep before delivery) and released once seen stopped.
 */

import {
  EXECUTOR_CALL_DEADLINE_MS,
  EXECUTOR_GRACE_MS,
  EXECUTOR_STOP_DEADLINE_MS,
  type ExecutorRunRef,
  type RunIntent,
  type StopContinuation,
  type StopPurpose,
} from '../domain';

import { boundedDetail, withDeadline } from './deadline';
import { releaseLease, type RunContext } from './run-context';
import type { Lease } from './run-slots';

/** A stop intent, as saved. */
export type StopIntent = Extract<RunIntent, { kind: 'stop' }>;

/** The continuations that are task work: their stop intent stays, confirmed, until the work has its result. */
const TASK_CONTINUATIONS: readonly StopContinuation['do'][] = ['resume_recovery', 'start_repair', 'dispatch_replacement', 'mark_failed'];

/** Asks the executor for a bounded stop; anything but a confirmed `stopped` is unconfirmed. */
async function askStop(ctx: RunContext, executorRunId: string): Promise<{ readonly confirmed: boolean; readonly detail: string }> {
  const outcome = await withDeadline({
    call: () => ctx.ports.executor.stop(executorRunId, EXECUTOR_STOP_DEADLINE_MS),
    deadlineMs: EXECUTOR_STOP_DEADLINE_MS + EXECUTOR_GRACE_MS,
    sleep: ctx.ports.sleep,
  });
  if (outcome.status !== 'done') {
    return { confirmed: false, detail: boundedDetail(outcome) };
  }
  return { confirmed: outcome.value.outcome === 'stopped', detail: outcome.value.detail };
}

/** The trace correlation of an executor run. */
function runCorrelation(ref: ExecutorRunRef): { taskId: string; revision: number; attempt: number; executorRunId: string } {
  return { taskId: ref.taskId, revision: ref.revision, attempt: ref.attempt, executorRunId: ref.executorRunId };
}

/**
 * Stops a run for the purpose: saves the stop intent, then finishes it
 * (finishStop). Returns whether the stop was confirmed; the caller performs
 * the continuation only then.
 */
export async function stopRun(
  ctx: RunContext,
  ref: ExecutorRunRef,
  purpose: StopPurpose,
  continuation: StopContinuation,
): Promise<boolean> {
  const intent: StopIntent = {
    kind: 'stop',
    executorRunId: ref.executorRunId,
    taskId: ref.taskId,
    purpose,
    continuation,
    requestedAt: ctx.trace.now(),
    confirmed: false,
  };
  await ctx.owner.addIntent(intent);
  return finishStop(ctx, intent);
}

/**
 * Asks for the bounded stop of a saved stop intent and records the result:
 * the run `stopped` (its lease freed; a terminal state it reported itself is
 * kept) or `unconfirmed` (its lease kept). The intent is removed, or kept
 * as confirmed when its continuation is task work. Saved first, then traced.
 */
export async function finishStop(ctx: RunContext, intent: StopIntent): Promise<boolean> {
  const stop = await askStop(ctx, intent.executorRunId);
  const keep = stop.confirmed && TASK_CONTINUATIONS.includes(intent.continuation.do);
  await ctx.owner.update((state) => {
    state.intents = state.intents.flatMap((candidate) => {
      if (!isSameStop(candidate, intent)) {
        return [candidate];
      }
      return keep ? [{ ...intent, confirmed: true }] : [];
    });
    const run = state.runs[intent.executorRunId];
    if (run !== undefined) {
      state.runs[intent.executorRunId] = recordedStop(run, stop.confirmed);
    }
  });
  const run = ctx.owner.state.runs[intent.executorRunId];
  if (run !== undefined) {
    ctx.trace.emit({ type: 'executor_stopped', ...runCorrelation(run), purpose: intent.purpose, confirmed: stop.confirmed });
  }
  if (stop.confirmed) {
    releaseLease(ctx, intent.executorRunId);
  }
  return stop.confirmed;
}

/** True for the same stop intent (same run, same request instant). */
function isSameStop(candidate: RunIntent, intent: StopIntent): boolean {
  return candidate.kind === 'stop' && candidate.executorRunId === intent.executorRunId && candidate.requestedAt === intent.requestedAt;
}

/** A confirmed stop keeps a terminal status the run reported itself and clears a held driver; an unconfirmed one is recorded as such. */
function recordedStop(run: ExecutorRunRef, confirmed: boolean): ExecutorRunRef {
  const { driverHeld: _held, ...rest } = run;
  if (!confirmed) {
    return run.state === 'live' || run.state === 'unconfirmed' ? { ...rest, state: 'unconfirmed' } : { ...rest, driverHeld: true };
  }
  return { ...rest, state: run.state === 'live' || run.state === 'unconfirmed' ? 'stopped' : run.state };
}

/**
 * Confirms that a run which reported a terminal state has released its tree
 * (its driver is gone): a bounded stop with no intent, since the run already
 * ended. Frees the lease when confirmed; otherwise marks the driver held
 * (the terminal state is kept) and keeps the lease. Returns whether it was
 * confirmed.
 */
export async function confirmReleased(ctx: RunContext, ref: ExecutorRunRef): Promise<boolean> {
  const stop = await askStop(ctx, ref.executorRunId);
  if (stop.confirmed) {
    ctx.trace.emit({ type: 'executor_stopped', ...runCorrelation(ref), purpose: 'release', confirmed: true });
    releaseLease(ctx, ref.executorRunId);
    return true;
  }
  await ctx.owner.update((state) => {
    const run = state.runs[ref.executorRunId];
    if (run !== undefined) {
      state.runs[ref.executorRunId] = { ...run, driverHeld: true };
    }
  });
  ctx.trace.emit({ type: 'executor_stopped', ...runCorrelation(ref), purpose: 'release', confirmed: false });
  return false;
}

/** True when the run may still hold its tree: an unconfirmed stop or an unconfirmed release. */
export function isHeld(run: ExecutorRunRef): boolean {
  return run.state === 'unconfirmed' || run.driverHeld === true;
}

/** True when a run in the tree may still hold it, so no new run may use that tree. */
export function treeBlocked(ctx: RunContext, tree: string): boolean {
  return Object.values(ctx.owner.state.runs).some((run) => run.tree === tree && isHeld(run));
}

/**
 * Asks every held run to stop again (bounded) and records the ones seen
 * stopped, freeing their leases. Returns how many were released.
 */
export async function recheckHeldRuns(ctx: RunContext): Promise<number> {
  let released = 0;
  for (const run of Object.values(ctx.owner.state.runs).filter((candidate) => isHeld(candidate))) {
    const stop = await askStop(ctx, run.executorRunId);
    if (!stop.confirmed) {
      continue;
    }
    await ctx.owner.update((state) => {
      const current = state.runs[run.executorRunId];
      if (current !== undefined) {
        state.runs[run.executorRunId] = recordedStop(current, true);
      }
    });
    ctx.trace.emit({ type: 'executor_stopped', ...runCorrelation(run), purpose: 'recheck', confirmed: true });
    releaseLease(ctx, run.executorRunId);
    released += 1;
  }
  return released;
}

/**
 * Stops every live or held run without touching the run state, for a run
 * whose state can no longer be saved. Each stop is bounded and traced when
 * the trace still accepts it.
 */
export async function stopAllWithoutState(ctx: RunContext, purpose: string): Promise<void> {
  const runs = Object.values(ctx.owner.state.runs).filter((run) => run.state === 'live' || isHeld(run));
  await Promise.all(runs.map((run) => stopQuietly(ctx, run.executorRunId, purpose, runCorrelation(run))));
}

/**
 * Stops one run without the run state (a run that could not be registered,
 * or the runs of a task that hit an unexpected error): bounded, its lease
 * freed when confirmed, traced when the trace still accepts it.
 */
export async function stopQuietly(
  ctx: RunContext,
  executorRunId: string,
  purpose: string,
  correlation: { readonly taskId?: string; readonly executorRunId: string },
  lease?: Lease,
): Promise<boolean> {
  const stop = await askStop(ctx, executorRunId);
  if (stop.confirmed) {
    releaseLease(ctx, executorRunId);
    if (lease !== undefined) {
      ctx.slots.release(lease);
    }
  }
  try {
    ctx.trace.emit({ type: 'executor_stopped', ...correlation, purpose, confirmed: stop.confirmed });
  } catch {
    // The trace is down too: the stop itself is what matters here.
  }
  return stop.confirmed;
}

/**
 * The checks before delivery: every held run is asked to stop again (its
 * lease is freed once it is seen stopped), and every abandoned tree is
 * looked up once more, a run found there being stopped as an orphan.
 */
export async function sweepBeforeDelivery(ctx: RunContext): Promise<void> {
  await recheckHeldRuns(ctx);
  for (const abandoned of ctx.owner.state.abandonedTrees) {
    const found = await withDeadline({
      call: () => ctx.ports.executor.findRuns({ playbook: abandoned.playbook, tree: abandoned.tree, notBefore: abandoned.at }),
      deadlineMs: EXECUTOR_CALL_DEADLINE_MS,
      sleep: ctx.ports.sleep,
    });
    if (found.status !== 'done') {
      continue;
    }
    for (const run of found.value.filter((info) => !(info.runId in ctx.owner.state.runs))) {
      ctx.trace.emit({ type: 'orphan_found', executorRunId: run.runId, detail: `run found in the abandoned tree ${abandoned.tree}` });
      const stop = await askStop(ctx, run.runId);
      ctx.trace.emit({ type: 'executor_stopped', executorRunId: run.runId, purpose: 'orphan', confirmed: stop.confirmed });
    }
  }
}
