/**
 * Zod schemas of the `apb mcp` results that following and steering a
 * supervised run reads: the `playbook_run` start answer,
 * `supervisor_wait_event`, `run_status`, `runs_list`, `run_stop` and the
 * supervisor commands. Shapes come from the APB 1.0.0-beta.1 MCP surface
 * (its tools publish input schemas only; results were recorded from live
 * calls under `tests/fixtures/apb/`). Unknown fields are kept, so a newer
 * APB that adds fields still parses.
 */

import { z } from 'zod';

/** APB's run statuses (`RunStatus` in apb-engine). */
export const RunStatusSchema = z.enum(['created', 'running', 'paused', 'succeeded', 'failed', 'aborted', 'interrupted']);

/** A run status. */
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** A status for which APB has recorded an outcome. */
export type TerminalRunStatus = 'succeeded' | 'failed' | 'aborted';

/** The statuses for which APB has recorded an outcome. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<TerminalRunStatus>(['succeeded', 'failed', 'aborted']);

/** True when APB has recorded the run's outcome. */
export function isTerminalStatus(status: RunStatus): status is TerminalRunStatus {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * `playbook_run` with `supervise: "self"`: the started run (the token is a
 * secret), or a policy refusal, which APB returns as a normal result (for
 * example `untrusted_requires_acknowledge` when the trust store lacks the
 * playbook or a profile bundle).
 */
export const RunStartSchema = z.union([
  z
    .looseObject({ run_id: z.string().min(1), supervisor_token: z.string().min(1) })
    .transform((start) => ({ kind: 'started' as const, runId: start.run_id, token: start.supervisor_token })),
  z
    .looseObject({ policy_refusal: z.looseObject({ policy: z.string(), detail: z.string().optional() }) })
    .transform(({ policy_refusal: refusal }) => ({
      kind: 'refused' as const,
      policy: refusal.policy,
      detail: refusal.detail ?? 'no detail',
    })),
]);

/** The wake of a `supervisor_wait_event`: why APB woke the supervisor. */
const WakeSchema = z.looseObject({
  seq: z.number().int().nonnegative(),
  /** `node_failed`, `node_timeout` or `anomaly` in APB 1.0.0-beta.1; kept open for newer triggers. */
  trigger: z.string(),
  node: z.string().nullable(),
  detail: z.string().nullable().optional(),
});

/** A run parked for its supervisor after a wake: the node and trigger it waits on. */
const PendingSupervisorSchema = z.looseObject({ node: z.string().optional(), trigger: z.string().optional() });

/** `supervisor_wait_event`. `pending_tasks` is absent unless a host task waits. */
export const SupervisorWaitSchema = z.looseObject({
  reason: z.enum(['wake', 'review', 'host_task', 'ended', 'timeout']),
  run_status: RunStatusSchema,
  next_after_seq: z.number().int().nonnegative().nullable(),
  wake: WakeSchema.nullable().optional(),
  pending_review: z.unknown().nullable(),
  pending_supervisor: PendingSupervisorSchema.nullable(),
  pending_tasks: z.unknown().optional(),
});

/** A `supervisor_wait_event` answer. */
export type SupervisorWait = z.infer<typeof SupervisorWaitSchema>;

/** `run_status`, reduced to what the stop path reads. `driver_alive` is null when no driver holds the run. */
export const RunStatusAnswerSchema = z.looseObject({
  run_id: z.string(),
  run_status: RunStatusSchema,
  driver_alive: z.boolean().nullable(),
  /** The run's working tree as an absolute path; null for the project root. */
  worktree: z.string().nullable(),
});

/** `runs_list`: every run of the workspace, newest first; `started_ts` is wall-clock milliseconds. */
export const RunsListSchema = z.array(z.looseObject({ run_id: z.string(), playbook: z.string(), started_ts: z.number() }));

/** `run_stop`. */
export const RunStopSchema = z.looseObject({
  outcome: z.string(),
});

/** `supervisor_context_append`, `supervisor_node_retry`, `supervisor_rebind_profile`: posted, not applied. */
export const CommandPostSchema = z.looseObject({ posted_seq: z.number().int().nonnegative() });
