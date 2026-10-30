/**
 * A recovery command on a live run (task 3.6): `retry` appends the hint and
 * retries the failed node, `rebind` appends the hint, rebinds the node and
 * retries it. The logical recovery consumes one attempt when its command
 * intent is created; the intent holds the run, node, choice, hint, profile
 * and every step: `posting` is saved before a step is posted and its
 * sequence after, so a resume can tell which steps landed. A posted command
 * is accepted, not applied: the task goes back to waiting for the run's
 * events. A step the executor does not take, and on resume a step whose
 * posting is indeterminate (`posting` saved, no sequence), falls back,
 * within the same attempt, to stopping the run and a repair run with the
 * hint; a resume posts the steps not posted yet (task 3.12).
 */

import { EXECUTOR_CALL_DEADLINE_MS, type CommandStep, type ExecutorRunRef, type RecoveryChoice, type RunIntent } from '../domain';
import type { CommandPostResult } from '../ports';

import { boundedDetail, withDeadline } from './deadline';
import { requestRecord, type DispatchRequest } from './dispatch';
import type { RunContext } from './run-context';
import { dropConfirmedStops } from './run-owner';
import { finishStop, type StopIntent } from './stops';
import { followUpRequest } from './task-inputs';

/** Where a task goes after a recovery step: back to its live run, a new run, or nowhere (it ended). */
export type RecoveryNext =
  | { readonly kind: 'supervise'; readonly executorRunId: string }
  | { readonly kind: 'dispatch'; readonly request: DispatchRequest; readonly consumeAttempt: boolean }
  | { readonly kind: 'ended' };

type LiveChoice = Extract<RecoveryChoice, { choice: 'retry' | 'rebind' }>;

/** A command intent, as saved. */
export type CommandIntent = Extract<RunIntent, { kind: 'command' }>;

/** Saves the command intent (consuming the attempt) and posts its steps in order on the live run. */
export async function postCommand(ctx: RunContext, ref: ExecutorRunRef, choice: LiveChoice, nodeId: string): Promise<RecoveryNext> {
  const attempt = ctx.owner.task(ref.taskId).attemptsUsed + 1;
  const steps: CommandStep[] =
    choice.choice === 'rebind'
      ? [{ step: 'append_context' }, { step: 'rebind_node' }, { step: 'retry_node' }]
      : [{ step: 'append_context' }, { step: 'retry_node' }];
  const intent: CommandIntent = {
    kind: 'command',
    executorRunId: ref.executorRunId,
    taskId: ref.taskId,
    revision: ref.revision,
    attempt,
    choice: choice.choice,
    nodeId,
    hint: choice.hint,
    profile: choice.choice === 'rebind' ? choice.profile : null,
    steps,
  };
  await ctx.owner.update((state) => {
    const task = state.tasks[ref.taskId];
    if (task !== undefined) {
      task.attemptsUsed = attempt;
    }
    dropConfirmedStops(state, ref.taskId);
    state.intents.push(intent);
  });
  return postSteps(ctx, ref, intent);
}

/**
 * Reconciles a command intent found on resume: a step whose posting is
 * indeterminate is not posted again (stop and repair within the attempt);
 * otherwise the steps not posted yet are posted in order.
 */
export async function resumeCommand(ctx: RunContext, ref: ExecutorRunRef, intent: CommandIntent): Promise<RecoveryNext> {
  if (intent.steps.some((step) => step.posting === true && step.postedSeq === undefined)) {
    return fallBackToRepair(ctx, ref, intent);
  }
  return postSteps(ctx, ref, intent);
}

/** Posts every step without a sequence; see the module header. */
async function postSteps(ctx: RunContext, ref: ExecutorRunRef, intent: CommandIntent): Promise<RecoveryNext> {
  const { owner } = ctx;
  for (const [index, step] of intent.steps.entries()) {
    if (step.postedSeq !== undefined) {
      continue;
    }
    await markStep(ctx, intent, index, { posting: true });
    const posted = await withDeadline({
      call: () => postStep(ctx, intent, step.step),
      deadlineMs: EXECUTOR_CALL_DEADLINE_MS,
      sleep: ctx.ports.sleep,
      signal: ctx.signal,
    });
    const seq = posted.status === 'done' && posted.value.accepted ? posted.value.postedSeq : null;
    if (seq !== null) {
      await markStep(ctx, intent, index, { posting: false, postedSeq: seq });
    }
    ctx.trace.emit({
      type: 'recovery_command',
      ...owner.correlation(ref.taskId),
      executorRunId: ref.executorRunId,
      nodeId: intent.nodeId,
      step: step.step,
      accepted: seq !== null,
      detail: posted.status === 'done' ? `posted at ${seq ?? 'no sequence'}` : boundedDetail(posted),
    });
    if (seq === null) {
      return fallBackToRepair(ctx, ref, intent);
    }
  }
  const postedAt = ctx.trace.now();
  await owner.update((state) => {
    state.intents = state.intents.filter((candidate) => !isSameCommand(candidate, intent));
    const run = state.runs[ref.executorRunId];
    if (run !== undefined) {
      // The stall limit counts from the command: the decision that led to it is not the run's silence.
      state.runs[ref.executorRunId] = { ...run, lastEventAt: postedAt };
    }
  });
  if (owner.task(ref.taskId).state !== 'running') {
    await owner.transition(ref.taskId, 'running', `${intent.choice} of node ${intent.nodeId} posted`);
  }
  return { kind: 'supervise', executorRunId: ref.executorRunId };
}

function isSameCommand(candidate: RunIntent, intent: CommandIntent): boolean {
  return candidate.kind === 'command' && candidate.executorRunId === intent.executorRunId && candidate.attempt === intent.attempt;
}

/** Saves the step's fields in the command intent. */
async function markStep(ctx: RunContext, intent: CommandIntent, index: number, fields: Partial<CommandStep>): Promise<void> {
  await ctx.owner.update((state) => {
    const saved = state.intents.find((candidate) => isSameCommand(candidate, intent));
    if (saved?.kind === 'command') {
      saved.steps = saved.steps.map((candidate, at) => (at === index ? { ...candidate, ...fields } : candidate));
    }
  });
}

/** Posts one step through the executor. */
function postStep(ctx: RunContext, intent: CommandIntent, step: CommandStep['step']): Promise<CommandPostResult> {
  const { executor } = ctx.ports;
  if (step === 'append_context') {
    return executor.appendContext(intent.executorRunId, intent.hint ?? '');
  }
  if (step === 'rebind_node' && intent.profile !== null) {
    return executor.rebindProfile(intent.executorRunId, intent.nodeId, intent.profile);
  }
  return executor.retryNode(intent.executorRunId, intent.nodeId);
}

/**
 * A step that did not land (or whose posting is indeterminate): the command
 * intent is replaced by a stop intent in one save, the run is stopped, and
 * a repair run with the hint follows within the attempt the command consumed.
 */
async function fallBackToRepair(ctx: RunContext, ref: ExecutorRunRef, intent: CommandIntent): Promise<RecoveryNext> {
  const request = await followUpRequest(ctx, ref, ref.taskId, { hint: intent.hint, failingCheckIds: [] });
  const stop: StopIntent = {
    kind: 'stop',
    executorRunId: ref.executorRunId,
    taskId: ref.taskId,
    purpose: 'recovery',
    continuation: {
      do: 'start_repair',
      taskId: ref.taskId,
      revision: ref.revision,
      attempt: intent.attempt,
      request: requestRecord(request),
      consumesAttempt: false,
    },
    requestedAt: ctx.trace.now(),
    confirmed: false,
  };
  await ctx.owner.update((state) => {
    state.intents = state.intents.filter((candidate) => !isSameCommand(candidate, intent));
    state.intents.push(stop);
  });
  const confirmed = await finishStop(ctx, stop);
  if (!confirmed) {
    await ctx.owner.fail(ref.taskId, 'stop_unconfirmed');
    return { kind: 'ended' };
  }
  return { kind: 'dispatch', request, consumeAttempt: false };
}
