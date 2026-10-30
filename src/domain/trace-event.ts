/**
 * The trace events: one validated, redaction-ready record per thing that
 * happened in a run. Every variant carries the correlation base (time, run
 * id, and where they apply spec name, task id, revision, attempt, decision
 * id and kind, executor run id and node id); fields beyond `at` and `runId`
 * are present only where they apply. Executor supervision tokens never
 * appear here, only in the run state.
 */

import { z } from 'zod';

import { CheckResultSchema } from './acceptance';
import type { PlanInvalidReason } from './plan';
import { RunOutcomeSchema } from './run-state';
import { TaskStateSchema } from './task';
import { DECISION_KINDS, UsageRecordSchema } from './usage';

/**
 * Validates the plan rejection reasons a trace carries. Typed to plan's
 * PlanInvalidReason, so the schema cannot drift from the values validatePlan
 * produces; it lives here because plan.ts keeps its reasons as plain values.
 */
const PlanInvalidReasonSchema: z.ZodType<PlanInvalidReason> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('duplicate_id'), taskId: z.string() }),
  z.object({ kind: z.literal('unknown_dependency'), taskId: z.string(), dependsOn: z.string() }),
  z.object({ kind: z.literal('cycle'), taskIds: z.array(z.string()) }),
  z.object({ kind: z.literal('invalid_path'), taskId: z.string(), path: z.string() }),
  z.object({
    kind: z.literal('path_overlap'),
    taskIdA: z.string(),
    taskIdB: z.string(),
    pathA: z.string(),
    pathB: z.string(),
  }),
]);

/** The correlation every event carries; `at` and `runId` are always present. */
const base = {
  at: z.iso.datetime(),
  runId: z.string().min(1),
  specName: z.string().optional(),
  taskId: z.string().optional(),
  revision: z.number().int().positive().optional(),
  attempt: z.number().int().positive().optional(),
  decisionId: z.string().optional(),
  decisionKind: z.enum(DECISION_KINDS).optional(),
  executorRunId: z.string().optional(),
  nodeId: z.string().optional(),
};

const PLAN_SOURCES = ['initial', 'correction', 'replan'] as const;
const EXECUTOR_ROLES = ['task', 'repair', 'integrate'] as const;

export const TraceEventSchema = z.discriminatedUnion('type', [
  // run framing
  z.object({ ...base, type: z.literal('run_started'), specName: z.string() }),
  z.object({ ...base, type: z.literal('run_ended'), outcome: RunOutcomeSchema, reason: z.string().nullable() }),
  // plan and acceptance decisions
  z.object({ ...base, type: z.literal('plan_produced'), source: z.enum(PLAN_SOURCES), taskCount: z.number().int() }),
  z.object({ ...base, type: z.literal('plan_rejected'), source: z.enum(PLAN_SOURCES), reasons: z.array(PlanInvalidReasonSchema) }),
  z.object({ ...base, type: z.literal('acceptance_produced'), checkIds: z.array(z.string()) }),
  z.object({ ...base, type: z.literal('acceptance_unavailable'), reason: z.string() }),
  z.object({
    ...base,
    type: z.literal('acceptance_check_dropped'),
    checkId: z.string(),
    stage: z.enum(['planning', 'delivery']),
    reason: z.string(),
  }),
  // brain decisions
  z.object({ ...base, type: z.literal('decision_started'), kind: z.enum(DECISION_KINDS) }),
  z.object({
    ...base,
    type: z.literal('decision_ended'),
    kind: z.enum(DECISION_KINDS),
    outcome: z.enum(['answered', 'failed', 'defaulted']),
    usage: z.array(UsageRecordSchema),
    detail: z.string(),
  }),
  // executor supervision
  z.object({
    ...base,
    type: z.literal('executor_started'),
    dispatchKey: z.string(),
    playbook: z.string(),
    tree: z.string(),
    role: z.enum(EXECUTOR_ROLES),
  }),
  z.object({
    ...base,
    type: z.literal('executor_event'),
    kind: z.enum(['wake', 'terminal', 'needs_host', 'quiet']),
    trigger: z.string().nullable(),
    seq: z.number().int().nonnegative(),
    detail: z.string().nullable(),
  }),
  z.object({
    ...base,
    type: z.literal('executor_ended'),
    status: z.string(),
    usage: z.array(UsageRecordSchema),
  }),
  z.object({ ...base, type: z.literal('executor_stopped'), purpose: z.string(), confirmed: z.boolean() }),
  z.object({ ...base, type: z.literal('executor_failure'), reason: z.string() }),
  // checks and verdicts
  z.object({
    ...base,
    type: z.literal('checks_run'),
    scope: z.enum(['task', 'integration', 'delivery']),
    results: z.array(CheckResultSchema),
  }),
  z.object({
    ...base,
    type: z.literal('verdict'),
    outcome: z.enum(['accept', 'reject']),
    reasons: z.array(z.string()),
    failedCheckIds: z.array(z.string()),
  }),
  // recovery
  z.object({ ...base, type: z.literal('recovery_chosen'), choice: z.string(), detail: z.string() }),
  z.object({ ...base, type: z.literal('recovery_command'), step: z.string(), accepted: z.boolean(), detail: z.string() }),
  z.object({ ...base, type: z.literal('task_state_changed'), from: TaskStateSchema, to: TaskStateSchema, reason: z.string() }),
  // integration
  z.object({ ...base, type: z.literal('merge_produced'), commit: z.string(), baseCommit: z.string() }),
  z.object({ ...base, type: z.literal('merge_conflict'), paths: z.array(z.string()) }),
  z.object({ ...base, type: z.literal('main_advanced'), commit: z.string(), baseCommit: z.string() }),
  // cutoff and delivery
  z.object({ ...base, type: z.literal('cutoff_reached') }),
  z.object({
    ...base,
    type: z.literal('delivery_step'),
    step: z.string(),
    runtime: z.string().nullable(),
    ok: z.boolean(),
    detail: z.string(),
  }),
  z.object({ ...base, type: z.literal('delivery_done'), copied: z.boolean(), outDir: z.string().nullable(), verified: z.boolean() }),
  // runtime re-plan
  z.object({ ...base, type: z.literal('replan_started') }),
  z.object({ ...base, type: z.literal('replan_ended'), ok: z.boolean(), detail: z.string() }),
  // odd outcomes and failures
  z.object({ ...base, type: z.literal('orphan_found'), detail: z.string() }),
  z.object({ ...base, type: z.literal('stale_result_discarded'), detail: z.string() }),
  z.object({ ...base, type: z.literal('memory_failed'), phase: z.enum(['recall', 'remember']), reason: z.string() }),
  z.object({ ...base, type: z.literal('storage_failed'), reason: z.string() }),
  z.object({ ...base, type: z.literal('intervention_recorded'), note: z.string() }),
]);
export type TraceEvent = z.infer<typeof TraceEventSchema>;

// One type per variant, so consumers can name the events they handle.

export type RunStartedEvent = Extract<TraceEvent, { type: 'run_started' }>;
export type RunEndedEvent = Extract<TraceEvent, { type: 'run_ended' }>;
export type PlanProducedEvent = Extract<TraceEvent, { type: 'plan_produced' }>;
export type PlanRejectedEvent = Extract<TraceEvent, { type: 'plan_rejected' }>;
export type AcceptanceProducedEvent = Extract<TraceEvent, { type: 'acceptance_produced' }>;
export type AcceptanceUnavailableEvent = Extract<TraceEvent, { type: 'acceptance_unavailable' }>;
export type AcceptanceCheckDroppedEvent = Extract<TraceEvent, { type: 'acceptance_check_dropped' }>;
export type DecisionStartedEvent = Extract<TraceEvent, { type: 'decision_started' }>;
export type DecisionEndedEvent = Extract<TraceEvent, { type: 'decision_ended' }>;
export type ExecutorStartedEvent = Extract<TraceEvent, { type: 'executor_started' }>;
export type ExecutorObservedEvent = Extract<TraceEvent, { type: 'executor_event' }>;
export type ExecutorEndedEvent = Extract<TraceEvent, { type: 'executor_ended' }>;
export type ExecutorStoppedEvent = Extract<TraceEvent, { type: 'executor_stopped' }>;
export type ExecutorFailureEvent = Extract<TraceEvent, { type: 'executor_failure' }>;
export type ChecksRunEvent = Extract<TraceEvent, { type: 'checks_run' }>;
export type VerdictEvent = Extract<TraceEvent, { type: 'verdict' }>;
export type RecoveryChosenEvent = Extract<TraceEvent, { type: 'recovery_chosen' }>;
export type RecoveryCommandEvent = Extract<TraceEvent, { type: 'recovery_command' }>;
export type TaskStateChangedEvent = Extract<TraceEvent, { type: 'task_state_changed' }>;
export type MergeProducedEvent = Extract<TraceEvent, { type: 'merge_produced' }>;
export type MergeConflictEvent = Extract<TraceEvent, { type: 'merge_conflict' }>;
export type MainAdvancedEvent = Extract<TraceEvent, { type: 'main_advanced' }>;
export type CutoffReachedEvent = Extract<TraceEvent, { type: 'cutoff_reached' }>;
export type DeliveryStepEvent = Extract<TraceEvent, { type: 'delivery_step' }>;
export type DeliveryDoneEvent = Extract<TraceEvent, { type: 'delivery_done' }>;
export type ReplanStartedEvent = Extract<TraceEvent, { type: 'replan_started' }>;
export type ReplanEndedEvent = Extract<TraceEvent, { type: 'replan_ended' }>;
export type OrphanFoundEvent = Extract<TraceEvent, { type: 'orphan_found' }>;
export type StaleResultDiscardedEvent = Extract<TraceEvent, { type: 'stale_result_discarded' }>;
export type MemoryFailedEvent = Extract<TraceEvent, { type: 'memory_failed' }>;
export type StorageFailedEvent = Extract<TraceEvent, { type: 'storage_failed' }>;
export type InterventionRecordedEvent = Extract<TraceEvent, { type: 'intervention_recorded' }>;

/**
 * Lookup by event type: the payload type of each trace event variant.
 * @pending Read by the orchestration change, which wires the run loop.
 */
export interface TraceEventTypes {
  run_started: RunStartedEvent;
  run_ended: RunEndedEvent;
  plan_produced: PlanProducedEvent;
  plan_rejected: PlanRejectedEvent;
  acceptance_produced: AcceptanceProducedEvent;
  acceptance_unavailable: AcceptanceUnavailableEvent;
  acceptance_check_dropped: AcceptanceCheckDroppedEvent;
  decision_started: DecisionStartedEvent;
  decision_ended: DecisionEndedEvent;
  executor_started: ExecutorStartedEvent;
  executor_event: ExecutorObservedEvent;
  executor_ended: ExecutorEndedEvent;
  executor_stopped: ExecutorStoppedEvent;
  executor_failure: ExecutorFailureEvent;
  checks_run: ChecksRunEvent;
  verdict: VerdictEvent;
  recovery_chosen: RecoveryChosenEvent;
  recovery_command: RecoveryCommandEvent;
  task_state_changed: TaskStateChangedEvent;
  merge_produced: MergeProducedEvent;
  merge_conflict: MergeConflictEvent;
  main_advanced: MainAdvancedEvent;
  cutoff_reached: CutoffReachedEvent;
  delivery_step: DeliveryStepEvent;
  delivery_done: DeliveryDoneEvent;
  replan_started: ReplanStartedEvent;
  replan_ended: ReplanEndedEvent;
  orphan_found: OrphanFoundEvent;
  stale_result_discarded: StaleResultDiscardedEvent;
  memory_failed: MemoryFailedEvent;
  storage_failed: StorageFailedEvent;
  intervention_recorded: InterventionRecordedEvent;
}
