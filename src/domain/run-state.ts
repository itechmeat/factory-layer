/**
 * The persisted run state: everything a resume needs, executor supervision
 * tokens included. Invariant: every side effect in progress is bracketed as
 * an intent in `intents` before it starts and is removed or replaced by its
 * result after it finishes, so a restart can reconcile exactly what was in
 * flight; the state is saved on every change and validated when read back.
 */

import { z } from 'zod';

import { AcceptanceCheckSchema, CheckResultSchema } from './acceptance';
import { TaskFailureSchema } from './decisions';
import { RunOptionsSchema } from './limits';
import { PlanSchema } from './plan';
import { SpecSchema } from './spec';
import { TaskRunStateSchema } from './task';

// ---- run outcome ----

/** How a run ends: every task integrated, some failed, or the delivery aborted. */
export const RUN_OUTCOMES = ['succeeded', 'partial', 'failed'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export const RunOutcomeSchema = z.enum(RUN_OUTCOMES);

// ---- dispatch keys ----

/** `${factoryRunId}|${taskId}|r${revision}|a${attempt}` */
export type DispatchKey = string;

/** Builds the idempotency key of one task attempt within a run. */
export function makeDispatchKey(factoryRunId: string, taskId: string, revision: number, attempt: number): DispatchKey {
  return `${factoryRunId}|${taskId}|r${revision}|a${attempt}`;
}

const DispatchKeySchema = z.string();

// ---- stop purposes and re-plan phases ----

/** Why the factory stopped an executor run. */
export const STOP_PURPOSES = ['recovery', 'give_up', 'budget_spent', 'replan', 'cutoff', 'orphan', 'storage'] as const;
/** Why the factory stopped an executor run, as a type. */
export type StopPurpose = (typeof STOP_PURPOSES)[number];

/** Where a runtime re-plan is when a stop is part of one. */
export const REPLAN_PHASES = ['stopping_runs', 'asking_brain', 'validating'] as const;
/** Where a runtime re-plan is, as a type. */
export type ReplanPhase = (typeof REPLAN_PHASES)[number];

// ---- dispatch requests ----

/** The roles of an executor run: the task's own run, a repair run, a conflict resolution. */
export const EXECUTOR_RUN_ROLES = ['task', 'repair', 'integrate'] as const;

/**
 * What one executor run of a task is started with (role, playbook, typed
 * inputs), persisted so a resume can start the same run again.
 */
export const DispatchRequestSchema = z.object({
  taskId: z.string().min(1),
  role: z.enum(EXECUTOR_RUN_ROLES),
  playbook: z.string().min(1),
  inputs: z.object({
    taskText: z.string(),
    ownedPaths: z.array(z.string()),
    failingChecks: z.array(z.object({ id: z.string(), reason: z.string() })).optional(),
    conflictPaths: z.array(z.string()).optional(),
  }),
});
/** A persisted dispatch request, as a type. */
export type DispatchRequestRecord = z.infer<typeof DispatchRequestSchema>;

// ---- intents (brackets of side effects in progress) ----

/** Step fields: `posting` is saved before the post call, `postedSeq` once the adapter accepted it. */
const stepFields = {
  posting: z.boolean().optional(),
  postedSeq: z.number().int().nonnegative().optional(),
};

/**
 * One posting step of a recovery command, in execution order. A step with
 * `posting` and no `postedSeq` was in flight when the process stopped: its
 * posting is indeterminate.
 */
const CommandStepSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal('append_context'), ...stepFields }),
  z.object({ step: z.literal('rebind_node'), ...stepFields }),
  z.object({ step: z.literal('retry_node'), ...stepFields }),
]);
/** One step of a supervisor command, as a type. */
export type CommandStep = z.infer<typeof CommandStepSchema>;

const taskAttemptFields = {
  taskId: z.string().min(1),
  revision: z.number().int().positive(),
  attempt: z.number().int().positive(),
};

/**
 * What a confirmed stop leads to: the recovery decision of a stopped
 * failure (`resume_recovery` with the failure), a repair run already chosen
 * (`start_repair` with its request; `consumesAttempt` false when a command
 * already consumed the attempt), a failed task, the re-plan or the cutoff
 * going on, the replacement of an orphan, or nothing.
 */
const StopContinuationSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('resume_recovery'), ...taskAttemptFields, reason: z.string(), detail: z.string() }),
  z.object({ do: z.literal('start_repair'), ...taskAttemptFields, request: DispatchRequestSchema, consumesAttempt: z.boolean() }),
  z.object({ do: z.literal('mark_failed'), taskId: z.string().min(1), reason: z.string() }),
  z.object({ do: z.literal('continue_replan'), phase: z.enum(REPLAN_PHASES) }),
  z.object({ do: z.literal('continue_cutoff') }),
  z.object({ do: z.literal('dispatch_replacement'), ...taskAttemptFields, request: DispatchRequestSchema }),
  z.object({ do: z.literal('none'), detail: z.string() }),
]);
/** What follows a confirmed stop, as a type. */
export type StopContinuation = z.infer<typeof StopContinuationSchema>;

/** One side effect appended before it starts and finished after it completes; resume walks these. */
const RunIntentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('start'),
    dispatchKey: DispatchKeySchema,
    taskId: z.string().min(1),
    revision: z.number().int().positive(),
    attempt: z.number().int().positive(),
    playbook: z.string(),
    tree: z.string(),
    at: z.iso.datetime(),
    request: DispatchRequestSchema,
  }),
  z.object({
    kind: z.literal('command'),
    executorRunId: z.string().min(1),
    taskId: z.string().min(1),
    revision: z.number().int().positive(),
    attempt: z.number().int().positive(),
    choice: z.enum(['retry', 'rebind']),
    nodeId: z.string(),
    hint: z.string().nullable(),
    profile: z.string().nullable(),
    steps: z.array(CommandStepSchema),
  }),
  z.object({
    kind: z.literal('stop'),
    executorRunId: z.string().min(1),
    taskId: z.string().nullable(),
    purpose: z.enum(STOP_PURPOSES),
    continuation: StopContinuationSchema,
    requestedAt: z.iso.datetime(),
    confirmed: z.boolean().default(false), // the stop is confirmed and its continuation not yet performed
  }),
  z.object({
    kind: z.literal('integrate'),
    taskId: z.string().min(1),
    revision: z.number().int().positive(),
    commit: z.string().min(1),
    base: z.string().min(1),
    checks: z.array(CheckResultSchema).default([]), // the acceptance results `main` gets as its baseline
  }),
  z.object({ kind: z.literal('deliver'), at: z.iso.datetime() }),
  z.object({
    kind: z.literal('replan'),
    taskId: z.string().min(1),
    failure: TaskFailureSchema,
    phase: z.enum(REPLAN_PHASES),
    at: z.iso.datetime(),
  }),
]);
/** What the run is about to do next, as a type. */
export type RunIntent = z.infer<typeof RunIntentSchema>;

// ---- supervised executor runs ----

/** A live or finished executor run the factory supervises; the supervisor token lives ONLY here, never in the trace. */
export const ExecutorRunRefSchema = z.object({
  executorRunId: z.string().min(1),
  taskId: z.string().min(1),
  revision: z.number().int().positive(),
  attempt: z.number().int().positive(),
  dispatchKey: DispatchKeySchema,
  playbook: z.string().min(1),
  tree: z.string().min(1),
  role: z.enum(EXECUTOR_RUN_ROLES),
  supervisorToken: z.string().optional(),
  cursor: z.number().int().nonnegative(), // last event seq consumed
  lastEventAt: z.iso.datetime(), // for the stall limit
  state: z.enum(['live', 'succeeded', 'failed', 'aborted', 'stopped', 'unconfirmed']),
  driverHeld: z.boolean().optional(), // a run that ended by itself whose driver release is not confirmed yet
});
export type ExecutorRunRef = z.infer<typeof ExecutorRunRefSchema>;

// ---- the state ----

/** Everything a resume needs: the inputs, the plan, the task and run bookkeeping, the intents, the outcome. */
export const RunStateSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  spec: SpecSchema,
  plan: PlanSchema,
  acceptanceChecks: z.array(AcceptanceCheckSchema),
  acceptanceUnavailable: z.boolean(), // the acceptance decision failed for the last time
  options: RunOptionsSchema,
  cutoffAtMs: z.number().int().positive().nullable(), // absolute deadline, epoch ms
  replansUsed: z.number().int().nonnegative(), // runtime re-plans spent, against the run's re-plan budget
  tasks: z.record(z.string(), TaskRunStateSchema),
  runs: z.record(z.string(), ExecutorRunRefSchema),
  intents: z.array(RunIntentSchema),
  abandonedTrees: z.array(z.object({ playbook: z.string(), tree: z.string(), at: z.iso.datetime() })).default([]),
  lastMainChecks: z.array(CheckResultSchema).nullable(), // last check results recorded for main
  outcome: RunOutcomeSchema.nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});
export type RunState = z.infer<typeof RunStateSchema>;
