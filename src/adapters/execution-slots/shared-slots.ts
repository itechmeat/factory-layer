/**
 * `ExecutionSlots` for one process: a counting semaphore over the
 * process-wide cap on live executor runs. Waiters are served first come,
 * first served; a waiter whose signal aborts leaves the queue at once and
 * rejects naming its run, and a released slot goes straight to the next
 * waiter. Invariant: never more than `cap` slots are held.
 */

import type { ExecutionSlots, Slot } from '../../ports/execution-slots';

interface Waiter {
  readonly runId: string;
  readonly grant: (slot: Slot) => void;
}

/** The shared cap on live executor runs of every factory run in this process. */
export class SharedSlots implements ExecutionSlots {
  readonly #cap: number;
  readonly #held = new Set<Slot>();
  readonly #waiters: Waiter[] = [];

  constructor(cap: number) {
    this.#cap = cap;
  }

  acquire(runId: string, signal: AbortSignal): Promise<Slot> {
    if (signal.aborted) return Promise.reject(new Error(`run ${runId}: aborted before an executor slot was free`));
    if (this.#held.size < this.#cap) return Promise.resolve(this.#take(runId));
    return new Promise<Slot>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error(`run ${runId}: aborted while waiting for an executor slot`));
      };
      const waiter: Waiter = {
        runId,
        grant: (slot) => {
          signal.removeEventListener('abort', onAbort);
          resolve(slot);
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  release(slot: Slot): void {
    if (!this.#held.delete(slot)) return;
    const next = this.#waiters.shift();
    if (next !== undefined) next.grant(this.#take(next.runId));
  }

  #take(runId: string): Slot {
    const slot: Slot = { runId };
    this.#held.add(slot);
    return slot;
  }
}
