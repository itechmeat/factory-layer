/**
 * Recovery from an indeterminate start: `playbook_run` timed out or answered
 * something unreadable, yet APB may have created the run, and its detached
 * driver outlives the MCP session. APB gives a start no client key, so the
 * run is recognised by what the caller controls: the playbook, a worktree
 * used by no other run, and a start time at or after the call. A match is
 * stopped and confirmed terminal with its driver gone; every call ends by
 * the cleanup deadline. `not_found` is claimed only after `runs_list`
 * answered at least once; a dead connection ends the search at once, and
 * any search that never listed the runs is `unknown`.
 */

import { isDeadConnection, messageOf } from '../mcp-stdio/errors';
import { type ApbToolCaller, leftUntil, pauseBefore } from './apb-tool-caller';
import { type RunStatus, RunStatusAnswerSchema, RunsListSchema } from './apb-run-schemas';
import { stopAndConfirm } from './stop-run';

/** What became of a start that did not answer with a run. */
export type StartRecovery =
  | { readonly kind: 'not_started' }
  | { readonly kind: 'not_found' }
  /** The runs could not be searched (a dead connection, or no `runs_list` answer): a run may be alive. */
  | { readonly kind: 'unknown'; readonly detail: string }
  | { readonly kind: 'stopped'; readonly runId: string; readonly finalStatus: RunStatus }
  | { readonly kind: 'cleanup_timeout'; readonly runId: string; readonly lastStatus: RunStatus | undefined };

/** What identifies the run a start may have created. */
export interface StartIdentity {
  readonly playbookId: string;
  /** Absolute path, as `run_status.worktree` reports it. */
  readonly worktree: string;
  /** Wall-clock milliseconds taken just before `playbook_run` was called. */
  readonly calledAtMs: number;
}

/** A run the lookup matched, with the status `run_status` reported. */
export interface MatchedRun {
  readonly runId: string;
  readonly status: RunStatus;
}

/**
 * The runs of `identity.playbookId` started at or after `identity.calledAtMs`
 * in `identity.worktree`, each confirmed by its `run_status`; `onListed`
 * fires once `runs_list` answered. `first` stops at the first match.
 */
export async function matchingRuns(
  caller: ApbToolCaller,
  identity: StartIdentity,
  deadline: number,
  options: { readonly onListed?: () => void; readonly first?: boolean } = {},
): Promise<MatchedRun[]> {
  const runs = await caller.callToolParsed('runs_list', {}, RunsListSchema, { timeoutMs: leftUntil(deadline) });
  options.onListed?.();
  const candidates = runs.filter((run) => run.playbook === identity.playbookId && run.started_ts >= identity.calledAtMs);
  const matches: MatchedRun[] = [];
  for (const candidate of candidates) {
    const status = await caller.callToolParsed('run_status', { run_id: candidate.run_id }, RunStatusAnswerSchema, {
      timeoutMs: leftUntil(deadline),
    });
    if (status.worktree !== identity.worktree) continue;
    matches.push({ runId: candidate.run_id, status: status.run_status });
    if (options.first === true) break;
  }
  return matches;
}

/** Looks for the run until `cleanupDeadline`; stops it when found. */
export async function recoverStart(
  caller: ApbToolCaller,
  identity: StartIdentity,
  cleanupDeadline: number,
  pollIntervalMs: number,
): Promise<StartRecovery> {
  let listed = false;
  let lastError = 'the runs were never listed';
  while (performance.now() < cleanupDeadline) {
    let runId: string | undefined;
    try {
      const [match] = await matchingRuns(caller, identity, cleanupDeadline, {
        first: true,
        onListed: () => {
          listed = true;
        },
      });
      runId = match?.runId;
    } catch (error) {
      if (isDeadConnection(error)) return { kind: 'unknown', detail: messageOf(error) };
      // Any other failed lookup is retried until the cleanup deadline.
      lastError = messageOf(error);
    }
    if (runId !== undefined) {
      const stop = await stopAndConfirm(caller, runId, cleanupDeadline, pollIntervalMs);
      return stop.confirmed
        ? { kind: 'stopped', runId, finalStatus: stop.status }
        : { kind: 'cleanup_timeout', runId, lastStatus: stop.status };
    }
    await pauseBefore(cleanupDeadline, pollIntervalMs);
  }
  return listed ? { kind: 'not_found' } : { kind: 'unknown', detail: lastError };
}
