import { describe, expect, test } from 'bun:test';

import type { TraceEvent } from '../domain';
import type { Sleep } from '../ports';

import { REPLAY_MAX_GAP_MS, replay } from './replay';
import { FakeClock, FakeSink, fakeSleep } from './testing';

/** The epoch millisecond the fake clock starts at. */
const START_MS = Date.parse('2026-01-01T00:00:00.000Z');

/** One recorded trace event at the offset from the clock start, the simplest recorded variant. */
function eventAt(offsetMs: number): TraceEvent {
  return { type: 'cutoff_reached', at: new Date(START_MS + offsetMs).toISOString(), runId: 'run-1' };
}

/** Drains pending microtasks; nothing ever really waits. */
async function settleMicrotasks(): Promise<void> {
  for (let round = 0; round < 25; round += 1) {
    await Promise.resolve();
  }
}

/** What one replay run did: its result, the waits it asked for and the fake time it took. */
interface ReplayRun {
  readonly result: { readonly emitted: number };
  readonly sleeps: readonly number[];
  readonly elapsedMs: number;
}

/** The sentinel that wins the race while the replay promise is still pending. */
const STILL_RUNNING = 'still running';

/** Reports whether the promise has settled, checked against a sentinel race. */
async function hasSettled(pending: Promise<{ readonly emitted: number }>): Promise<boolean> {
  return (await Promise.race([pending, STILL_RUNNING])) !== STILL_RUNNING;
}

/**
 * Runs a replay on the fake clock, advancing it 1 ms at a time (an initial
 * advance by 0 fires zero-delay waits) until the replay settles, recording
 * every wait it asked the injected sleep for.
 */
async function runReplay(info: {
  events: readonly TraceEvent[];
  speedFactor: number;
  sink: FakeSink;
  clock: FakeClock;
}): Promise<ReplayRun> {
  const sleeps: number[] = [];
  const base = fakeSleep(info.clock);
  const sleep: Sleep = (ms, signal) => {
    sleeps.push(ms);
    return base(ms, signal);
  };
  const startedAtMs = info.clock.now().getTime();
  const pending = replay({ events: info.events, speedFactor: info.speedFactor, sink: info.sink, sleep });
  let settled = await hasSettled(pending);
  for (let step = 0; step < 200_000 && !settled; step += 1) {
    info.clock.advanceMs(step === 0 ? 0 : 1);
    await settleMicrotasks();
    settled = await hasSettled(pending);
  }
  if (!settled) {
    throw new Error('replay did not settle within the fake time budget');
  }
  return { result: await pending, sleeps, elapsedMs: info.clock.now().getTime() - startedAtMs };
}

describe('replay', () => {
  test('replays a 60 s trace at speed 60 in about 1 s, in the recorded order', async () => {
    const clock = new FakeClock();
    const sink = new FakeSink();
    const trace = [0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000].map((offsetMs) => eventAt(offsetMs));

    const run = await runReplay({ events: trace, speedFactor: 60, sink, clock });

    expect(run.result).toEqual({ emitted: 7 });
    expect(run.elapsedMs).toBeGreaterThanOrEqual(900);
    expect(run.elapsedMs).toBeLessThanOrEqual(1100);
    expect(sink.events).toEqual(trace);
  });

  test('caps one scaled wait at REPLAY_MAX_GAP_MS', async () => {
    const clock = new FakeClock();
    const sink = new FakeSink();
    const trace = [eventAt(0), eventAt(600_000)];

    const run = await runReplay({ events: trace, speedFactor: 1, sink, clock });

    expect(run.result).toEqual({ emitted: 2 });
    expect(run.sleeps).toEqual([REPLAY_MAX_GAP_MS]);
    expect(run.elapsedMs).toBe(REPLAY_MAX_GAP_MS);
    expect(sink.events).toEqual(trace);
  });
});
