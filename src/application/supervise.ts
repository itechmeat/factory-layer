/**
 * Supervising one live executor run (task 3.4). Events are awaited in
 * bounded slices after the persisted cursor, and the new cursor and event
 * time are saved after each event. A run with no event for the stall limit
 * (the run's resolved limit) is stopped and treated as an executor failure;
 * so are a run that waits for a host agent and a wake the factory cannot
 * serve (a question, a review, a stalled run: design D2d point 3). A node
 * failure reported while the run is live goes to recovery at once, the run
 * still live. A terminal event records the run's end, collects its report
 * once (the executor's usage, priced), and confirms the driver released the
 * tree before anyone may reuse it (checked twice); a succeeded run whose
 * release stays unconfirmed is not committed: its task fails with
 * `stop_unconfirmed`. Every state change is saved before its
 * trace event (design D3). The waits honour the task's work signal: at the
 * cutoff or when a re-plan takes the task over, supervision ends at once and
 * leaves the run to whoever stops it.
 */

import { EXECUTOR_CALL_DEADLINE_MS, EXECUTOR_GRACE_MS, EXECUTOR_WAIT_SLICE_MS, type ExecutorRunRef, type TaskFailure } from '../domain';
import type { ExecutorEvent, ExecutorReport } from '../ports';

import { priceRecords } from './decide';
import { boundedDetail, withDeadline } from './deadline';
import { halted, recordHistory, taskFailure, taskSignal, type RunContext } from './run-context';
import { confirmReleased, stopRun } from './stops';

/** How a supervised run ended for its task. */
export type SuperviseOutcome =
  | { readonly kind: 'succeeded'; readonly report: ExecutorReport }
  | { readonly kind: 'failed'; readonly failure: TaskFailure; readonly live: boolean }
  | { readonly kind: 'ended' };

/** The wake triggers the factory cannot serve: the run is stopped and the attempt counts as an executor failure. */
const UNSERVED_TRIGGERS: readonly string[] = ['question', 'review', 'stalled'];

/** Waits on the run until it needs a decision; see the module header. */
export async function supervise(ctx: RunContext, executorRunId: string): Promise<SuperviseOutcome> {
  for (;;) {
    ctx.signal.throwIfAborted();
    const ref = mustRun(ctx, executorRunId);
    if (halted(ctx, ref.taskId)) {
      return { kind: 'ended' };
    }
    const stallAtMs = Date.parse(ref.lastEventAt) + ctx.limits.executorStallLimitMs;
    const nowMs = ctx.trace.nowMs();
    if (nowMs >= stallAtMs) {
      return stopForFailure(ctx, ref, 'stalled', `no executor event for ${ctx.limits.executorStallLimitMs} ms`);
    }
    const sliceMs = Math.min(EXECUTOR_WAIT_SLICE_MS, stallAtMs - nowMs);
    const wait = await withDeadline({
      call: () => ctx.ports.executor.waitEvent(executorRunId, ref.cursor, sliceMs),
      deadlineMs: sliceMs + EXECUTOR_GRACE_MS,
      sleep: ctx.ports.sleep,
      signal: taskSignal(ctx, ref.taskId),
    });
    if (wait.status === 'cancelled') {
      ctx.signal.throwIfAborted();
      return { kind: 'ended' };
    }
    if (wait.status === 'failed') {
      return stopForFailure(ctx, ref, 'executor_error', boundedDetail(wait));
    }
    if (wait.status === 'timeout' || wait.value.event.kind === 'quiet') {
      continue;
    }
    const outcome = await handleEvent(ctx, ref, wait.value.event, wait.value.nextAfterSeq);
    if (outcome !== null) {
      return outcome;
    }
  }
}

/** Traces and handles one event; null means keep waiting. */
async function handleEvent(
  ctx: RunContext,
  ref: ExecutorRunRef,
  event: Exclude<ExecutorEvent, { kind: 'quiet' }>,
  nextAfterSeq: number,
): Promise<SuperviseOutcome | null> {
  const traceEvent = (): void => {
    ctx.trace.emit({
      type: 'executor_event',
      ...runCorrelation(ref),
      ...(event.kind === 'wake' && event.nodeId !== null ? { nodeId: event.nodeId } : {}),
      kind: event.kind,
      trigger: event.kind === 'wake' ? event.trigger : null,
      seq: event.kind === 'wake' ? event.seq : nextAfterSeq,
      detail: event.kind === 'wake' && event.detail !== null ? ctx.trace.redact(event.detail) : null,
    });
  };
  if (event.kind === 'terminal') {
    return finish(ctx, ref, event.status, traceEvent);
  }
  await recordEvent(ctx, ref, nextAfterSeq);
  traceEvent();
  if (event.kind === 'needs_host') {
    return stopForFailure(ctx, ref, 'needs_host', 'the run waits for a host agent');
  }
  if (UNSERVED_TRIGGERS.includes(event.trigger)) {
    return stopForFailure(ctx, ref, event.trigger, `the run woke with ${event.trigger}: ${event.detail ?? 'no detail'}`);
  }
  if (event.trigger !== 'node_failed') {
    return null;
  }
  const detail = event.detail ?? 'node failed';
  if (event.nodeId === null) {
    return stopForFailure(ctx, ref, 'node_failed', detail);
  }
  const reason = detail === 'timeout' || detail.startsWith('timeout:') ? 'timeout' : 'node_failed';
  recordHistory(ctx, ref.taskId, 'executor_failure', `node ${event.nodeId} ${reason}: ${detail}`);
  return { kind: 'failed', live: true, failure: taskFailure(ctx, ref.taskId, { reason, detail, nodeId: event.nodeId }) };
}

/** Saves the cursor and the event time after an event. */
async function recordEvent(ctx: RunContext, ref: ExecutorRunRef, cursor: number): Promise<void> {
  const at = ctx.trace.now();
  await ctx.owner.update((state) => {
    const run = state.runs[ref.executorRunId];
    if (run !== undefined) {
      state.runs[ref.executorRunId] = { ...run, cursor, lastEventAt: at };
    }
  });
}

/** A run that reported its terminal state: record it, collect the report, confirm the tree is released. */
async function finish(
  ctx: RunContext,
  ref: ExecutorRunRef,
  status: ExecutorReport['status'],
  traceEvent: () => void,
): Promise<SuperviseOutcome> {
  const at = ctx.trace.now();
  await ctx.owner.update((state) => {
    const run = state.runs[ref.executorRunId];
    if (run !== undefined) {
      state.runs[ref.executorRunId] = { ...run, state: status, lastEventAt: at };
    }
  });
  traceEvent();
  const report = await collectReport(ctx, ref, status);
  const released = (await confirmReleased(ctx, ref)) || (await confirmReleased(ctx, ref));
  if (status === 'succeeded') {
    if (!released) {
      // The driver may still change the tree: nothing is committed or integrated (unconfirmed-stop rules).
      await ctx.owner.fail(ref.taskId, 'stop_unconfirmed');
      return { kind: 'ended' };
    }
    return { kind: 'succeeded', report };
  }
  const failedNode = report.nodes.find((node) => node.outcome === 'failed');
  const detail = `the run ended ${status}: ${report.summary}`;
  recordHistory(ctx, ref.taskId, 'executor_failure', detail);
  return {
    kind: 'failed',
    live: false,
    failure: taskFailure(ctx, ref.taskId, { reason: `run_${status}`, detail, nodeId: failedNode?.nodeId ?? null }),
  };
}

/**
 * Stops the run as an executor failure (stall, host wait, unserved wake,
 * broken wait). A confirmed stop hands the task to recovery with the run
 * finished; an unconfirmed one fails the task with `stop_unconfirmed`.
 */
async function stopForFailure(ctx: RunContext, ref: ExecutorRunRef, reason: string, detail: string): Promise<SuperviseOutcome> {
  ctx.trace.emit({ type: 'executor_failure', ...runCorrelation(ref), reason: ctx.trace.redact(`${reason}: ${detail}`) });
  recordHistory(ctx, ref.taskId, 'executor_failure', `${reason}: ${detail}`);
  const attempt = ctx.owner.task(ref.taskId).attemptsUsed;
  const confirmed = await stopRun(ctx, ref, 'recovery', {
    do: 'resume_recovery',
    taskId: ref.taskId,
    revision: ref.revision,
    attempt,
    reason,
    detail: ctx.trace.redact(detail),
  });
  if (!confirmed) {
    await ctx.owner.fail(ref.taskId, 'stop_unconfirmed');
    return { kind: 'ended' };
  }
  await collectReport(ctx, ref, 'stopped');
  return { kind: 'failed', live: false, failure: taskFailure(ctx, ref.taskId, { reason, detail }) };
}

/** Collects the run's report once and traces its end with the priced usage; a lost report is traced as unavailable. */
export async function collectReport(ctx: RunContext, ref: ExecutorRunRef, status: ExecutorReport['status']): Promise<ExecutorReport> {
  const fetched = await withDeadline({
    call: () => ctx.ports.executor.report(ref.executorRunId),
    deadlineMs: EXECUTOR_CALL_DEADLINE_MS,
    sleep: ctx.ports.sleep,
  });
  const report: ExecutorReport =
    fetched.status === 'done'
      ? fetched.value
      : { runId: ref.executorRunId, status, summary: `report unavailable: ${boundedDetail(fetched)}`, nodes: [], usage: [] };
  ctx.trace.emit({
    type: 'executor_ended',
    ...runCorrelation(ref),
    status: report.status,
    usage: priceRecords(report.usage, ctx.ports.costs, runCorrelation(ref)),
  });
  return report;
}

function runCorrelation(ref: ExecutorRunRef): { taskId: string; revision: number; attempt: number; executorRunId: string } {
  return { taskId: ref.taskId, revision: ref.revision, attempt: ref.attempt, executorRunId: ref.executorRunId };
}

function mustRun(ctx: RunContext, executorRunId: string): ExecutorRunRef {
  const run = ctx.owner.state.runs[executorRunId];
  if (run === undefined) {
    throw new Error(`unknown executor run ${executorRunId}`);
  }
  return run;
}
