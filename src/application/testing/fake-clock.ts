/**
 * Deterministic time for tests: a `Clock` that only moves when the test
 * moves it and a `Sleep` that waits on fake timers, so advancing the clock
 * fires due waits in wake-time order (ties FIFO) and no test ever really
 * waits. Everything in `application/testing` runs on this clock.
 */

import type { Clock, Sleep } from '../../ports';

/** The instant every FakeClock starts at unless the test picks another. */
export const FAKE_CLOCK_START_ISO = '2026-01-01T00:00:00.000Z';

/** The abort reason a fake sleep rejects with when the signal carries none. */
const ABORT_DETAIL = 'sleep aborted';

/** One pending fake timer: when it wakes and what settles it. */
interface Sleeper {
  readonly wakeAtMs: number;
  readonly settle: () => void;
}

export class FakeClock implements Clock {
  private nowMs: number;
  private sleepers: Sleeper[] = [];

  constructor(startIso: string = FAKE_CLOCK_START_ISO) {
    this.nowMs = Date.parse(startIso);
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  /**
   * Moves time forward by `ms`, firing due sleepers at their wake times in
   * wake order (ties in registration order); `now` stands at each wake time
   * while it fires and ends at the target.
   */
  advanceMs(ms: number): void {
    this.moveTo(this.nowMs + ms);
  }

  /** The wake instant of the earliest pending sleeper in epoch milliseconds, or null when none waits. */
  nextWakeMs(): number | null {
    let earliest: number | null = null;
    for (const sleeper of this.sleepers) {
      if (earliest === null || sleeper.wakeAtMs < earliest) {
        earliest = sleeper.wakeAtMs;
      }
    }
    return earliest;
  }

  /** Moves time to the instant; a forward move fires the sleepers it passes. */
  setTo(iso: string): void {
    this.moveTo(Date.parse(iso));
  }

  /**
   * Registers a fake timer that wakes `ms` from now. Returns the cancel
   * function an aborted sleep calls to remove itself. Called by `fakeSleep`.
   */
  addSleep(ms: number, settle: () => void): () => void {
    const sleeper: Sleeper = { wakeAtMs: this.nowMs + ms, settle };
    this.sleepers.push(sleeper);
    return () => {
      this.sleepers = this.sleepers.filter((pending) => pending !== sleeper);
    };
  }

  private moveTo(targetMs: number): void {
    for (;;) {
      const due = this.dueSleeper(targetMs);
      if (due === undefined) {
        break;
      }
      if (due.wakeAtMs > this.nowMs) {
        this.nowMs = due.wakeAtMs;
      }
      due.settle();
    }
    this.nowMs = targetMs;
  }

  /** Removes and returns the sleeper with the smallest wake time at or before the target, first registered winning ties. */
  private dueSleeper(targetMs: number): Sleeper | undefined {
    let best: Sleeper | undefined;
    let bestIndex = -1;
    for (let index = 0; index < this.sleepers.length; index += 1) {
      const sleeper = this.sleepers[index];
      if (sleeper === undefined || sleeper.wakeAtMs > targetMs) {
        continue;
      }
      if (best === undefined || sleeper.wakeAtMs < best.wakeAtMs) {
        best = sleeper;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      this.sleepers.splice(bestIndex, 1);
    }
    return best;
  }
}

/** The abort reason as an Error, so rejections stay typed for the callers. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(ABORT_DETAIL);
}

/** A `Sleep` on the fake clock: concurrent waiters, deterministic, no real waiting. */
export function fakeSleep(clock: FakeClock): Sleep {
  return (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal === undefined) {
        clock.addSleep(ms, resolve);
        return;
      }
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = (): void => {
        cancel();
        reject(abortReason(signal));
      };
      const settle = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const cancel = clock.addSleep(ms, settle);
      signal.addEventListener('abort', onAbort, { once: true });
    });
}
