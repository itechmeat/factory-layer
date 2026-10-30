/**
 * Integration one task at a time: accepted tasks wait here for their turn,
 * and when `main` is free the waiting task that comes first in the plan's
 * execution order (the stable topological order) integrates next. A task
 * whose signal aborts while it waits leaves the queue (its wait rejects).
 * The step that moves `main` runs through `advanceMain`: it starts only
 * while `main` is open (the cutoff closes it), and the cutoff waits for one
 * already under way (`advanceInFlight`), so the task state always matches
 * what `main` holds when delivery copies it.
 */

export class IntegrationQueue {
  private readonly rank = new Map<string, number>();
  private readonly waiting: { readonly taskId: string; readonly start: () => void }[] = [];
  private busy = false;
  private advancing: Promise<unknown> | null = null;

  constructor(order: readonly string[]) {
    this.setOrder(order);
  }

  /** Replaces the execution order (a runtime re-plan changes it). */
  setOrder(order: readonly string[]): void {
    this.rank.clear();
    order.forEach((taskId, index) => this.rank.set(taskId, index));
  }

  /** Runs the work once it is the task's turn; the next waiting task starts when it settles. */
  async run<T>(taskId: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const entry = {
        taskId,
        start: (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = (): void => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) {
          this.waiting.splice(index, 1);
        }
        reject(signal.reason instanceof Error ? signal.reason : new Error('the wait for integration was aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
      this.startNext();
    });
    try {
      return await work();
    } finally {
      this.busy = false;
      this.startNext();
    }
  }

  /** Runs the step that moves main, unless `closed()` holds when it would start (then null). */
  async advanceMain<T>(closed: () => boolean, step: () => Promise<T>): Promise<T | null> {
    if (closed()) {
      return null;
    }
    const running = step();
    this.advancing = running;
    try {
      return await running;
    } finally {
      this.advancing = null;
    }
  }

  /** The step that moves main while one is under way, else null. */
  advanceInFlight(): Promise<unknown> | null {
    return this.advancing;
  }

  private startNext(): void {
    if (this.busy || this.waiting.length === 0) {
      return;
    }
    const next = this.waiting.reduce((best, candidate) => (this.rankOf(candidate.taskId) < this.rankOf(best.taskId) ? candidate : best));
    this.waiting.splice(this.waiting.indexOf(next), 1);
    this.busy = true;
    next.start();
  }

  private rankOf(taskId: string): number {
    return this.rank.get(taskId) ?? Number.MAX_SAFE_INTEGER;
  }
}
