/**
 * Races a piece of work against the time left. The work itself is not
 * aborted (Mozaik's endpoints take no abort signal); the caller stops
 * waiting. `Promise.race` subscribes to the work, so a late failure of the
 * abandoned work is observed and never surfaces as an unhandled rejection.
 */

/** Resolves with `work`, or rejects with `onTimeout()` once `timeLeftMs` has passed. */
export async function raceDeadline<T>(work: Promise<T>, timeLeftMs: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), Math.max(0, timeLeftMs));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
