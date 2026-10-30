/**
 * Pid-based teardown of an MCP server process. Invariant: `terminateProcess`
 * settles within the grace period plus the exit-confirmation budget, whatever
 * the graceful close is still waiting for; the process is gone when it
 * resolves, and a process still present is a typed teardown error.
 */

import { McpTeardownError } from './errors';

/** How often the pid is probed while waiting for an exit, in milliseconds. */
export const PID_POLL_INTERVAL_MS = 50;

/** How long an exit is awaited after SIGKILL, in milliseconds. */
export const EXIT_CONFIRMATION_MS = 1000;

/** True while a process with this pid exists (signal 0 probe; EPERM means it exists). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** Polls until the pid is gone or `ms` has passed; true when it is gone. */
async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (isProcessAlive(pid)) {
    const left = deadline - performance.now();
    if (left <= 0) return false;
    await Bun.sleep(Math.min(PID_POLL_INTERVAL_MS, left));
  }
  return true;
}

function sendKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The process exited between the probe and the kill: nothing to do.
  }
}

/** What `terminateProcess` needs. */
export interface TerminateRequest {
  readonly pid: number;
  /** Counted from the call; SIGKILL is sent when it ends with the pid alive. */
  readonly graceMs: number;
  /** The graceful close (the SDK's); it runs concurrently and is never awaited past the grace period. */
  readonly close: () => Promise<void>;
  /** Sends SIGKILL; replaceable only to model a process that survives it. */
  readonly kill?: (pid: number) => void;
}

/** Closes gracefully, then kills; resolves once the pid is gone. */
export async function terminateProcess(request: TerminateRequest): Promise<void> {
  const { pid, graceMs } = request;
  // The grace period starts before the close is called.
  const exited = waitForExit(pid, graceMs);
  request.close().catch(() => {
    // A failing graceful close is covered by the kill below.
  });
  if (await exited) return;
  (request.kill ?? sendKill)(pid);
  if (await waitForExit(pid, EXIT_CONFIRMATION_MS)) return;
  throw new McpTeardownError(pid, graceMs + EXIT_CONFIRMATION_MS);
}
