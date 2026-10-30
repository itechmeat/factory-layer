/**
 * Bounded port calls: one call raced against a deadline on the injected
 * sleep and against the caller's signal. The call gets its own signal, which
 * is aborted when the deadline passes or the caller cancels, so a port that
 * honours its signal stops working; a port that ignores it is left behind
 * and its late answer is dropped. Every outcome is a value, never a throw.
 */

import type { Sleep } from '../ports';

/** How a bounded call ended: its value, its error, the deadline, or the caller's cancellation. */
export type Bounded<T> =
  | { readonly status: 'done'; readonly value: T }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'timeout' }
  | { readonly status: 'cancelled' };

/** Runs the call bounded by `deadlineMs` (milliseconds) and the optional caller signal. */
export async function withDeadline<T>(info: {
  readonly call: (signal: AbortSignal) => Promise<T>;
  readonly deadlineMs: number;
  readonly sleep: Sleep;
  readonly signal?: AbortSignal;
}): Promise<Bounded<T>> {
  if (info.signal?.aborted === true) {
    return { status: 'cancelled' };
  }
  const callController = new AbortController();
  const timerController = new AbortController();
  const forward = (): void => {
    callController.abort();
  };
  info.signal?.addEventListener('abort', forward, { once: true });

  const callPromise = invoke(info.call, callController.signal);
  const timerPromise = info.sleep(info.deadlineMs, timerController.signal).then(
    (): Bounded<T> => ({ status: 'timeout' }),
    (): Bounded<T> => ({ status: 'cancelled' }),
  );
  const abortPromise = new Promise<Bounded<T>>((resolve) => {
    callController.signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
  });

  const outcome = await Promise.race([callPromise, timerPromise, abortPromise]);
  timerController.abort();
  info.signal?.removeEventListener('abort', forward);
  if (outcome.status === 'timeout') {
    callController.abort();
  }
  return outcome;
}

/** Calls once; a rejection becomes a `failed` value, never a thrown promise. */
async function invoke<T>(call: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<Bounded<T>> {
  try {
    return { status: 'done', value: await call(signal) };
  } catch (error) {
    return { status: 'failed', error };
  }
}

/** A short human text for an outcome that carried no value. */
export function boundedDetail(outcome: Exclude<Bounded<unknown>, { status: 'done' }>): string {
  if (outcome.status === 'failed') {
    return outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
  }
  return outcome.status === 'timeout' ? 'the call ran past its deadline' : 'the call was cancelled';
}
