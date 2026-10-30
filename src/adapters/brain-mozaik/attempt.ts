/**
 * One brain attempt: an absolute deadline fixed at bind time, a cancellation
 * flag, the record of every model call it made (provider, model, elapsed
 * time, usage; a failed or abandoned call is recorded with unavailable
 * usage) and an optional failure callback through which the runner settles
 * the attempt's owner at once. The runner owns the transitions; callers
 * read, cancel and abandon.
 *
 * Invariants: once cancelled, an attempt stays cancelled; every call that
 * was started is recorded exactly once.
 */

import type { BrainError } from './errors';
import type { Usage } from './response';

/** One model call of an attempt; `failure` names why a call without usage failed. */
export interface CallRecord {
  readonly provider: string;
  readonly model: string;
  /** When the call ended (or was abandoned), epoch milliseconds. */
  readonly endedAtMs: number;
  readonly elapsedMs: number;
  readonly usage: Usage;
  readonly failure?: string;
  /** The model the provider's answer named, when it named one. */
  readonly reportedModel?: string;
}

/** Called by the runner with the first failure of an attempt bound for a loop. */
export type AttemptFailureHandler = (error: BrainError) => void;

interface OpenCall {
  readonly provider: string;
  readonly model: string;
  readonly startedMs: number;
}

/** A bounded, cancellable unit of brain work that every inference call belongs to. */
export class Attempt {
  /** The attempt's budget in milliseconds. */
  readonly deadlineMs: number;
  /** Absolute end of the attempt, epoch milliseconds. */
  readonly expiresAtMs: number;
  /** Set when a decision loop owns the attempt: the runner then settles failures here instead of throwing. */
  readonly onFailure: AttemptFailureHandler | undefined;
  readonly #calls: CallRecord[] = [];
  readonly #open = new Map<number, OpenCall>();
  #nextTicket = 0;
  #cancelled = false;

  constructor(deadlineMs: number, boundAtMs: number, onFailure?: AttemptFailureHandler) {
    this.deadlineMs = deadlineMs;
    this.expiresAtMs = boundAtMs + deadlineMs;
    this.onFailure = onFailure;
  }

  /** Marks the attempt cancelled: its next inference is refused without a provider call. */
  cancel(): void {
    this.#cancelled = true;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  /** Every call so far, oldest first by completion. */
  get calls(): readonly CallRecord[] {
    return this.#calls;
  }

  /** Milliseconds left before the deadline at `nowMs` (zero or negative once it passed). */
  timeLeftMs(nowMs: number): number {
    return this.expiresAtMs - nowMs;
  }

  /** Opens a call to a provider; the returned ticket closes it once. */
  start(provider: string, model: string, nowMs: number): number {
    const ticket = this.#nextTicket++;
    this.#open.set(ticket, { provider, model, startedMs: nowMs });
    return ticket;
  }

  /** Closes a call with its usage and the model its answer named; a ticket already closed (abandoned) is ignored. */
  finish(ticket: number, usage: Usage, nowMs: number, reportedModel?: string): void {
    this.#close(ticket, nowMs, usage, undefined, reportedModel);
  }

  /** Closes a call that failed: unavailable usage, the failure named. */
  fail(ticket: number, failure: string, nowMs: number): void {
    this.#close(ticket, nowMs, { kind: 'unavailable', reason: 'call_failed' }, failure);
  }

  /** Closes every open call as abandoned: the owner stopped waiting, its usage is unknown. */
  abandon(nowMs: number, failure: string): void {
    for (const ticket of this.#open.keys()) this.#close(ticket, nowMs, { kind: 'unavailable', reason: 'abandoned' }, failure);
  }

  #close(ticket: number, nowMs: number, usage: Usage, failure?: string, reportedModel?: string): void {
    const open = this.#open.get(ticket);
    if (open === undefined) return;
    this.#open.delete(ticket);
    this.#calls.push({
      provider: open.provider,
      model: open.model,
      endedAtMs: nowMs,
      elapsedMs: nowMs - open.startedMs,
      usage,
      ...(failure === undefined ? {} : { failure }),
      ...(reportedModel === undefined ? {} : { reportedModel }),
    });
  }
}
