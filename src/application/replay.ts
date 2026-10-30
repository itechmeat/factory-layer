/**
 * Trace replay: re-emits a recorded trace to a sink in the recorded order,
 * waiting between events so the relative timing holds, scaled by a speed
 * factor (2 means twice as fast). Each scaled wait is capped so one long
 * recorded gap can never stall a replay. Replay calls only the sink; the
 * events go out as recorded, because they were redacted at record time.
 */

import type { TraceEvent } from '../domain';
import type { Sleep, TraceSink } from '../ports';

/** The longest single wait of a replay, in milliseconds of real time. */
export const REPLAY_MAX_GAP_MS = 10_000;

/**
 * Replays the recorded events through the sink: the first event at once,
 * then each next one after `min(gap / speedFactor, REPLAY_MAX_GAP_MS)`, so
 * order and relative timing are preserved and scaled. A gap of zero or less
 * (equal timestamps) waits zero. Returns the number of events emitted.
 */
export async function replay(info: {
  events: readonly TraceEvent[];
  speedFactor: number;
  sink: TraceSink;
  sleep: Sleep;
}): Promise<{ emitted: number }> {
  const { events, speedFactor, sink, sleep } = info;
  const first = events[0];
  if (first === undefined) {
    return { emitted: 0 };
  }
  sink.emit(first);
  let previous = first;
  for (const next of events.slice(1)) {
    const gapMs = Math.max(Date.parse(next.at) - Date.parse(previous.at), 0);
    await sleep(Math.min(gapMs / speedFactor, REPLAY_MAX_GAP_MS));
    sink.emit(next);
    previous = next;
  }
  return { emitted: events.length };
}
