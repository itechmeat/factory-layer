/**
 * Reading a run's trace file back and naming its location: the run
 * directory layout, the safe run-id guard, and the validated read-back
 * that reports every unparseable line with its line number. Invariant: a
 * line that does not parse into a TraceEvent is never dropped silently.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TraceEventSchema } from '../../domain/trace-event';
import type { TraceEvent } from '../../domain/trace-event';
import { StorageError } from '../../ports/run-store';

/** The name of the JSONL trace file inside a run directory. */
export const TRACE_FILE_NAME = 'trace.jsonl';

/**
 * A run id becomes a directory name under `runs/`, so it must be one safe
 * path segment: no separators, no traversal, no leading dot or dash.
 */
export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** One trace line that did not parse into a TraceEvent. */
export interface InvalidTraceLine {
  readonly line: number;
  readonly detail: string;
}

/** The validated read-back of a trace file. */
export interface TraceRead {
  readonly events: readonly TraceEvent[];
  readonly invalid: readonly InvalidTraceLine[];
}

/** True when a caught value is a Node file-system error with this code. */
export function hasErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === code;
}

/**
 * Guards the run ids that become directory names. Failure: throws
 * StorageError naming the offending id, since the run cannot be addressed.
 */
export function assertSafeRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new StorageError({ detail: `the run id is not a safe directory name: ${JSON.stringify(runId)}` });
  }
}

/** The directory of one run: `<runsDir>/runs/<runId>`. */
export function runDir(runsDir: string, runId: string): string {
  assertSafeRunId(runId);
  return join(runsDir, 'runs', runId);
}

/**
 * Reads a run's trace.jsonl back into validated events, in file order. A
 * line that is not valid JSON or not a valid TraceEvent is reported in
 * `invalid` with its 1-based line number and the failure detail, never
 * skipped silently. A run without a trace file yet reads as empty; any
 * other read failure is a StorageError.
 */
export function readTrace(runDirectory: string): TraceRead {
  const file = join(runDirectory, TRACE_FILE_NAME);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT')) return { events: [], invalid: [] };
    throw new StorageError({ detail: `cannot read the trace at ${file}`, cause });
  }
  const events: TraceEvent[] = [];
  const invalid: InvalidTraceLine[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (cause) {
      invalid.push({ line: index + 1, detail: cause instanceof Error ? cause.message : String(cause) });
      continue;
    }
    const parsed = TraceEventSchema.safeParse(value);
    if (parsed.success) events.push(parsed.data);
    else invalid.push({ line: index + 1, detail: parsed.error.message });
  }
  return { events, invalid };
}
