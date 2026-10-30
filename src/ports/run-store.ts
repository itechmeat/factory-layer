/**
 * The RunStore port: the persisted run state the application writes on
 * every change, so a restart can resume exactly where the process stopped.
 * Adapters write atomically (temp file plus rename).
 */

import type { RunState } from '../domain/run-state';

/**
 * Typed storage failure; a missing run is not one (load resolves null).
 * The cause, when known, is preserved on the error's `cause`.
 */
export class StorageError extends Error {
  constructor(info: { detail: string; cause?: unknown }) {
    super(info.detail, { cause: info.cause });
    this.name = 'StorageError';
  }
}

/**
 * The persisted state of one factory run. Every method is bounded by the
 * caller's deadline in milliseconds and the implementation resolves or
 * rejects within it, never hanging. Failures reject with StorageError;
 * they never hang and never report a failure as a string.
 */
export interface RunStore {
  /**
   * Persists the full run state. Deadline: bounded by the caller
   * (milliseconds). Failure: rejects with StorageError when the state
   * cannot be saved; the application treats that as fatal for the run;
   * never hangs.
   */
  save(state: RunState): Promise<void>;

  /**
   * Loads the stored state of a run. Deadline: bounded by the caller
   * (milliseconds). Failure: resolves null when the run has no stored
   * state (not an error); rejects with StorageError when reading fails;
   * never hangs.
   */
  load(runId: string): Promise<RunState | null>;

  /**
   * Records a human intervention from outside the running process, with
   * its instant. Deadline: bounded by the caller (milliseconds). Failure:
   * rejects with StorageError when it cannot be recorded; never hangs.
   */
  appendIntervention(runId: string, note: string): Promise<{ readonly at: string; readonly note: string }>;
}
