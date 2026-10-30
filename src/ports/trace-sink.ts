/**
 * The TraceSink port: where the run's trace events go. Emitting is
 * synchronous and best-effort; the trace is never allowed to slow the run
 * down or break it.
 */

import type { TraceEvent } from '../domain/trace-event';

/**
 * Receives one trace event. Deadline: none; the sink must return promptly
 * and never block, so the caller does not wait on it. Failure: the method
 * cannot fail the caller; a sink that cannot persist surfaces that through
 * the storage-failure path of its own adapter (traced as 'storage_failed'
 * when the trace still accepts events) instead of throwing. Never hangs.
 */
export interface TraceSink {
  emit(event: TraceEvent): void;
}
