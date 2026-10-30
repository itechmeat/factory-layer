/**
 * Settling a start the cutoff or a re-plan halted. When the start call is
 * still in flight (it ran past its deadline), its intent and lease are kept
 * while the call is awaited, bounded by the start deadline and not by the
 * cutoff: the run it created is stopped; a lost answer is settled by looking
 * the run up by playbook, tree and intent time through the settle window,
 * and every run found is stopped. Only then the tree is recorded as
 * abandoned, the start intent dropped and the lease freed (a lease is kept
 * when the stop of its run is not confirmed). Without a start in flight the
 * tree is abandoned and the lease freed at once.
 */

import { EXECUTOR_CALL_DEADLINE_MS, EXECUTOR_LOOKUP_INTERVAL_MS, EXECUTOR_SETTLE_WINDOW_MS, type RunState } from '../domain';
import type { StartRunResult } from '../ports';

import { withDeadline } from './deadline';
import type { RunContext } from './run-context';
import type { Lease } from './run-slots';
import { stopQuietly } from './stops';

/** The fields of a start intent this settling reads. */
export interface HaltedStartIntent {
  readonly taskId: string;
  readonly dispatchKey: string;
  readonly playbook: string;
  readonly tree: string;
  readonly at: string;
}

/** Records the intent's tree as abandoned (checked again before delivery) and drops the start intent. */
export function abandonTree(state: RunState, intent: HaltedStartIntent): void {
  state.abandonedTrees.push({ playbook: intent.playbook, tree: intent.tree, at: intent.at });
  state.intents = state.intents.filter((candidate) => !(candidate.kind === 'start' && candidate.dispatchKey === intent.dispatchKey));
}

/** Settles a halted start (see the module header); `inFlight` is the start call when it has not answered yet. */
export async function settleHaltedStart(
  ctx: RunContext,
  intent: HaltedStartIntent,
  inFlight: Promise<StartRunResult> | null,
  lease: Lease,
): Promise<void> {
  const runIds = inFlight === null ? [] : await runsOfStart(ctx, intent, inFlight);
  for (const [index, id] of runIds.entries()) {
    await stopQuietly(ctx, id, 'orphan', { taskId: intent.taskId, executorRunId: id }, index === 0 ? lease : undefined);
  }
  await ctx.owner.update((state) => {
    abandonTree(state, intent);
  });
  if (runIds.length === 0) {
    ctx.slots.release(lease);
  }
}

/** The runs the in-flight start created: its answer's run, none when refused, else the runs a lookup finds. */
async function runsOfStart(ctx: RunContext, intent: HaltedStartIntent, inFlight: Promise<StartRunResult>): Promise<readonly string[]> {
  const answer = await withDeadline({ call: () => inFlight, deadlineMs: EXECUTOR_CALL_DEADLINE_MS, sleep: ctx.ports.sleep });
  if (answer.status === 'done') {
    const result = answer.value;
    if (result.ok) {
      return [result.runId];
    }
    if (result.outcome === 'refused') {
      return [];
    }
  }
  return lookUpUntil(ctx, intent, ctx.trace.nowMs() + EXECUTOR_SETTLE_WINDOW_MS);
}

/** Looks the run up until one is found or the window ends; no signal, so the cutoff does not cut it short. */
async function lookUpUntil(ctx: RunContext, intent: HaltedStartIntent, windowEndMs: number): Promise<readonly string[]> {
  for (;;) {
    const lookup = await withDeadline({
      call: () => ctx.ports.executor.findRuns({ playbook: intent.playbook, tree: intent.tree, notBefore: intent.at }),
      deadlineMs: EXECUTOR_CALL_DEADLINE_MS,
      sleep: ctx.ports.sleep,
    });
    const found = lookup.status === 'done' ? lookup.value.map((info) => info.runId) : [];
    const leftMs = windowEndMs - ctx.trace.nowMs();
    if (found.length > 0 || leftMs <= 0) {
      return found;
    }
    await ctx.ports.sleep(Math.min(EXECUTOR_LOOKUP_INTERVAL_MS, leftMs));
  }
}
