/**
 * The Memory port: what the factory recalls of past runs before it plans
 * and what it remembers of a finished run. A memory failure is traced and
 * never changes the run's outcome.
 */

import type { RunOutcome } from '../domain/run-state';
import type { Spec } from '../domain/spec';

/** One past run as recall presents it to the brain. */
export interface RecalledRun {
  readonly specName: string;
  readonly outcome: RunOutcome;
  readonly summary: string; // plan summary
  readonly at: string; // ISO instant
}

/** One finished run as the factory remembers it. */
export interface RunOutcomeRecord {
  readonly runId: string;
  readonly specName: string;
  readonly outcome: RunOutcome;
  readonly planSummary: string;
  readonly tasks: readonly {
    readonly taskId: string;
    readonly revision: number;
    readonly integrated: boolean;
    readonly attempts: number;
  }[];
  readonly failedCheckIds: readonly string[];
  readonly durationMs: number;
}

/** Typed memory failure; the caller traces it and carries on. */
export class MemoryError extends Error {
  readonly reason: 'failed' | 'timeout' | 'cancelled';

  constructor(info: { reason: 'failed' | 'timeout' | 'cancelled'; detail: string }) {
    super(info.detail);
    this.name = 'MemoryError';
    this.reason = info.reason;
  }
}

/**
 * The long-term memory of past runs (OSB). Every method is bounded by the
 * caller at MEMORY_DEADLINE_MS (milliseconds); the port itself never waits
 * unbounded. Failures reject with MemoryError ('failed', 'timeout' or
 * 'cancelled'); they never hang and never report a failure as a string. An
 * aborted signal ends the call with reason 'cancelled'.
 */
export interface Memory {
  /**
   * Recalls past runs similar to the spec, at most `limit` of them.
   * Deadline: bounded by the caller at MEMORY_DEADLINE_MS (milliseconds);
   * the signal aborts early. Failure: rejects with MemoryError; the caller
   * traces the failure and continues with no recall; never hangs.
   */
  recall(spec: Spec, limit: number, signal: AbortSignal): Promise<readonly RecalledRun[]>;

  /**
   * Records the outcome of a finished run. Deadline: bounded by the caller
   * at MEMORY_DEADLINE_MS (milliseconds); the signal aborts early.
   * Failure: rejects with MemoryError; the caller traces the failure and
   * the run still ends with its outcome; never hangs.
   */
  remember(outcome: RunOutcomeRecord, signal: AbortSignal): Promise<void>;
}
