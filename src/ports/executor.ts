/**
 * The Executor port: supervised coding runs driven through the hands
 * (start, find, wait for events, report, recovery commands, stop, attach
 * after a restart). The application owns every deadline and budget; the
 * executor only executes and reports.
 */

import type { DispatchKey } from '../domain/run-state';
import type { UsageRecord } from '../domain/usage';

/**
 * The typed inputs of a start call: the task text, the paths the task owns,
 * and on a retry the checks that failed (with their reasons) or the paths
 * that conflicted at integration.
 */
export interface ExecutorStartInputs {
  readonly taskText: string;
  readonly ownedPaths: readonly string[];
  readonly failingChecks?: readonly { readonly id: string; readonly reason: string }[];
  readonly conflictPaths?: readonly string[];
}

/** What the application hands a start call: correlation, playbook, tree, inputs. */
export interface StartRunInput {
  readonly dispatchKey: DispatchKey;
  readonly playbook: string;
  readonly tree: string;
  readonly inputs: ExecutorStartInputs;
}

/**
 * The outcome of a start call. `indeterminate` means the answer was lost or
 * timed out and the run may or may not exist (the application settles that);
 * `refused` means the executor declined by the named `policy`, explained in
 * `detail`. Neither is an error.
 */
export type StartRunResult =
  | { readonly ok: true; readonly runId: string; readonly supervisorToken: string }
  | { readonly ok: false; readonly outcome: 'indeterminate'; readonly detail: string }
  | { readonly ok: false; readonly outcome: 'refused'; readonly policy: string; readonly detail: string };

/** A run as a lookup sees it; `unknown` when the executor cannot say. */
export interface ExecutorRunInfo {
  readonly runId: string;
  readonly status: 'created' | 'running' | 'succeeded' | 'failed' | 'aborted' | 'stopped' | 'unknown';
}

/**
 * One event of a supervised run. `wake` reports why the run woke its
 * supervisor (a node failed, finished, asked a question, wants a review, or
 * looks stalled); `terminal` reports the run's final state; `needs_host`
 * reports a wait the factory cannot serve; `quiet` means the wait slice
 * passed with no event.
 */
export type ExecutorEvent =
  | {
      readonly kind: 'wake';
      readonly seq: number;
      readonly trigger: 'node_failed' | 'node_finished' | 'question' | 'review' | 'stalled' | 'other';
      readonly nodeId: string | null;
      readonly detail: string | null;
    }
  | { readonly kind: 'terminal'; readonly status: 'succeeded' | 'failed' | 'aborted' | 'stopped' }
  | { readonly kind: 'needs_host' }
  | { readonly kind: 'quiet' };

/** One served wait: the event and the cursor to persist after it. */
export type WaitEventResult = { readonly event: ExecutorEvent; readonly nextAfterSeq: number };

/** What one node of a run reported when it ended. */
export interface ExecutorNodeReport {
  readonly nodeId: string;
  readonly outcome: 'succeeded' | 'failed' | 'skipped';
  readonly summary: string;
  readonly attempts: number;
}

/** A finished run's report: status, node reports and per-attempt usage. */
export interface ExecutorReport {
  readonly runId: string;
  readonly status: 'succeeded' | 'failed' | 'aborted' | 'stopped';
  readonly summary: string;
  readonly nodes: readonly ExecutorNodeReport[];
  /** One record per node attempt, unavailable when the attempt reported none. */
  readonly usage: readonly UsageRecord[];
}

/**
 * What a recovery command post did: `accepted` says the executor took the
 * command (not that it applied it); `postedSeq` is the sequence the post
 * landed at, null when it did not land.
 */
export type CommandPostResult = { readonly accepted: boolean; readonly postedSeq: number | null };

/** What a bounded stop achieved: confirmed `stopped`, or `unconfirmed`, with the executor's detail. */
export type StopResult = { readonly outcome: 'stopped' | 'unconfirmed'; readonly detail: string };

/** Typed executor failure; a refused or lost start is a result, not this. */
export class ExecutorError extends Error {
  readonly reason: 'failed' | 'timeout' | 'cancelled' | 'protocol';

  constructor(info: { reason: 'failed' | 'timeout' | 'cancelled' | 'protocol'; detail: string }) {
    super(info.detail);
    this.name = 'ExecutorError';
    this.reason = info.reason;
  }
}

/**
 * The hands of the factory. Every method is bounded: the caller passes a
 * deadline or a slice in milliseconds (or the adapter's documented bound)
 * and the implementation resolves or rejects within it, never hanging and
 * never reporting a failure as a string. Failures reject with ExecutorError
 * unless the signature defines a discriminated result for the case.
 */
export interface Executor {
  /**
   * Starts a supervised executor run for the dispatch key. Deadline:
   * bounded by the caller's start deadline (milliseconds); a call whose
   * answer is lost resolves with outcome 'indeterminate' instead of
   * hanging. Failure: a policy refusal resolves with outcome 'refused';
   * only a cancelled or broken call rejects with ExecutorError; never
   * hangs.
   */
  startRun(input: StartRunInput): Promise<StartRunResult>;

  /**
   * Lists runs of the playbook in the tree created at or after `notBefore`
   * (ISO instant); the application settles an indeterminate start with it.
   * Deadline: bounded by the caller (milliseconds). Failure: resolves with
   * an empty array when nothing matches; rejects with ExecutorError on
   * timeout, cancellation or a broken transport; never hangs.
   */
  findRuns(query: { readonly playbook: string; readonly tree: string; readonly notBefore: string }): Promise<readonly ExecutorRunInfo[]>;

  /**
   * Waits for the run's next event after `afterSeq`, at most `sliceMs`
   * (milliseconds) by the adapter. Deadline: bounded by the `sliceMs`
   * argument. Failure: resolves with kind 'quiet' when the slice passed
   * with no event; rejects with ExecutorError when the run is unknown,
   * times out or the transport breaks; never hangs.
   */
  waitEvent(runId: string, afterSeq: number, sliceMs: number): Promise<WaitEventResult>;

  /**
   * Collects a finished run's report (status, node reports, usage).
   * Deadline: bounded by the caller (milliseconds). Failure: rejects with
   * ExecutorError when the run is unknown, times out, is cancelled or the
   * transport breaks; never hangs.
   */
  report(runId: string): Promise<ExecutorReport>;

  /**
   * Appends hint text to the run's context. Deadline: bounded by the
   * caller (milliseconds). Failure: resolves with CommandPostResult,
   * accepted false with postedSeq null when the executor did not take the
   * command; rejects with ExecutorError on timeout, cancellation or a
   * broken transport; never hangs.
   */
  appendContext(runId: string, text: string): Promise<CommandPostResult>;

  /**
   * Retries a failed node of the run. Deadline: bounded by the caller
   * (milliseconds). Failure: resolves with CommandPostResult, accepted
   * false with postedSeq null when the executor did not take the command;
   * rejects with ExecutorError on timeout, cancellation or a broken
   * transport; never hangs.
   */
  retryNode(runId: string, nodeId: string): Promise<CommandPostResult>;

  /**
   * Rebinds a node of the run to another model profile. Deadline: bounded
   * by the caller (milliseconds). Failure: resolves with
   * CommandPostResult, accepted false with postedSeq null when the
   * executor did not take the command; rejects with ExecutorError on
   * timeout, cancellation or a broken transport; never hangs.
   */
  rebindProfile(runId: string, nodeId: string, profile: string): Promise<CommandPostResult>;

  /**
   * Stops the run and waits until it is terminal and its driver is gone.
   * Deadline: bounded by the `deadlineMs` argument (milliseconds).
   * Failure: resolves with outcome 'unconfirmed' when the deadline passes
   * without confirmation; rejects with ExecutorError only on cancellation
   * or a broken transport; never hangs.
   */
  stop(runId: string, deadlineMs: number): Promise<StopResult>;

  /**
   * Restores supervision of a run after a restart, from its token.
   * Deadline: bounded by the caller (milliseconds). Failure: resolves with
   * attached false and the reason in `detail` when the executor declines
   * the attach; rejects with ExecutorError on timeout, cancellation or a
   * broken transport; never hangs.
   */
  attach(runId: string, supervisorToken: string): Promise<{ readonly attached: boolean; readonly detail: string }>;
}
