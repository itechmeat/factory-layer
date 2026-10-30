/**
 * Readiness and dispatch (task 3.3): the loop that owns which tasks run.
 * Each turn, unless the cutoff passed or a runtime re-plan is in progress
 * (dispatch pauses), it fails the pending tasks that depend on a failed
 * task (`dependency_failed`, to a fixpoint, so independent tasks go on),
 * moves the pending tasks whose dependencies are all integrated to `ready`,
 * starts a runner for every task found mid-way without one (on resume, or
 * after a failed re-plan; resume.ts names its step), and starts a runner
 * for each ready task in the stable topological order while the run's cap
 * has a free permit (the permit is taken in the same tick, so the cap holds
 * exactly). It then waits for a runner to end or a lease to be released
 * (a permit freed while its task still judges is used at once) and goes
 * again. At the cutoff it stops waiting for the runners at once: it stops
 * the live runs in parallel, ends the open tasks (cutoff.ts) and returns,
 * so delivery starts while a runner may still finish a call that ignores
 * the cutoff (its late result is discarded; `drainRunners` lets those
 * runners settle, bounded, after delivery). With no runner left it ends,
 * except that when tasks still wait while every permit is held by runs
 * whose stop or release was not confirmed, it checks those runs again every lookup interval and
 * fails the waiting tasks (`slots_held`) once the run's stall limit has
 * passed without a permit coming back. A storage failure or the run's
 * abort inside a runner takes every other runner over, waits for them to
 * end, and ends the loop with that error.
 */

import {
  EXECUTOR_CALL_DEADLINE_MS,
  EXECUTOR_GRACE_MS,
  EXECUTOR_LOOKUP_INTERVAL_MS,
  EXECUTOR_SETTLE_WINDOW_MS,
  EXECUTOR_STOP_DEADLINE_MS,
  isReady,
  topologicalOrder,
} from '../domain';

import { reachCutoff } from './cutoff';
import { entryFor } from './resume';
import { beginTaskWork, cutoffPassed, replanInProgress, supersede, taskSignal, type RunContext } from './run-context';
import { recheckHeldRuns } from './stops';
import { taskRequest } from './task-inputs';
import { runTask, type Step } from './task-runner';

/** Runs every task of the plan to its end (integrated or failed), within the caps. */
export async function runSchedule(ctx: RunContext): Promise<void> {
  const { runners } = ctx;
  const fatal: unknown[] = [];
  const start = (taskId: string, step: (signal: AbortSignal) => Step): void => {
    beginTaskWork(ctx, taskId);
    const runner = runTask(ctx, taskId, step(taskSignal(ctx, taskId)))
      .catch((error: unknown) => {
        fatal.push(error);
      })
      .finally(() => {
        runners.delete(taskId);
      });
    runners.set(taskId, runner);
  };
  const cutoffReached = new Promise<void>((resolve) => {
    ctx.cutoff.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  let starvedSinceMs: number | null = null;
  for (;;) {
    if (fatal.length > 0) {
      supersede(ctx, [...runners.keys()]);
      await Promise.allSettled(runners.values());
      throw fatal[0];
    }
    if (!cutoffPassed(ctx) && !replanInProgress(ctx)) {
      await failDependants(ctx);
      await promoteReady(ctx);
      await startFoundTasks(ctx, start);
      for (const taskId of topologicalOrder(ctx.owner.state.plan)) {
        if (ctx.slots.freeLocal() === 0) {
          break;
        }
        if (ctx.owner.task(taskId).state !== 'ready' || runners.has(taskId)) {
          continue;
        }
        start(taskId, (signal) => ({
          kind: 'dispatch',
          request: taskRequest(ctx, taskId),
          lease: ctx.slots.acquire(signal),
          consumeAttempt: false,
        }));
      }
    }
    if (runners.size > 0 && !cutoffPassed(ctx)) {
      starvedSinceMs = null;
      await Promise.race([...runners.values(), ctx.slots.released(), cutoffReached]);
      continue;
    }
    if (cutoffPassed(ctx)) {
      await reachCutoff(ctx);
      return;
    }
    const waiting = Object.keys(ctx.owner.state.tasks).filter((taskId) => ['pending', 'ready'].includes(ctx.owner.task(taskId).state));
    if (waiting.length === 0) {
      return;
    }
    starvedSinceMs = await waitForHeldRuns(ctx, waiting, starvedSinceMs ?? ctx.trace.nowMs());
  }
}

/**
 * How long the run waits after delivery for the runners the cutoff left
 * behind: long enough for a halted start to be awaited, settled by lookup
 * and its run stopped (halted-start.ts).
 */
const CUTOFF_DRAIN_MS =
  EXECUTOR_CALL_DEADLINE_MS + EXECUTOR_GRACE_MS + EXECUTOR_SETTLE_WINDOW_MS + EXECUTOR_STOP_DEADLINE_MS + EXECUTOR_GRACE_MS;

/** Waits, at most CUTOFF_DRAIN_MS, for the runners still working after the cutoff; a runner past the bound is left behind. */
export async function drainRunners(ctx: RunContext): Promise<void> {
  if (ctx.runners.size === 0) {
    return;
  }
  const bound = new AbortController();
  const timer = ctx.ports.sleep(CUTOFF_DRAIN_MS, bound.signal).catch(() => undefined);
  await Promise.race([Promise.allSettled(ctx.runners.values()), timer]);
  bound.abort();
}

/** Starts a runner, at its entry step, for every task found mid-way without one. */
async function startFoundTasks(ctx: RunContext, start: (taskId: string, step: () => Step) => void): Promise<void> {
  for (const taskId of topologicalOrder(ctx.owner.state.plan)) {
    if (ctx.runners.has(taskId)) {
      continue;
    }
    const step = await entryFor(ctx, taskId);
    if (step !== null) {
      start(taskId, () => step);
    }
  }
}

/**
 * Every permit is held by runs whose stop or release was not confirmed:
 * checks them again; with none released, fails the waiting tasks once the
 * stall limit has passed since the starvation began, else waits one lookup
 * interval. Returns when the starvation began, or null when it ended.
 */
async function waitForHeldRuns(ctx: RunContext, waiting: readonly string[], sinceMs: number): Promise<number | null> {
  if ((await recheckHeldRuns(ctx)) > 0) {
    return null;
  }
  if (ctx.trace.nowMs() - sinceMs >= ctx.limits.executorStallLimitMs) {
    for (const taskId of waiting) {
      await ctx.owner.fail(taskId, 'slots_held');
    }
    return null;
  }
  try {
    await ctx.ports.sleep(EXECUTOR_LOOKUP_INTERVAL_MS, AbortSignal.any([ctx.signal, ctx.cutoff.signal]));
  } catch {
    ctx.signal.throwIfAborted();
  }
  return sinceMs;
}

/** Fails every pending or ready task with a failed dependency, until no more change. */
async function failDependants(ctx: RunContext): Promise<void> {
  for (let changed = true; changed;) {
    changed = false;
    for (const task of ctx.owner.state.plan.tasks) {
      const state = ctx.owner.task(task.id).state;
      if (state !== 'pending' && state !== 'ready') {
        continue;
      }
      if (task.dependsOn.some((id) => ctx.owner.state.tasks[id]?.state === 'failed')) {
        await ctx.owner.transition(task.id, 'failed', 'dependency_failed');
        changed = true;
      }
    }
  }
}

/** Moves the pending tasks whose dependencies are all integrated to ready. */
async function promoteReady(ctx: RunContext): Promise<void> {
  for (const taskId of topologicalOrder(ctx.owner.state.plan)) {
    const task = ctx.owner.planTask(taskId);
    if (ctx.owner.task(taskId).state === 'pending' && isReady(task.dependsOn, (id) => ctx.owner.state.tasks[id]?.state)) {
      await ctx.owner.transition(taskId, 'ready', 'every dependency is integrated');
    }
  }
}
