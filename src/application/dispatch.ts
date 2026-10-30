/**
 * Dispatching one executor run of a task (task 3.3). For each dispatch the
 * task's tree is created, a start intent with the dispatch key (run, task,
 * revision, attempt), playbook, tree and instant is saved, the supervised
 * run is started with that key, and its mapping (run id, token, cursor) is
 * saved. A key that already has a run starts nothing (idempotent dispatch).
 * A refused start fails the task with `executor_refused` and the policy. An
 * indeterminate start is settled by looking the run up by playbook, tree and
 * intent time, repeated through the settle window while the intent and the
 * lease are kept: a found run is an orphan, stopped and confirmed before a
 * replacement starts as a new revision; an empty window abandons the tree
 * and dispatches a new revision in a new tree within the same attempt. A
 * lost repair or integrate start is never replaced in a fresh tree: the task
 * fails with `start_lost`. The cutoff or a re-plan during the settling ends
 * it with no replacement; a start call still in flight is settled first and
 * its run stopped (halted-start.ts). An orphan whose
 * stop is not confirmed fails the task (`orphan_unconfirmed`) and keeps its
 * lease. The start intent holds the request and saves the
 * attempt it starts (a new attempt only when asked), replacing the task's
 * earlier start intent and confirmed stop intents in the same save; the
 * abandoned tree and the new revision are one save. When the run's state
 * stops saving while a start is in flight, the run the start created (or a
 * bounded lookup without the aborted signal finds) is stopped before the
 * error propagates. A resume settles a start intent the same way.
 */

import {
  EXECUTOR_CALL_DEADLINE_MS,
  EXECUTOR_LOOKUP_INTERVAL_MS,
  EXECUTOR_SETTLE_WINDOW_MS,
  makeDispatchKey,
  type DispatchRequestRecord,
  type ExecutorRunRef,
  type RunIntent,
} from '../domain';
import type { ExecutorRunInfo, ExecutorStartInputs, StartRunResult } from '../ports';

import { boundedDetail, withDeadline } from './deadline';
import { abandonTree, settleHaltedStart } from './halted-start';
import { halted, recordHistory, taskSignal, type RunContext } from './run-context';
import { dropConfirmedStops } from './run-owner';
import type { Lease } from './run-slots';
import { stopQuietly, stopRun } from './stops';

/** What one executor run of a task is for, and how to start it. */
export interface DispatchRequest {
  readonly taskId: string;
  readonly role: ExecutorRunRef['role'];
  readonly playbook: string;
  readonly inputs: ExecutorStartInputs;
}

/** How a dispatch counts: `consumeAttempt` starts a new attempt; `resumeIntent` settles a start intent found on resume. */
export interface DispatchOptions {
  readonly consumeAttempt?: boolean;
  readonly resumeIntent?: StartIntent;
}

/** A started (or already existing) run to supervise, or a task that ended in the dispatch. */
export type DispatchResult = { readonly kind: 'started'; readonly executorRunId: string } | { readonly kind: 'ended' };

/** A start intent, as saved. */
export type StartIntent = Extract<RunIntent, { kind: 'start' }>;

/** The persisted form of a request (plain arrays), for intents and continuations. */
export function requestRecord(request: DispatchRequest): DispatchRequestRecord {
  const { inputs } = request;
  return {
    taskId: request.taskId,
    role: request.role,
    playbook: request.playbook,
    inputs: {
      taskText: inputs.taskText,
      ownedPaths: [...inputs.ownedPaths],
      ...(inputs.failingChecks === undefined ? {} : { failingChecks: inputs.failingChecks.map((check) => ({ ...check })) }),
      ...(inputs.conflictPaths === undefined ? {} : { conflictPaths: [...inputs.conflictPaths] }),
    },
  };
}

/** The request of a persisted record (an intent or a continuation). */
export function requestOf(record: DispatchRequestRecord): DispatchRequest {
  const { failingChecks, conflictPaths, ...base } = record.inputs;
  return {
    taskId: record.taskId,
    role: record.role,
    playbook: record.playbook,
    inputs: {
      ...base,
      ...(failingChecks === undefined ? {} : { failingChecks }),
      ...(conflictPaths === undefined ? {} : { conflictPaths }),
    },
  };
}

/** Starts the request's run under the lease; see the module header for every outcome. */
export async function dispatchRun(
  ctx: RunContext,
  request: DispatchRequest,
  firstLease: Lease,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const { owner } = ctx;
  let lease = firstLease;
  let consume = options.consumeAttempt === true;
  let pending = options.resumeIntent ?? null;
  for (;;) {
    let intent: StartIntent;
    let inFlight: Promise<StartRunResult> | null = null;
    if (pending === null) {
      const task = owner.task(request.taskId);
      const attempt = task.attemptsUsed === 0 || consume ? task.attemptsUsed + 1 : task.attemptsUsed;
      consume = false;
      const dispatchKey = makeDispatchKey(owner.state.runId, request.taskId, task.revision, attempt);
      const existing = Object.values(owner.state.runs).find((run) => run.dispatchKey === dispatchKey);
      if (existing !== undefined) {
        ctx.slots.release(lease);
        return { kind: 'started', executorRunId: existing.executorRunId };
      }
      const tree = await taskTreeOrRelease(ctx, request.taskId, task.revision, lease);
      if (task.state !== 'running') {
        await owner.transition(request.taskId, 'running', `dispatch of a ${request.role} run`);
      }
      intent = {
        kind: 'start',
        dispatchKey,
        taskId: request.taskId,
        revision: task.revision,
        attempt,
        playbook: request.playbook,
        tree: tree.tree,
        at: ctx.trace.now(),
        request: requestRecord(request),
      };
      await saveStartIntent(ctx, intent);
      const outcome = await startOnce(ctx, request, intent, lease);
      if (outcome.kind !== 'indeterminate') {
        return outcome;
      }
      inFlight = outcome.inFlight;
    } else {
      intent = pending;
      pending = null;
    }
    const next = await settleIndeterminate(ctx, request, intent, inFlight, lease);
    if (next === null) {
      return { kind: 'ended' };
    }
    if (halted(ctx, request.taskId)) {
      ctx.slots.release(next);
      return { kind: 'ended' };
    }
    lease = next;
  }
}

/** Saves the start intent with its attempt; it replaces the task's earlier start intents and confirmed stop intents. */
async function saveStartIntent(ctx: RunContext, intent: StartIntent): Promise<void> {
  await ctx.owner.update((state) => {
    const task = state.tasks[intent.taskId];
    if (task !== undefined) {
      task.attemptsUsed = intent.attempt;
    }
    state.intents = state.intents.filter((candidate) => !(candidate.kind === 'start' && candidate.taskId === intent.taskId));
    dropConfirmedStops(state, intent.taskId);
    state.intents.push(intent);
  });
}

/** An indeterminate start to settle, with the start call when it ran past its deadline unanswered. */
interface Indeterminate {
  readonly kind: 'indeterminate';
  readonly inFlight: Promise<StartRunResult> | null;
}

/** One start call: a started or refused run, or an indeterminate start to settle. */
async function startOnce(
  ctx: RunContext,
  request: DispatchRequest,
  intent: StartIntent,
  lease: Lease,
): Promise<DispatchResult | Indeterminate> {
  const call = (): Promise<StartRunResult> =>
    ctx.ports.executor.startRun({
      dispatchKey: intent.dispatchKey,
      playbook: intent.playbook,
      tree: intent.tree,
      inputs: request.inputs,
    });
  const calls: Promise<StartRunResult>[] = [];
  const start = await withDeadline({
    call: () => {
      const started = call();
      calls.push(started);
      return started;
    },
    deadlineMs: EXECUTOR_CALL_DEADLINE_MS,
    sleep: ctx.ports.sleep,
    signal: ctx.signal,
  });
  const answer = start.status === 'done' ? start.value : null;
  const lost = start.status === 'done' ? null : boundedDetail(start);
  if (ctx.signal.aborted) {
    await settleAborted(ctx, intent, answer?.ok === true ? answer.runId : null, lease);
    ctx.signal.throwIfAborted();
  }
  if (answer?.ok === true) {
    await registerOrStop(ctx, request, intent, { runId: answer.runId, supervisorToken: answer.supervisorToken }, lease);
    return { kind: 'started', executorRunId: answer.runId };
  }
  if (answer?.ok === false && answer.outcome === 'refused') {
    await refuse(ctx, intent, answer.policy, answer.detail, lease);
    return { kind: 'ended' };
  }
  const detail = answer === null ? (lost ?? 'no answer') : answer.detail;
  ctx.trace.emit({
    type: 'executor_failure',
    ...ctx.owner.correlation(request.taskId),
    reason: `start indeterminate: ${ctx.trace.redact(detail)}`,
  });
  return { kind: 'indeterminate', inFlight: start.status === 'timeout' ? (calls[0] ?? null) : null };
}

/**
 * The run ended (storage failure) while a start was in flight: the started
 * run, or any run a bounded lookup without the aborted signal finds for the
 * intent, is stopped without the state; the lease is freed when confirmed.
 */
async function settleAborted(ctx: RunContext, intent: StartIntent, runId: string | null, lease: Lease): Promise<void> {
  let runIds: readonly string[] = runId === null ? [] : [runId];
  if (runId === null) {
    const lookup = await withDeadline({
      call: () => ctx.ports.executor.findRuns({ playbook: intent.playbook, tree: intent.tree, notBefore: intent.at }),
      deadlineMs: EXECUTOR_CALL_DEADLINE_MS,
      sleep: ctx.ports.sleep,
    });
    runIds = lookup.status === 'done' ? lookup.value.map((info) => info.runId) : [];
  }
  if (runIds.length === 0) {
    ctx.slots.release(lease);
    return;
  }
  for (const [index, id] of runIds.entries()) {
    await stopQuietly(ctx, id, 'storage', { taskId: intent.taskId, executorRunId: id }, index === 0 ? lease : undefined);
  }
}

/** Registers a started run; when the registration fails before the run is recorded, the run is stopped before the error propagates. */
async function registerOrStop(
  ctx: RunContext,
  request: DispatchRequest,
  intent: StartIntent,
  started: { readonly runId: string; readonly supervisorToken?: string },
  lease: Lease,
): Promise<ExecutorRunRef> {
  try {
    return await register(ctx, request, intent, started, lease);
  } catch (error) {
    // A run the state already holds is stopped with every other live run; only an unrecorded one is stopped here.
    if (!(started.runId in ctx.owner.state.runs)) {
      await stopQuietly(ctx, started.runId, 'storage', { taskId: intent.taskId, executorRunId: started.runId }, lease);
    }
    throw error;
  }
}

/** The task's tree; a workspace failure frees the lease before it propagates. */
async function taskTreeOrRelease(ctx: RunContext, taskId: string, revision: number, lease: Lease): Promise<{ readonly tree: string }> {
  try {
    return await ctx.ports.workspace.taskTree(ctx.owner.state.spec.name, taskId, revision);
  } catch (error) {
    ctx.slots.release(lease);
    throw error;
  }
}

/** Saves the mapping of a started run (clearing its intent), then traces the start. */
async function register(
  ctx: RunContext,
  request: DispatchRequest,
  intent: StartIntent,
  started: { readonly runId: string; readonly supervisorToken?: string },
  lease: Lease,
): Promise<ExecutorRunRef> {
  if (started.supervisorToken !== undefined) {
    ctx.trace.addSecret(started.supervisorToken);
  }
  const ref: ExecutorRunRef = {
    executorRunId: started.runId,
    taskId: request.taskId,
    revision: intent.revision,
    attempt: intent.attempt,
    dispatchKey: intent.dispatchKey,
    playbook: intent.playbook,
    tree: intent.tree,
    role: request.role,
    ...(started.supervisorToken === undefined ? {} : { supervisorToken: started.supervisorToken }),
    cursor: 0,
    lastEventAt: ctx.trace.now(),
    state: 'live',
  };
  ctx.leases.set(ref.executorRunId, lease);
  await ctx.owner.update((state) => {
    state.intents = state.intents.filter((candidate) => !(candidate.kind === 'start' && candidate.dispatchKey === intent.dispatchKey));
    state.runs[ref.executorRunId] = ref;
  });
  ctx.trace.emit({
    type: 'executor_started',
    taskId: ref.taskId,
    revision: ref.revision,
    attempt: ref.attempt,
    executorRunId: ref.executorRunId,
    dispatchKey: ref.dispatchKey,
    playbook: ref.playbook,
    tree: ref.tree,
    role: ref.role,
  });
  recordHistory(ctx, request.taskId, 'dispatched', `${request.role} run ${ref.executorRunId} started in ${ref.tree}`);
  return ref;
}

/** A start the executor refused by policy: no lookup, no recovery, the task fails. */
async function refuse(ctx: RunContext, intent: StartIntent, policy: string, detail: string, lease: Lease): Promise<void> {
  ctx.slots.release(lease);
  await ctx.owner.removeIntents((candidate) => candidate.kind === 'start' && candidate.dispatchKey === intent.dispatchKey);
  const reason = `executor_refused: ${policy}`;
  ctx.trace.emit({ type: 'executor_failure', ...ctx.owner.correlation(intent.taskId), reason: ctx.trace.redact(`${reason}: ${detail}`) });
  recordHistory(ctx, intent.taskId, 'executor_failure', `${reason}: ${detail}`);
  await ctx.owner.fail(intent.taskId, `executor_refused: ${policy}`);
}

/**
 * Settles an indeterminate start. Returns the lease the replacement dispatch
 * runs under, or null when the task ended: an orphan whose stop was not
 * confirmed, a lost start of a repair or integrate run (its replacement
 * would start in a fresh tree without the task's code, so the task fails
 * with `start_lost`), or the cutoff or a re-plan during the settling (a
 * start still in flight is settled and its run stopped, then the tree is
 * abandoned, the start intent goes and the lease is freed). The
 * replacement is always a new revision, so it gets a new key and a new
 * tree; the attempt stays the same.
 */
async function settleIndeterminate(
  ctx: RunContext,
  request: DispatchRequest,
  intent: StartIntent,
  inFlight: Promise<StartRunResult> | null,
  lease: Lease,
): Promise<Lease | null> {
  const signal = taskSignal(ctx, intent.taskId);
  const found = await lookUpWithinWindow(ctx, intent, lease, signal);
  if (found === 'halted') {
    await settleHaltedStart(ctx, intent, inFlight, lease);
    return null;
  }
  if (found === null) {
    if (request.role !== 'task') {
      ctx.slots.release(lease);
      await ctx.owner.fail(intent.taskId, LOST_START_REASON, (state) => {
        abandonTree(state, intent);
      });
      return null;
    }
    // One save: the tree is abandoned and the task moves to a new revision; the start intent stays until the replacement's replaces it.
    await ctx.owner.update((state) => {
      state.abandonedTrees.push({ playbook: intent.playbook, tree: intent.tree, at: intent.at });
      const task = state.tasks[intent.taskId];
      if (task !== undefined && task.revision === intent.revision) {
        task.revision += 1;
      }
    });
    return lease;
  }
  const orphan = await registerOrStop(ctx, request, intent, { runId: found.runId }, lease);
  ctx.trace.emit({
    type: 'orphan_found',
    ...ctx.owner.correlation(intent.taskId),
    executorRunId: found.runId,
    detail: `run of the lost start found in ${intent.tree} with status ${found.status}`,
  });
  const confirmed = await stopRun(
    ctx,
    orphan,
    'orphan',
    request.role === 'task'
      ? {
          do: 'dispatch_replacement',
          taskId: intent.taskId,
          revision: intent.revision + 1,
          attempt: intent.attempt,
          request: requestRecord(request),
        }
      : { do: 'mark_failed', taskId: intent.taskId, reason: LOST_START_REASON },
  );
  if (!confirmed) {
    await ctx.owner.fail(intent.taskId, 'orphan_unconfirmed');
    return null;
  }
  if (request.role !== 'task') {
    await ctx.owner.fail(intent.taskId, LOST_START_REASON);
    return null;
  }
  if (halted(ctx, intent.taskId)) {
    return null;
  }
  await moveToRevision(ctx, intent.taskId, intent.revision + 1);
  return ctx.slots.acquire(signal);
}

/** The fail reason of a repair or integrate run whose start was lost: it cannot be replaced in a fresh tree. */
const LOST_START_REASON = 'start_lost';

/**
 * Looks the run up by playbook, tree and intent time until it is found or
 * the settle window has passed; `halted` when the cutoff or a re-plan ends
 * the wait first (the run's own abort settles the start and propagates).
 */
async function lookUpWithinWindow(
  ctx: RunContext,
  intent: StartIntent,
  lease: Lease,
  signal: AbortSignal,
): Promise<ExecutorRunInfo | null | 'halted'> {
  const windowEndMs = Date.parse(intent.at) + EXECUTOR_SETTLE_WINDOW_MS;
  for (;;) {
    const lookup = await withDeadline({
      call: () => ctx.ports.executor.findRuns({ playbook: intent.playbook, tree: intent.tree, notBefore: intent.at }),
      deadlineMs: EXECUTOR_CALL_DEADLINE_MS,
      sleep: ctx.ports.sleep,
      signal,
    });
    if (ctx.signal.aborted) {
      await settleAborted(ctx, intent, null, lease);
      ctx.signal.throwIfAborted();
    }
    const first = lookup.status === 'done' ? lookup.value[0] : undefined;
    if (first !== undefined) {
      return first;
    }
    if (halted(ctx, intent.taskId)) {
      return 'halted';
    }
    const leftMs = windowEndMs - ctx.trace.nowMs();
    if (leftMs <= 0) {
      return null;
    }
    try {
      await ctx.ports.sleep(Math.min(EXECUTOR_LOOKUP_INTERVAL_MS, leftMs), signal);
    } catch (error) {
      if (!ctx.signal.aborted && halted(ctx, intent.taskId)) {
        return 'halted';
      }
      await settleAborted(ctx, intent, null, lease);
      throw error;
    }
  }
}

/**
 * Moves the task to the revision (a new tree and key), keeping its attempts;
 * idempotent, so a continuation repeated on resume moves it once.
 */
export async function moveToRevision(ctx: RunContext, taskId: string, revision: number): Promise<void> {
  await ctx.owner.update((state) => {
    const task = state.tasks[taskId];
    if (task !== undefined && task.revision < revision) {
      task.revision = revision;
    }
  });
}
