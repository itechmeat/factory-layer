/**
 * The stop path of a supervised APB run: `run_stop`, then `run_status` polls
 * until the run is terminal and no driver holds it. Invariant: every call
 * ends by the cleanup deadline, so the stop path never outlives it; a dead
 * connection ends it at once, unconfirmed, since no later call can succeed.
 */

import { isDeadConnection, messageOf } from '../mcp-stdio/errors';
import { type ApbToolCaller, leftUntil, pauseBefore } from './apb-tool-caller';
import { type RunStatus, RunStatusAnswerSchema, RunStopSchema, TERMINAL_RUN_STATUSES } from './apb-run-schemas';

/** Whether the stop was confirmed, with the last status seen. */
export type StopConfirmation =
  | { readonly confirmed: true; readonly status: RunStatus }
  | {
      readonly confirmed: false;
      readonly status: RunStatus | undefined;
      /** Why the connection died, when that ended the stop path before the deadline. */
      readonly connectionLost?: string;
    };

/** Stops `runId` and polls it until terminal with no live driver, until `cleanupDeadline`. */
export async function stopAndConfirm(
  caller: ApbToolCaller,
  runId: string,
  cleanupDeadline: number,
  pollIntervalMs: number,
): Promise<StopConfirmation> {
  try {
    await caller.callToolParsed('run_stop', { run_id: runId }, RunStopSchema, {
      timeoutMs: leftUntil(cleanupDeadline),
    });
  } catch (error) {
    if (isDeadConnection(error)) return { confirmed: false, status: undefined, connectionLost: messageOf(error) };
    // Otherwise the poll below decides: a run that is already terminal needs no stop.
  }
  let status: RunStatus | undefined;
  while (performance.now() < cleanupDeadline) {
    try {
      const answer = await caller.callToolParsed('run_status', { run_id: runId }, RunStatusAnswerSchema, {
        timeoutMs: leftUntil(cleanupDeadline),
      });
      status = answer.run_status;
      if (TERMINAL_RUN_STATUSES.has(status) && answer.driver_alive !== true) return { confirmed: true, status };
    } catch (error) {
      if (isDeadConnection(error)) return { confirmed: false, status, connectionLost: messageOf(error) };
      // Any other failed poll is retried until the cleanup deadline.
    }
    await pauseBefore(cleanupDeadline, pollIntervalMs);
  }
  return { confirmed: false, status };
}
