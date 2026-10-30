/**
 * Drives work that waits on the fake clock to its end: it drains the pending
 * microtasks, and while the work is unsettled moves the clock to the next
 * fake timer, so a whole factory run plays out deterministically with no
 * real waiting. A run that waits on nothing and never settles is reported as
 * a deadlock instead of hanging the test.
 */

import type { FakeClock } from './fake-clock';

/** The fake timers one drive may fire before it gives up. */
const MAX_STEPS = 100_000;

/** Lets every queued microtask (and the ones they queue) run. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Settles the work by advancing the fake clock timer by timer; rejects with the work's error. */
export async function drive<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let settled = false;
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let step = 0; step < MAX_STEPS; step += 1) {
    await flush();
    if (settled) {
      return work;
    }
    const next = clock.nextWakeMs();
    if (next === null) {
      throw new Error('deadlock: the work has not settled and nothing waits on the fake clock');
    }
    clock.setTo(new Date(Math.max(next, clock.now().getTime())).toISOString());
  }
  throw new Error(`the work did not settle within ${MAX_STEPS} fake timers`);
}
