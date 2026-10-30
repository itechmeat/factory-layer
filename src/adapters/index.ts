/**
 * Adapters layer: implementations of the ports over real systems (the Mozaik
 * brain, APB through `apb mcp`, OSB memory, the stdio MCP client, git, the
 * file-system trace, the report). Adapters may import the application, ports
 * and the domain, never the CLI.
 *
 * This module holds the process clock and the process wait.
 */

import type { Clock, Sleep } from '../ports/index';

/** `Clock` over the process wall clock. */
export const systemClock: Clock = { now: () => new Date() };

/** The error an aborted wait rejects with: the signal's reason when it is an error. */
function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('the wait was aborted');
}

/** `Sleep` over a real timer; rejects as soon as the signal aborts. */
export const systemSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
