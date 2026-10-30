/**
 * What every orchestration module of one run shares: the ports, the single
 * state writer, the trace, the decider, the resolved limits, the executor
 * leases, the run's cancellation signal, the cutoff, the task runners the
 * scheduler keeps, the work signal of each task (aborted when a runtime
 * re-plan supersedes the task's runner) and the in-memory bookkeeping that
 * is not part of the persisted state (task histories, the last check results
 * per task). Also the runtime re-plan seam.
 */

import type { CheckResult, ExecutorRunRef, RunLimits, TaskFailure, TaskHistoryEntry } from '../domain';
import type {
  Brain,
  CheckRunner,
  Clock,
  CostTable,
  ExecutionSlots,
  Executor,
  Memory,
  PlaybookAuthoring,
  RunStore,
  Sleep,
  TraceSink,
  Workspace,
} from '../ports';

import type { Decider } from './decide';
import type { IntegrationQueue } from './integration-queue';
import type { RunOwner } from './run-owner';
import type { Lease, RunSlots } from './run-slots';
import type { RunTrace } from './run-trace';

/** Every port one factory run talks through; the CLI composes them. */
export interface FactoryPorts {
  readonly brain: Brain;
  readonly executor: Executor;
  readonly playbooks: PlaybookAuthoring;
  readonly memory: Memory;
  readonly sink: TraceSink;
  readonly store: RunStore;
  readonly workspace: Workspace;
  readonly checks: CheckRunner;
  readonly costs: CostTable;
  readonly slots: ExecutionSlots;
  readonly clock: Clock;
  readonly sleep: Sleep;
}

/**
 * A task that asks for the run's runtime re-plan, with the failure that made
 * it ask and its last executor run (live or finished; null when it has none).
 */
export interface ReplanRequest {
  readonly taskId: string;
  readonly failure: TaskFailure;
  readonly lastRun: ExecutorRunRef | null;
}

/**
 * The runtime re-plan seam. Called from the asking task's runner with the
 * asker's run possibly still live; it owns everything after that (spending
 * the allowance, pausing dispatch, stopping every live run of a task that is
 * not integrated, the asker's included, the decision, the new revisions)
 * and resolves once the asking task has been either replaced or failed.
 */
export interface ReplanHook {
  requestReplan(ctx: RunContext, request: ReplanRequest): Promise<void>;
}

/** The work of one task runner: its own controller (a re-plan aborts it) and the signal every wait of the runner honours. */
interface TaskWork {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
}

export interface RunContext {
  readonly ports: FactoryPorts;
  readonly owner: RunOwner;
  readonly trace: RunTrace;
  readonly decider: Decider;
  readonly limits: RunLimits;
  readonly slots: RunSlots;
  /** The lease of every executor run that still holds one, by executor run id. */
  readonly leases: Map<string, Lease>;
  /** Aborted when the run must end at once (storage failure); waits and decisions end with it. */
  readonly signal: AbortSignal;
  /** Aborted at the run's cutoff (its time passed or the caller cancelled the run). */
  readonly cutoff: AbortController;
  readonly history: Map<string, TaskHistoryEntry[]>;
  /** The last check results of each task (task scope or integration), with their reasons for repair runs. */
  readonly lastChecks: Map<string, readonly CheckResult[]>;
  readonly integrations: IntegrationQueue;
  readonly replan: ReplanHook;
  /** The runner of each task the scheduler started and that has not ended yet. */
  readonly runners: Map<string, Promise<void>>;
  /** The work signal of each task runner. */
  readonly work: Map<string, TaskWork>;
}

/** True from the run's cutoff on: no dispatch, recovery, re-plan or integration starts. */
export function cutoffPassed(ctx: RunContext): boolean {
  const at = ctx.owner.state.cutoffAtMs;
  return ctx.cutoff.signal.aborted || (at !== null && ctx.trace.nowMs() >= at);
}

/** Starts the work of a new runner of the task: a fresh controller. */
export function beginTaskWork(ctx: RunContext, taskId: string): void {
  const controller = new AbortController();
  ctx.work.set(taskId, { controller, signal: AbortSignal.any([ctx.signal, ctx.cutoff.signal, controller.signal]) });
}

/** The signal every wait of the task's runner honours: the run's abort, the cutoff and the task's supersession. */
export function taskSignal(ctx: RunContext, taskId: string): AbortSignal {
  const work = ctx.work.get(taskId);
  if (work !== undefined) {
    return work.signal;
  }
  beginTaskWork(ctx, taskId);
  return taskSignal(ctx, taskId);
}

/** Aborts the work of the tasks' runners: a re-plan took them over. */
export function supersede(ctx: RunContext, taskIds: readonly string[]): void {
  for (const taskId of taskIds) {
    ctx.work.get(taskId)?.controller.abort();
  }
}

/** True when a re-plan took the task's runner over. */
export function superseded(ctx: RunContext, taskId: string): boolean {
  return ctx.work.get(taskId)?.controller.signal.aborted === true;
}

/** True when the task's runner must end now without changing the task: the cutoff passed or a re-plan took it over. */
export function halted(ctx: RunContext, taskId: string): boolean {
  return superseded(ctx, taskId) || cutoffPassed(ctx);
}

/**
 * True (and traced as discarded) when a result of the task arrived after a
 * re-plan took its runner over; the caller drops the result.
 */
export function discardedAsStale(ctx: RunContext, taskId: string, what: string): boolean {
  if (!superseded(ctx, taskId)) {
    return false;
  }
  ctx.trace.emit({
    type: 'stale_result_discarded',
    ...ctx.owner.correlation(taskId),
    detail: `${what} of revision ${ctx.owner.task(taskId).revision} arrived after a re-plan took the task over`,
  });
  return true;
}

/** True while a runtime re-plan is in progress (its intent is saved): dispatch pauses. */
export function replanInProgress(ctx: RunContext): boolean {
  return ctx.owner.state.intents.some((intent) => intent.kind === 'replan');
}

/** The latest executor run of the task's current revision, or undefined when it has none. */
export function latestRun(ctx: RunContext, taskId: string): ExecutorRunRef | undefined {
  const revision = ctx.owner.task(taskId).revision;
  const runs = Object.values(ctx.owner.state.runs).filter((run) => run.taskId === taskId && run.revision === revision);
  return runs.reduce<ExecutorRunRef | undefined>(
    (last, run) => (last === undefined || run.attempt >= last.attempt ? run : last),
    undefined,
  );
}

/** Frees the lease of an executor run, if it still holds one. */
export function releaseLease(ctx: RunContext, executorRunId: string): void {
  const lease = ctx.leases.get(executorRunId);
  if (lease !== undefined) {
    ctx.leases.delete(executorRunId);
    ctx.slots.release(lease);
  }
}

/** Appends one entry to the task's history, the input of its recovery decisions. */
export function recordHistory(ctx: RunContext, taskId: string, kind: TaskHistoryEntry['kind'], detail: string): void {
  const entry: TaskHistoryEntry = { at: ctx.trace.now(), kind, detail: ctx.trace.redact(detail) };
  const existing = ctx.history.get(taskId);
  if (existing === undefined) {
    ctx.history.set(taskId, [entry]);
  } else {
    existing.push(entry);
  }
}

/** A failure of the task's current revision and attempt, its detail redacted. */
export function taskFailure(
  ctx: RunContext,
  taskId: string,
  info: { readonly reason: string; readonly detail: string; readonly nodeId?: string | null; readonly failingCheckIds?: readonly string[] },
): TaskFailure {
  const task = ctx.owner.task(taskId);
  return {
    taskId,
    revision: task.revision,
    attempt: Math.max(task.attemptsUsed, 1),
    nodeId: info.nodeId ?? null,
    reason: info.reason,
    detail: ctx.trace.redact(info.detail),
    failingCheckIds: info.failingCheckIds ?? [],
  };
}
