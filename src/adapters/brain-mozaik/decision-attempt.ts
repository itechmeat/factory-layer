/**
 * One decision attempt as one Mozaik loop: a fresh context with the role's
 * system prompt, bound to the guarded runner with the attempt deadline and a
 * failure handler; a per-attempt submit tool whose arguments are validated
 * with the decision's schema (an invalid submission goes back to the model
 * as the validation error); and an interception handler that ends the loop
 * right after a valid submission, enforces the step cap and notices a loop
 * that ends without a submission. A timer bounds the attempt by its deadline
 * and an aborted signal cancels it.
 *
 * Invariant: the returned promise settles exactly once, at the first of
 * submission, failure, deadline or abort; after that no further inference
 * of the attempt reaches a provider.
 */

import {
  ModelContext,
  ModelMessageItem,
  SystemMessageItem,
  type ExecutableTransition,
  type InferenceInput,
  type InterceptionHandler,
} from '@mozaik-ai/core';

import type { Clock } from '../../ports/index';
import type { Attempt, CallRecord } from './attempt';
import { DecisionError, SUBMIT_TOOL_NAME, type DecisionFailure, type DecisionRequest, type DecisionResult } from './decision';
import type { BrainError } from './errors';
import type { GuardedInferenceRunner } from './runner';
import { toFunctionTool } from './tools';

/** Starts a Mozaik loop; `runLoop` of the runtime, which returns before the loop ends. */
export type LoopStarter = (agentId: string, message: string, input: InferenceInput, handler: InterceptionHandler) => void;

/** What an attempt needs from the decider. */
export interface AttemptDeps {
  readonly runner: GuardedInferenceRunner;
  readonly runLoop: LoopStarter;
  readonly agentId: string;
  readonly clock: Clock;
  readonly stepCap: number;
  /** Told about every runner error settled on this attempt, so the process guard can ignore it. */
  readonly attributed: (error: BrainError) => void;
}

/** The transition that ends a loop with a final model message instead of the next inference. */
function endLoop(text: string): ExecutableTransition {
  return { nextStateId: 'model_message', input: { answer: ModelMessageItem.rehydrate({ text }) } };
}

function reasonOf(error: BrainError): DecisionFailure {
  if (error.kind === 'timeout' || error.kind === 'cancelled') return error.kind;
  return 'failed';
}

/** Runs one decision attempt; resolves with the first valid submission or rejects with `DecisionError`. */
export async function runDecisionAttempt<T>(deps: AttemptDeps, request: DecisionRequest<T>): Promise<DecisionResult<T>> {
  const { role, signal } = request;
  if (signal?.aborted) {
    throw new DecisionError({
      reason: 'cancelled',
      role,
      detail: 'the signal was aborted before the attempt started',
      retryable: false,
      usage: [],
    });
  }
  const { promise, resolve, reject } = Promise.withResolvers<DecisionResult<T>>();
  const context = ModelContext.create().addContextItem(SystemMessageItem.create(request.system));
  let attempt: Attempt | undefined;
  let settled = false;
  let steps = 0;

  const usage = (calls: readonly CallRecord[]): DecisionResult<T>['usage'] =>
    calls.map(({ endedAtMs, ...call }) => ({ at: new Date(endedAtMs).toISOString(), role, ...call }));
  const finish = (): readonly CallRecord[] => {
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    return attempt?.calls ?? [];
  };
  const fail = (reason: DecisionFailure, detail: string, retryable: boolean, cause?: Error): void => {
    if (settled) return;
    attempt?.cancel();
    attempt?.abandon(deps.clock.now().getTime(), reason);
    const calls = finish();
    reject(new DecisionError({ reason, role, detail, retryable, usage: usage(calls), ...(cause === undefined ? {} : { cause }) }));
  };
  const onAbort = (): void => fail('cancelled', 'the signal was aborted', false);
  const timer = setTimeout(() => fail('timeout', `no answer within ${String(request.deadlineMs)} ms`, true), request.deadlineMs);
  signal?.addEventListener('abort', onAbort, { once: true });

  attempt = deps.runner.bind(context, {
    deadlineMs: request.deadlineMs,
    onFailure: (error) => {
      deps.attributed(error);
      fail(reasonOf(error), error.message, error.retryable, error);
    },
  });

  const submit = toFunctionTool(
    {
      name: SUBMIT_TOOL_NAME,
      description: 'Submit your final answer. Call it exactly once, with every required field.',
      args: request.schema,
    },
    async (value) => {
      if (settled) return 'The decision is already closed.';
      resolve({ value, usage: usage(finish()) });
      return 'Accepted.';
    },
  );

  const intercept: InterceptionHandler = {
    isSatisfiedBy: (transition) => transition.nextStateId !== 'message_received' && transition.nextStateId !== 'function_call',
    handle: async (transition) => {
      if (transition.nextStateId === 'model_message') {
        fail('no_submission', `the model ended without calling ${SUBMIT_TOOL_NAME}`, true);
        return transition;
      }
      if (settled) return endLoop('The decision is closed.');
      steps += 1;
      if (steps > deps.stepCap) {
        fail('step_limit', `no valid submission within ${String(deps.stepCap)} inference steps`, true);
        return endLoop('The step limit was reached.');
      }
      return transition;
    },
  };

  try {
    deps.runLoop(deps.agentId, request.user, { model: deps.runner.chooseModel(), context, tools: [submit] }, intercept);
  } catch (error) {
    fail('failed', `the loop did not start: ${error instanceof Error ? error.message : String(error)}`, false);
  }
  return promise;
}
