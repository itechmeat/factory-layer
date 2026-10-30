/**
 * The part of the stdio MCP client the APB adapter needs, and the timing
 * helpers every bounded APB call shares: a call's timeout is always the time
 * left until the absolute deadline in force.
 */

import type { z } from 'zod';

/** Calls `apb mcp` tools with validated results; satisfied by the stdio MCP client. */
export interface ApbToolCaller {
  callToolParsed<T>(
    name: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
    options?: { readonly timeoutMs?: number },
  ): Promise<T>;
  addSecret(value: string): void;
}

/** Milliseconds left until `deadline` (a `performance.now()` value), at least 1 so a timeout is always valid. */
export function leftUntil(deadline: number): number {
  return Math.max(1, Math.floor(deadline - performance.now()));
}

/** Waits `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Sleeps one poll interval, never past `deadline`. */
export async function pauseBefore(deadline: number, pollIntervalMs: number): Promise<void> {
  const pause = Math.min(pollIntervalMs, deadline - performance.now());
  if (pause > 0) await sleep(pause);
}
