/**
 * `ExecutionSlots` for tests: a configurable cap over one shared pool, a
 * live count the test can watch, and waits that happen on the injected fake
 * `Sleep`, so a full pool releases only when the test advances the clock.
 */

import type { ExecutionSlots, Sleep, Slot } from '../../ports';

/** How often a full pool is rechecked, in fake milliseconds. */
export const SLOT_POLL_MS = 100;

export class FakeSlots implements ExecutionSlots {
  private readonly cap: number;
  private readonly sleep: Sleep;
  private readonly live = new Set<Slot>();

  constructor(deps: { cap: number; sleep: Sleep }) {
    this.cap = deps.cap;
    this.sleep = deps.sleep;
  }

  /** How many acquired slots are held right now. */
  liveCount(): number {
    return this.live.size;
  }

  async acquire(runId: string, signal: AbortSignal): Promise<Slot> {
    for (;;) {
      signal.throwIfAborted();
      const slot: Slot = { runId };
      if (this.live.size < this.cap) {
        this.live.add(slot);
        return slot;
      }
      await this.sleep(SLOT_POLL_MS, signal);
    }
  }

  release(slot: Slot): void {
    this.live.delete(slot);
  }
}
