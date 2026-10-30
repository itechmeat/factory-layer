/**
 * The two caps on live executor runs of one factory run: the run's own cap
 * (its resolved task concurrency, enforced here with a FIFO queue) and the
 * process-wide cap shared by every run (the ExecutionSlots port). Task,
 * repair and integrate runs all take a lease from both. The local permit is
 * taken synchronously when one is free, so a caller that checks `freeLocal`
 * and acquires in the same tick never overshoots the run's cap. Every
 * release wakes whoever waits on `released()` (the scheduler), so a permit
 * freed while its task is still judging or integrating is used at once.
 */

import type { ExecutionSlots, Slot } from '../ports';

/** One held permission to run one executor run; release it exactly once. */
export interface Lease {
  readonly id: number;
}

/** The error a slot wait rejects with when the run's signal aborts. */
export class SlotWaitAborted extends Error {
  constructor() {
    super('the wait for an executor slot was aborted');
    this.name = 'SlotWaitAborted';
  }
}

export class RunSlots {
  private readonly global: ExecutionSlots;
  private readonly runId: string;
  private free: number;
  private readonly waiters: (() => void)[] = [];
  private readonly held = new Map<number, Slot>();
  private nextId = 1;
  private releaseWaiters: (() => void)[] = [];

  constructor(info: { cap: number; global: ExecutionSlots; runId: string }) {
    this.free = info.cap;
    this.global = info.global;
    this.runId = info.runId;
  }

  /** Local permits free right now. */
  freeLocal(): number {
    return this.free;
  }

  /** Waits for a local permit (FIFO), then for a shared slot; rejects when the signal aborts first. */
  acquire(signal: AbortSignal): Promise<Lease> {
    if (signal.aborted) {
      return Promise.reject(new SlotWaitAborted());
    }
    if (this.free > 0) {
      this.free -= 1;
      return this.acquireShared(signal);
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new SlotWaitAborted());
      };
      const waiter = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    }).then(() => this.acquireShared(signal));
  }

  /** Frees the lease's shared slot and local permit; a released lease is ignored. */
  release(lease: Lease): void {
    const slot = this.held.get(lease.id);
    if (slot === undefined) {
      return;
    }
    this.held.delete(lease.id);
    this.global.release(slot);
    this.releaseLocal();
    const waiters = this.releaseWaiters;
    this.releaseWaiters = [];
    for (const wake of waiters) {
      wake();
    }
  }

  /** Resolves at the next release of a lease. */
  released(): Promise<void> {
    return new Promise((resolve) => {
      this.releaseWaiters.push(resolve);
    });
  }

  /** Frees every lease still held (the factory run ends). */
  releaseAll(): void {
    for (const id of this.held.keys()) {
      this.release({ id });
    }
  }

  private async acquireShared(signal: AbortSignal): Promise<Lease> {
    try {
      const slot = await this.global.acquire(this.runId, signal);
      const lease: Lease = { id: this.nextId };
      this.nextId += 1;
      this.held.set(lease.id, slot);
      return lease;
    } catch {
      this.releaseLocal();
      throw new SlotWaitAborted();
    }
  }

  /** Hands the local permit to the first waiter, or returns it to the pool. */
  private releaseLocal(): void {
    const next = this.waiters.shift();
    if (next === undefined) {
      this.free += 1;
    } else {
      next();
    }
  }
}
