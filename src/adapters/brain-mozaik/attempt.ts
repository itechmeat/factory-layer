/**
 * One brain attempt: an absolute deadline fixed at bind time, a cancellation
 * flag and the record of its successful calls (provider, model, elapsed
 * time, usage). The runner owns the transitions; callers read and cancel.
 *
 * Invariant: once cancelled, an attempt stays cancelled.
 */

import type { Usage } from './response';

/** One successful model call of an attempt. */
export interface CallRecord {
  readonly provider: string;
  readonly model: string;
  readonly elapsedMs: number;
  readonly usage: Usage;
}

/** A bounded, cancellable unit of brain work that every inference call belongs to. */
export class Attempt {
  /** The attempt's budget in milliseconds. */
  readonly deadlineMs: number;
  /** Absolute end of the attempt, epoch milliseconds. */
  readonly expiresAtMs: number;
  readonly #calls: CallRecord[] = [];
  #cancelled = false;

  constructor(deadlineMs: number, boundAtMs: number) {
    this.deadlineMs = deadlineMs;
    this.expiresAtMs = boundAtMs + deadlineMs;
  }

  /** Marks the attempt cancelled: its next inference is refused without a provider call. */
  cancel(): void {
    this.#cancelled = true;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  /** The successful calls so far, oldest first. */
  get calls(): readonly CallRecord[] {
    return this.#calls;
  }

  /** Milliseconds left before the deadline at `nowMs` (zero or negative once it passed). */
  timeLeftMs(nowMs: number): number {
    return this.expiresAtMs - nowMs;
  }

  record(call: CallRecord): void {
    this.#calls.push(call);
  }
}
