/**
 * Follows one supervised APB run through `apb mcp`: starts it with
 * `supervise: "self"`, waits on the supervisor event stream in bounded
 * slices, and on a host-task wait, a stall, an error or the run limit stops
 * the run and polls it until it is terminal with its driver gone.
 *
 * Invariants: every call is bounded by the absolute deadline in force (the
 * run deadline while following, the cleanup deadline while stopping), so
 * `followRun` settles within the run limit plus the cleanup budget plus one
 * poll interval; every failure is a typed outcome, never a throw; the
 * supervisor token is registered as a secret before any later call.
 */

import { type RunStatus, RunStartSchema, type SupervisorWait, SupervisorWaitSchema, TERMINAL_RUN_STATUSES } from './apb-run-schemas';
import { type ApbToolCaller, leftUntil } from './apb-tool-caller';
import { recoverStart, type StartIdentity, type StartRecovery } from './recover-start';
import { stopAndConfirm } from './stop-run';
import { isDeadConnection, McpTimeoutError, McpToolError, messageOf } from '../mcp-stdio/errors';

/** Default budget for stopping a run and seeing it terminal, in milliseconds. */
export const FOLLOW_RUN_CLEANUP_BUDGET_MS = 60_000;

/** Longest supervisor wait asked of APB in one call, in milliseconds. */
export const SUPERVISOR_WAIT_SLICE_MS = 60_000;

/** Room between a wait slice and its MCP request timeout, in milliseconds. */
export const SUPERVISOR_WAIT_MARGIN_MS = 5000;

/** Pause between two `run_status` polls on the stop path, in milliseconds. */
export const RUN_STATUS_POLL_INTERVAL_MS = 1000;

/** What to run and the budgets; `playbookId`, `worktree` and `runLimitMs` are required. */
export interface FollowRunRequest {
  readonly playbookId: string;
  /**
   * The run's working tree: an absolute path inside the project that no
   * other run uses. It identifies the run when the start answer is lost.
   */
  readonly worktree: string;
  /** Counted from the start call; the run is stopped when it passes. */
  readonly runLimitMs: number;
  /** The playbook's params, as strings; omitted for a playbook without params. */
  readonly params?: Readonly<Record<string, string>>;
  readonly cleanupBudgetMs?: number;
  readonly waitSliceMs?: number;
  readonly waitMarginMs?: number;
  readonly pollIntervalMs?: number;
}

/** Why the follower stopped a run. */
export type StopReason = 'pending_tasks' | 'stalled' | 'error' | 'run_limit';

/** How following a run ended. */
export type FollowRunOutcome =
  | {
      readonly kind: 'start_failed';
      readonly detail: string;
      /** Whether a run was created after all, and what was done about it. */
      readonly recovery: StartRecovery;
      readonly elapsedMs: number;
    }
  | { readonly kind: 'succeeded'; readonly runId: string; readonly elapsedMs: number }
  | { readonly kind: 'failed'; readonly runId: string; readonly status: RunStatus; readonly elapsedMs: number }
  | {
      readonly kind: 'stopped';
      readonly runId: string;
      readonly reason: StopReason;
      readonly detail: string;
      readonly finalStatus: RunStatus;
      readonly elapsedMs: number;
    }
  | {
      readonly kind: 'cleanup_timeout';
      readonly runId: string;
      readonly reason: StopReason;
      readonly detail: string;
      readonly lastStatus: RunStatus | undefined;
      readonly elapsedMs: number;
    };

interface Budgets {
  readonly cleanupBudgetMs: number;
  readonly waitSliceMs: number;
  readonly waitMarginMs: number;
  readonly pollIntervalMs: number;
}

/** A reason to stop the run, or undefined to keep waiting. */
function stopReasonOf(answer: SupervisorWait): { reason: StopReason; detail: string } | undefined {
  if (answer.reason === 'host_task' || answer.pending_tasks !== undefined) {
    return { reason: 'pending_tasks', detail: 'the run waits for a host task; this factory runs agents only through CLIs' };
  }
  if (answer.reason === 'review' || answer.pending_review !== null) {
    return { reason: 'stalled', detail: 'the run waits on a human review gate' };
  }
  if (answer.pending_supervisor !== null) {
    return { reason: 'stalled', detail: 'the run waits for its supervisor' };
  }
  if (answer.reason === 'ended') {
    return { reason: 'stalled', detail: `the run stopped moving in status ${answer.run_status}` };
  }
  return undefined;
}

/**
 * The slice asked of APB and the request timeout for `leftMs` before the run
 * deadline: normally the slice is at most `leftMs - margin` and the request
 * timeout the slice plus the margin. Inside the last margin the slice is
 * half the time left, so the follower keeps blocking server-side in
 * shrinking waits instead of spinning on zero-length ones; the request
 * timeout never passes the deadline.
 */
function waitSlice(leftMs: number, budgets: Budgets): { slice: number; requestTimeoutMs: number } {
  const roomy = leftMs - budgets.waitMarginMs;
  const slice = roomy > 0 ? Math.min(budgets.waitSliceMs, roomy) : Math.floor(leftMs / 2);
  return { slice, requestTimeoutMs: Math.max(1, Math.min(slice + budgets.waitMarginMs, leftMs)) };
}

type WatchResult =
  | { readonly kind: 'terminal'; readonly status: RunStatus }
  | { readonly kind: 'stop'; readonly reason: StopReason; readonly detail: string };

/** Waits on the supervisor stream until the run is terminal or must be stopped. */
async function watch(caller: ApbToolCaller, token: string, runDeadline: number, budgets: Budgets): Promise<WatchResult> {
  let afterSeq: number | undefined;
  for (;;) {
    const left = runDeadline - performance.now();
    if (left <= 0) return { kind: 'stop', reason: 'run_limit', detail: 'the run limit passed' };
    const { slice, requestTimeoutMs } = waitSlice(Math.floor(left), budgets);
    let answer: SupervisorWait;
    try {
      answer = await caller.callToolParsed(
        'supervisor_wait_event',
        { token, timeout_ms: slice, ...(afterSeq === undefined ? {} : { after_seq: afterSeq }) },
        SupervisorWaitSchema,
        { timeoutMs: requestTimeoutMs },
      );
    } catch (error) {
      // A request timeout capped by the run deadline is the run limit, even
      // when the timer fired a millisecond before the deadline.
      const cappedByDeadline = error instanceof McpTimeoutError && requestTimeoutMs >= Math.floor(left);
      if (cappedByDeadline || performance.now() >= runDeadline) {
        return { kind: 'stop', reason: 'run_limit', detail: 'the run limit passed' };
      }
      return { kind: 'stop', reason: 'error', detail: messageOf(error) };
    }
    if (TERMINAL_RUN_STATUSES.has(answer.run_status)) return { kind: 'terminal', status: answer.run_status };
    const stop = stopReasonOf(answer);
    if (stop !== undefined) return { kind: 'stop', ...stop };
    afterSeq = answer.next_after_seq ?? afterSeq;
  }
}

/**
 * What became of a start that failed with `error`: a tool error is APB
 * declining it; a dead connection cannot search, so a run may be alive
 * (`unknown`); anything else (a timeout, an unreadable answer) leaves it open
 * whether the run exists, so it is looked up and stopped.
 */
async function recoveryAfter(caller: ApbToolCaller, error: unknown, identity: StartIdentity, budgets: Budgets): Promise<StartRecovery> {
  if (error instanceof McpToolError) return { kind: 'not_started' };
  if (isDeadConnection(error)) return { kind: 'unknown', detail: messageOf(error) };
  return recoverStart(caller, identity, performance.now() + budgets.cleanupBudgetMs, budgets.pollIntervalMs);
}

/** Runs `playbookId` supervised and follows it; see the module header. */
export async function followRun(caller: ApbToolCaller, request: FollowRunRequest): Promise<FollowRunOutcome> {
  const budgets: Budgets = {
    cleanupBudgetMs: request.cleanupBudgetMs ?? FOLLOW_RUN_CLEANUP_BUDGET_MS,
    waitSliceMs: request.waitSliceMs ?? SUPERVISOR_WAIT_SLICE_MS,
    waitMarginMs: request.waitMarginMs ?? SUPERVISOR_WAIT_MARGIN_MS,
    pollIntervalMs: request.pollIntervalMs ?? RUN_STATUS_POLL_INTERVAL_MS,
  };
  const begin = performance.now();
  const runDeadline = begin + request.runLimitMs;
  const elapsed = (): number => Math.round(performance.now() - begin);

  let runId: string;
  let token: string;
  const calledAtMs = Date.now();
  try {
    const start = await caller.callToolParsed(
      'playbook_run',
      {
        id: request.playbookId,
        supervise: 'self',
        worktree: request.worktree,
        ...(request.params === undefined ? {} : { params: request.params }),
      },
      RunStartSchema,
      { timeoutMs: leftUntil(runDeadline) },
    );
    if (start.kind === 'refused') {
      const detail = `refused by APB policy ${start.policy}: ${start.detail}`;
      return { kind: 'start_failed', detail, recovery: { kind: 'not_started' }, elapsedMs: elapsed() };
    }
    ({ runId, token } = start);
  } catch (error) {
    const identity = { playbookId: request.playbookId, worktree: request.worktree, calledAtMs };
    const recovery = await recoveryAfter(caller, error, identity, budgets);
    return { kind: 'start_failed', detail: messageOf(error), recovery, elapsedMs: elapsed() };
  }
  caller.addSecret(token);

  const watched = await watch(caller, token, runDeadline, budgets);
  if (watched.kind === 'terminal') {
    return watched.status === 'succeeded'
      ? { kind: 'succeeded', runId, elapsedMs: elapsed() }
      : { kind: 'failed', runId, status: watched.status, elapsedMs: elapsed() };
  }
  const cleanup = await stopAndConfirm(caller, runId, performance.now() + budgets.cleanupBudgetMs, budgets.pollIntervalMs);
  const { reason, detail } = watched;
  if (cleanup.confirmed) {
    return { kind: 'stopped', runId, reason, detail, finalStatus: cleanup.status, elapsedMs: elapsed() };
  }
  const cleanupDetail = cleanup.connectionLost === undefined ? detail : `${detail}; connection lost: ${cleanup.connectionLost}`;
  return { kind: 'cleanup_timeout', runId, reason, detail: cleanupDetail, lastStatus: cleanup.status, elapsedMs: elapsed() };
}
