/**
 * The run's cutoff (task 3.9). The cutoff is an absolute instant in the run
 * state, or the moment the caller cancels the run (its signal sets the
 * cutoff to now). It aborts the cutoff signal, which cancels every pending
 * decision and every task runner's wait; from then on no dispatch,
 * recovery, re-plan or integration starts (each checks `cutoffPassed`).
 * The scheduler does not wait for the task runners: every live executor run
 * is stopped at once, in parallel, with the bounded stop, a run whose stop
 * cannot be confirmed is traced as abandoned, an advance of `main` already
 * under way is awaited (at most MAIN_ADVANCE_GRACE_MS: one git command and
 * its saves) so its task ends integrated, and every task that has not
 * ended fails with `cutoff`; then delivery starts. A result a runner gets
 * after this is discarded (`discardedAsStale`).
 */

import { EXECUTOR_GRACE_MS, GIT_COMMAND_TIMEOUT_MS, type ExecutorRunRef } from '../domain';
import type { Sleep } from '../ports';

import { cutoffPassed, type RunContext } from './run-context';
import { stopRun } from './stops';

/** How long the cutoff waits for an advance of main under way: its git compare-and-swap and the saves around it. */
const MAIN_ADVANCE_GRACE_MS = GIT_COMMAND_TIMEOUT_MS + EXECUTOR_GRACE_MS;

/** What the cutoff watch needs; it exists before the run state does (planning). */
export interface CutoffWatch {
  readonly cutoff: AbortController;
  readonly atMs: number | null;
  readonly sleep: Sleep;
  readonly nowMs: () => number;
  /** The caller's cancellation, if any. */
  readonly signal?: AbortSignal | undefined;
  /** Called with the instant the caller cancelled at, to persist it as the cutoff. */
  readonly onCancel: (atMs: number) => void;
}

/**
 * Aborts the cutoff signal when the cutoff instant comes or the caller's
 * signal aborts. Returns the function that ends the watch when the run ends.
 */
export function watchCutoff(watch: CutoffWatch): () => void {
  const ended = new AbortController();
  if (watch.atMs !== null) {
    watch.sleep(Math.max(0, watch.atMs - watch.nowMs()), ended.signal).then(
      () => watch.cutoff.abort(),
      () => undefined,
    );
  }
  const onCancel = (): void => {
    watch.cutoff.abort();
    watch.onCancel(watch.nowMs());
  };
  if (watch.signal?.aborted === true) {
    onCancel();
  } else {
    watch.signal?.addEventListener('abort', onCancel, { once: true });
  }
  return () => {
    ended.abort();
    watch.signal?.removeEventListener('abort', onCancel);
  };
}

/** Saves a caller's cancellation as the run's cutoff, when the state still saves and has no earlier cutoff. */
export function saveCancellation(ctx: RunContext, atMs: number): void {
  const current = ctx.owner.state.cutoffAtMs;
  if (ctx.owner.storageFailure !== null || (current !== null && current <= atMs)) {
    return;
  }
  ctx.owner
    .update((state) => {
      state.cutoffAtMs = atMs;
    })
    .catch(() => undefined);
}

/** Stops every live run (unconfirmed ones traced as abandoned) and fails every task that has not ended. */
export async function reachCutoff(ctx: RunContext): Promise<void> {
  if (!cutoffPassed(ctx)) {
    return;
  }
  ctx.cutoff.abort();
  ctx.trace.emit({ type: 'cutoff_reached' });
  const live = Object.values(ctx.owner.state.runs).filter((run) => run.state === 'live');
  await Promise.all([...live.map((run) => stopAtCutoff(ctx, run)), settleAdvance(ctx)]);
  for (const [taskId, task] of Object.entries(ctx.owner.state.tasks)) {
    if (task.state !== 'integrated' && task.state !== 'failed') {
      await ctx.owner.fail(taskId, 'cutoff');
    }
  }
}

/** Waits, at most MAIN_ADVANCE_GRACE_MS, for an advance of main under way; its own failure is its runner's to report. */
async function settleAdvance(ctx: RunContext): Promise<void> {
  const advancing = ctx.integrations.advanceInFlight();
  if (advancing === null) {
    return;
  }
  const bound = new AbortController();
  const timer = ctx.ports.sleep(MAIN_ADVANCE_GRACE_MS, bound.signal).catch(() => undefined);
  await Promise.race([advancing.catch(() => undefined), timer]);
  bound.abort();
}

async function stopAtCutoff(ctx: RunContext, run: ExecutorRunRef): Promise<void> {
  if (await stopRun(ctx, run, 'cutoff', { do: 'continue_cutoff' })) {
    return;
  }
  ctx.trace.emit({
    type: 'executor_failure',
    taskId: run.taskId,
    revision: run.revision,
    attempt: run.attempt,
    executorRunId: run.executorRunId,
    reason: 'abandoned: the stop at the cutoff was not confirmed',
  });
}
