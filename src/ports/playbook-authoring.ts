/**
 * The PlaybookAuthoring port: the stored playbooks the executor runs
 * (list, read, create, validate, trial-run, stop trial runs, approve). The
 * application uses it when the brain proposes a new playbook and to look
 * playbooks up.
 */

import type { Playbook, PlaybookDraft, PlaybookRef } from '../domain/decisions';

/**
 * What validation found: `problems` (the blocking issues) is empty exactly
 * when `ok` is true; `warnings` never block.
 */
export interface PlaybookValidation {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

/** What a trial run produced; `output` is redacted by the adapter. */
export interface PlaybookTrial {
  readonly ok: boolean;
  readonly output: string;
}

/** What became of one trial run found by `stopTrials`. */
export interface TrialRunStop {
  readonly runId: string;
  /** `already_ended`: the run was terminal when found, so no stop was needed. */
  readonly outcome: 'stopped' | 'unconfirmed' | 'already_ended';
}

/** The trial runs of a playbook that `stopTrials` found; `searched` is false when the runs could not be listed. */
export interface TrialStopResult {
  readonly searched: boolean;
  readonly runs: readonly TrialRunStop[];
  readonly detail: string;
}

/**
 * The playbook store. Every method is bounded by the caller's deadline in
 * milliseconds and the implementation resolves or rejects within it, never
 * hanging. Failures reject with an Error instance carrying the playbook id
 * and the cause (the contract defines no dedicated error class for this
 * port); validate, trial and approve report their outcome as a
 * discriminated result instead of an error.
 */
export interface PlaybookAuthoring {
  /**
   * Lists the stored playbooks. Deadline: bounded by the caller
   * (milliseconds). Failure: resolves with an empty array when none are
   * stored; rejects with an Error on timeout, cancellation or store
   * failure; never hangs.
   */
  list(): Promise<readonly PlaybookRef[]>;

  /**
   * Reads one playbook with its full content. Deadline: bounded by the
   * caller (milliseconds). Failure: rejects with an Error naming the id
   * when the playbook does not exist, and on timeout, cancellation or
   * store failure; never hangs.
   */
  get(id: string): Promise<Playbook>;

  /**
   * Stores a draft and returns its identity. Deadline: bounded by the
   * caller (milliseconds). Failure: rejects with an Error when the store
   * refuses the draft or on timeout, cancellation or store failure; never
   * hangs.
   */
  create(draft: PlaybookDraft): Promise<PlaybookRef>;

  /**
   * Validates a stored playbook without running it. Deadline: bounded by
   * the caller (milliseconds). Failure: resolves with PlaybookValidation
   * (ok false with the problems when invalid); rejects with an Error on
   * timeout, cancellation or store failure; never hangs.
   */
  validate(id: string): Promise<PlaybookValidation>;

  /**
   * Trial-runs a stored playbook on example inputs and an optional
   * instruction (what `{{run.instruction}}` renders). Deadline: bounded by
   * the caller's trial deadline (milliseconds). Failure: resolves with
   * PlaybookTrial (ok false with the captured output when the trial
   * fails); rejects with an Error on timeout, cancellation or store
   * failure; never hangs.
   */
  trial(id: string, inputs: Readonly<Record<string, string>>, instruction?: string): Promise<PlaybookTrial>;

  /**
   * Finds the runs of playbook `id` started at or after `notBeforeMs`
   * (wall-clock epoch milliseconds) and stops each live one with a
   * confirmation. Deadline: ends within `timeoutMs` (milliseconds); a run
   * not confirmed stopped by then is reported `unconfirmed`. Failure:
   * resolves with `searched` false when the runs cannot be listed; never
   * rejects for a run it could not stop; never hangs.
   */
  stopTrials(id: string, notBeforeMs: number, timeoutMs: number): Promise<TrialStopResult>;

  /**
   * Approves a playbook so the executor may run it. Deadline: bounded by
   * the caller (milliseconds). Failure: resolves with approved false when
   * the executor declines the approval; rejects with an Error on timeout,
   * cancellation or store failure; never hangs.
   */
  approve(id: string): Promise<{ readonly approved: boolean }>;
}
