/**
 * The decision-level vocabulary of the Mozaik brain: the roles, one decision
 * request (role, prompts, answer schema, deadline, signal), its result (the
 * typed value and the usage records it incurred) and its typed failure.
 * These mirror the `Brain` port shapes so a thin wrapper can implement the
 * port: every usage record names the role, a failure carries the usage
 * already recorded.
 */

import type { z } from 'zod';

import type { Usage } from './response';

/** The agents of the brain, one per kind of judgement. */
export type BrainRole = 'architect' | 'acceptance_analyst' | 'critic';

export const BRAIN_ROLES: readonly BrainRole[] = ['architect', 'acceptance_analyst', 'critic'];

/** The name of the per-attempt tool through which the model submits its answer. */
export const SUBMIT_TOOL_NAME = 'submit';

/** Most inference steps one attempt may take before it fails with `step_limit`. */
export const DECISION_STEP_CAP = 12;

/** One decision: who decides, with which instructions, and the shape of the answer. */
export interface DecisionRequest<T> {
  readonly role: BrainRole;
  /** The role's system prompt. */
  readonly system: string;
  /** The material to decide on (spec text, plan, report). */
  readonly user: string;
  /** The submit tool's argument schema: the answer is the first submission that passes it. */
  readonly schema: z.ZodType<T>;
  /** The attempt's budget in milliseconds. */
  readonly deadlineMs: number;
  /** Aborting it cancels the attempt at once. */
  readonly signal?: AbortSignal;
}

/** One model call of a decision, attributed to its role. */
export interface BrainUsageRecord {
  /** When the call ended, ISO 8601. */
  readonly at: string;
  readonly role: BrainRole;
  readonly provider: string;
  readonly model: string;
  readonly elapsedMs: number;
  readonly usage: Usage;
  /** Why the call failed or was abandoned; absent for a call that answered. */
  readonly failure?: string;
  /** The model the provider's answer named; absent when it named none or the call failed. */
  readonly reportedModel?: string;
}

/** A decision's answer and the usage it incurred. */
export interface DecisionResult<T> {
  readonly value: T;
  readonly usage: readonly BrainUsageRecord[];
}

/**
 * Why a decision failed: no valid submission before the loop ended, the
 * step cap, the deadline, the signal, or a failed model call.
 */
export type DecisionFailure = 'no_submission' | 'step_limit' | 'timeout' | 'cancelled' | 'failed';

interface DecisionErrorInfo {
  readonly reason: DecisionFailure;
  readonly role: BrainRole;
  readonly detail: string;
  readonly retryable: boolean;
  readonly usage: readonly BrainUsageRecord[];
  readonly cause?: Error;
}

/** A failed decision: a value the caller records, with the usage already incurred. */
export class DecisionError extends Error {
  readonly reason: DecisionFailure;
  readonly role: BrainRole;
  readonly retryable: boolean;
  readonly usage: readonly BrainUsageRecord[];

  constructor(info: DecisionErrorInfo) {
    super(`${info.role} decision ${info.reason}: ${info.detail}`, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'DecisionError';
    this.reason = info.reason;
    this.role = info.role;
    this.retryable = info.retryable;
    this.usage = info.usage;
  }
}
