/**
 * The ExecutionSlots port: the process-wide cap on live executor runs all
 * factory runs share. One instance per process enforces
 * GLOBAL_EXECUTOR_RUNS; each run enforces its own per-run cap itself.
 */

/** A held slot; release it with the same object. */
export interface Slot {
  readonly runId: string;
}

/**
 * The shared cap on live executor runs. Deadline: acquire waits while the
 * cap is full, bounded by the caller's signal (not a millisecond
 * deadline); it never waits once the signal has aborted. Failure: rejects
 * with an Error naming the run and the abort when the signal aborts
 * before a slot frees; never hangs. release is synchronous and infallible.
 */
export interface ExecutionSlots {
  /**
   * Waits for a free slot and returns it. Deadline: bounded by the
   * caller's signal. Failure: rejects with an Error when the signal
   * aborts before a slot frees; never hangs.
   */
  acquire(runId: string, signal: AbortSignal): Promise<Slot>;

  /** Frees the slot immediately; synchronous, never throws. */
  release(slot: Slot): void;
}
