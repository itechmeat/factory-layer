/**
 * The brain's typed decisions that gate progress: verdicts over finished
 * tasks, recovery choices for failed ones, the playbook and task-failure
 * shapes the brain and the trace share, and the pure budget rules over task
 * attempts and the run's runtime re-plans.
 */

import { z } from 'zod';

// ---- verdicts ----

/** What the judge decided about a finished task. A reject names reasons. */
export type Verdict =
  | { readonly outcome: 'accept' }
  | { readonly outcome: 'reject'; readonly reasons: readonly string[]; readonly failedCheckIds: readonly string[] };

// ---- recovery choices ----

/**
 * What the brain chose to do with a failed attempt. Every choice carries what
 * its command needs: a retry its hint, a rebind the target profile and a
 * hint, a repair the failing checks, a give up the reason.
 */
export type RecoveryChoice =
  | { readonly choice: 'retry'; readonly hint: string }
  | { readonly choice: 'rebind'; readonly profile: string; readonly hint: string }
  | { readonly choice: 'repair'; readonly failingCheckIds: readonly string[] }
  | { readonly choice: 'replan' }
  | { readonly choice: 'give_up'; readonly reason: string };

export const RecoveryChoiceSchema: z.ZodType<RecoveryChoice> = z.discriminatedUnion('choice', [
  z.object({ choice: z.literal('retry'), hint: z.string().min(1) }),
  z.object({ choice: z.literal('rebind'), profile: z.string().min(1), hint: z.string().min(1) }),
  z.object({ choice: z.literal('repair'), failingCheckIds: z.array(z.string()).min(1) }),
  z.object({ choice: z.literal('replan') }),
  z.object({ choice: z.literal('give_up'), reason: z.string().min(1) }),
]);

// ---- playbooks ----

/** A playbook the brain proposes, before the authoring port stores it. */
export interface PlaybookDraft {
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

/** A stored playbook's identity. */
export interface PlaybookRef {
  readonly id: string;
  readonly name: string;
}

/** A stored playbook with its full content. */
export interface Playbook extends PlaybookRef {
  readonly content: string;
}

// ---- task failure and history ----

/** Why a task failed, as the brain and the trace see it. */
export interface TaskFailure {
  readonly taskId: string;
  readonly revision: number;
  readonly attempt: number;
  readonly nodeId: string | null; // failing executor node, when known
  readonly reason: string; // stable machine reason (e.g. 'verdict_rejected', 'node_failed', 'stalled')
  readonly detail: string; // human-readable, redacted
  readonly failingCheckIds: readonly string[];
}

/** The persisted shape of a task failure (a re-plan intent holds one). */
export const TaskFailureSchema = z.object({
  taskId: z.string().min(1),
  revision: z.number().int().positive(),
  attempt: z.number().int().positive(),
  nodeId: z.string().nullable(),
  reason: z.string(),
  detail: z.string(),
  failingCheckIds: z.array(z.string()),
});

/** One past event of a task, input to chooseRecovery. */
export interface TaskHistoryEntry {
  readonly at: string;
  readonly kind: 'dispatched' | 'recovered' | 'rejected' | 'failed_check' | 'executor_failure';
  readonly detail: string;
}

// ---- budgets ----

/**
 * How many attempts a task has spent and how many runtime re-plans the run has spent;
 * the budgets are the run's resolved limits (resolveRunLimits), never the
 * bare constants.
 */
export interface BudgetState {
  readonly attemptsUsed: number;
  readonly attemptBudget: number;
  readonly replansUsed: number;
  readonly replanBudget: number;
}

/** What the budget rules allow next: another recovery, and a re-plan. */
export interface BudgetReport {
  readonly recoveryLeft: boolean;
  readonly replanAvailable: boolean;
}

/** Recovery remains while attempts are left; a re-plan is available while the run has spent fewer than its budget. */
export function budgetReport(state: BudgetState): BudgetReport {
  return {
    recoveryLeft: state.attemptsUsed < state.attemptBudget,
    replanAvailable: state.replansUsed < state.replanBudget,
  };
}
