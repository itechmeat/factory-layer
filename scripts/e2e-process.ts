/**
 * The absolute deadline of the end-to-end run script and its bounded child
 * processes. Every child runs through the check runner's `runCommand` (its
 * own process group, killed past its timeout) with a timeout no later than
 * the script's deadline, so no grandchild (an `apb mcp`, a test runner, a
 * `sleep`) outlives the script; children still running when the script
 * must stop are killed with `killLiveProcessGroups`.
 */

import { runCommand, type RunCommandInput } from '../src/adapters/check-runner/process';
import type { CommandOutcome } from '../src/ports/check-runner';

/** The absolute end of the script, as a wall-clock time in milliseconds. */
export interface Deadline {
  readonly atMs: number;
}

/** A deadline `ms` milliseconds from now. */
export function createDeadline(ms: number): Deadline {
  return { atMs: Date.now() + ms };
}

/** Milliseconds left before the deadline, never negative. */
export function remainingMs(deadline: Deadline): number {
  return Math.max(0, deadline.atMs - Date.now());
}

/** Runs one child bounded by the earlier of its own timeout and the script's deadline. */
export function runBeforeDeadline(input: Omit<RunCommandInput, 'secrets'>, deadline: Deadline): Promise<CommandOutcome> {
  return runCommand({ ...input, timeoutMs: Math.min(input.timeoutMs, remainingMs(deadline)), secrets: [] });
}

/** The last `lines` lines of a text, for reports. */
export function tail(text: string, lines = 20): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}
