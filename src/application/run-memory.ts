/**
 * The run's long-term memory calls, each bounded by MEMORY_DEADLINE_MS:
 * recalling similar past runs before planning and remembering the outcome
 * at the end (task 3.11). A memory failure is traced as `memory_failed`
 * and never changes the run: recall continues with nothing recalled, and
 * the run keeps its outcome.
 */

import { MEMORY_DEADLINE_MS, MEMORY_RECALL_LIMIT, type Spec } from '../domain';
import type { Memory, RecalledRun, RunOutcomeRecord, Sleep } from '../ports';

import { boundedDetail, withDeadline } from './deadline';
import type { RunTrace } from './run-trace';

/** Recalls at most MEMORY_RECALL_LIMIT past runs like the spec; nothing on a failure or timeout. */
export async function recallPastRuns(info: {
  readonly memory: Memory;
  readonly sleep: Sleep;
  readonly trace: RunTrace;
  readonly spec: Spec;
  readonly signal: AbortSignal;
}): Promise<readonly RecalledRun[]> {
  const recalled = await withDeadline({
    call: (signal) => info.memory.recall(info.spec, MEMORY_RECALL_LIMIT, signal),
    deadlineMs: MEMORY_DEADLINE_MS,
    sleep: info.sleep,
    signal: info.signal,
  });
  if (recalled.status === 'done') {
    return recalled.value;
  }
  info.trace.emit({ type: 'memory_failed', phase: 'recall', reason: info.trace.redact(boundedDetail(recalled)) });
  return [];
}

/** Remembers the run's outcome; a failure or timeout is traced and changes nothing else. */
export async function rememberOutcome(info: {
  readonly memory: Memory;
  readonly sleep: Sleep;
  readonly trace: RunTrace;
  readonly record: RunOutcomeRecord;
}): Promise<void> {
  const remembered = await withDeadline({
    call: (signal) => info.memory.remember(info.record, signal),
    deadlineMs: MEMORY_DEADLINE_MS,
    sleep: info.sleep,
  });
  if (remembered.status !== 'done') {
    info.trace.emit({ type: 'memory_failed', phase: 'remember', reason: info.trace.redact(boundedDetail(remembered)) });
  }
}
