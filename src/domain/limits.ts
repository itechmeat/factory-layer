/**
 * The factory's tunables: every deadline, budget, cap and window as a named
 * constant with its unit in the name, plus the per-run options a caller may
 * set, validated at the boundary with the factory's defaults filled in, and
 * the resolution of a run's budget and limit overrides over the constants.
 */

import { z } from 'zod';

/** One brain decision attempt. */
export const BRAIN_DECISION_DEADLINE_MS = 90_000;
/** How long an aborted brain call may take to settle before the attempt is abandoned as timed out. */
export const BRAIN_ABORT_GRACE_MS = 5_000;
/** Retries after a failed brain decision attempt. */
export const BRAIN_DECISION_RETRIES = 2;
/**
 * Retries of the initial plan: without a plan the run ends at once, so a
 * provider that hangs (the next attempt goes to the fallback) gets more chances.
 */
export const BRAIN_PLAN_RETRIES = 5;
/** Attempts per task: the first try plus this many recoveries. */
export const TASK_ATTEMPT_BUDGET = 3;
/** Runtime re-plans per run (a correction of an invalid first plan is separate). */
export const RUN_REPLAN_BUDGET = 1;
/** Task runs dispatched at the same time within one factory run. */
export const RUN_TASK_CONCURRENCY = 3;
/** One bounded wait for an executor event. */
export const EXECUTOR_WAIT_SLICE_MS = 60_000;
/** A run with no event for this long counts as stalled. */
export const EXECUTOR_STALL_LIMIT_MS = 600_000;
/** How long a confirmed executor stop may take. */
export const EXECUTOR_STOP_DEADLINE_MS = 60_000;
/** Executor runs live at the same time across all factory runs. */
export const GLOBAL_EXECUTOR_RUNS = 4;
/** One memory recall or remember call. */
export const MEMORY_DEADLINE_MS = 10_000;
/** How long an unconfirmed start may still surface its run. */
export const EXECUTOR_SETTLE_WINDOW_MS = 120_000;
/** The pause between two lookups of an indeterminate start inside the settle window. */
export const EXECUTOR_LOOKUP_INTERVAL_MS = 10_000;
/** One executor call that has no bound of its own (start, lookup, report, command posts). */
export const EXECUTOR_CALL_DEADLINE_MS = 60_000;
/** How much longer than its own bound (slice or stop deadline) an executor call may take before the core gives up on it. */
export const EXECUTOR_GRACE_MS = 5_000;
/** Past runs one memory recall asks for. */
export const MEMORY_RECALL_LIMIT = 5;
/** Captured check output kept per stream, in bytes. */
export const CHECK_OUTPUT_LIMIT_BYTES = 65_536;
/** How long an HTTP server of the acceptance checks may take to start. */
export const HTTP_SERVER_START_TIMEOUT_MS = 15_000;
/** One package install of the check runner (longer than a check: it may download). */
export const PACKAGE_INSTALL_TIMEOUT_MS = 300_000;
/** One git command of the workspace adapter. */
export const GIT_COMMAND_TIMEOUT_MS = 60_000;

/** Package managers a delivery must install, build and test under. */
export const RUNTIMES = ['bun', 'npm'] as const;
export type Runtime = (typeof RUNTIMES)[number];
export const RuntimeSchema = z.enum(RUNTIMES);

/**
 * What a caller of a run may tune; parsing fills the factory's defaults. The
 * budget and limit overrides stay absent unless given: resolveRunLimits
 * fills them from the constants above. The options are saved with the run
 * state, so they never hold a secret.
 */
export const RunOptionsSchema = z.object({
  requiredRuntimes: z.array(RuntimeSchema).min(1).default(['bun']),
  deliverUnverified: z.boolean().default(false),
  outDir: z.string().min(1).optional(),
  taskAttemptBudget: z.int().min(1).optional(),
  runReplanBudget: z.int().min(0).optional(),
  runTaskConcurrency: z.int().min(1).optional(),
  executorStallLimitMs: z.int().positive().optional(),
  brainDecisionDeadlineMs: z.int().positive().optional(),
});
/** The parsed options, defaults filled. */
export type RunOptions = z.infer<typeof RunOptionsSchema>;
/** The options as a caller passes them: partial, before the defaults. */
export type RunOptionsInput = z.input<typeof RunOptionsSchema>;

/** The budgets and limits one run works under: its overrides over the factory constants. */
export interface RunLimits {
  readonly taskAttemptBudget: number;
  readonly runReplanBudget: number;
  readonly runTaskConcurrency: number;
  readonly executorStallLimitMs: number;
  readonly brainDecisionDeadlineMs: number;
}

/** Resolves a run's budgets and limits: each override when given, else its constant. */
export function resolveRunLimits(options: RunOptions): RunLimits {
  return {
    taskAttemptBudget: options.taskAttemptBudget ?? TASK_ATTEMPT_BUDGET,
    runReplanBudget: options.runReplanBudget ?? RUN_REPLAN_BUDGET,
    runTaskConcurrency: options.runTaskConcurrency ?? RUN_TASK_CONCURRENCY,
    executorStallLimitMs: options.executorStallLimitMs ?? EXECUTOR_STALL_LIMIT_MS,
    brainDecisionDeadlineMs: options.brainDecisionDeadlineMs ?? BRAIN_DECISION_DEADLINE_MS,
  };
}
