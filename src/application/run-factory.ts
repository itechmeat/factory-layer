/**
 * The RunFactory use case: one spec in, one outcome out (succeeded, partial
 * or failed) with the delivered directory. `run` validates the request at
 * the boundary, resolves the run's limits from its options (the
 * orchestration uses those, never the bare constants), plans the run
 * (run-start.ts), creates the run state and its single writer, prepares the
 * spec's repository, runs the scheduler to the end of every task, delivers,
 * and records the outcome in the state, the trace and memory. `resume`
 * loads a saved run state and continues it: every intent is reconciled
 * (resume.ts) before the scheduler and delivery run as for a new run.
 *
 * The run's cutoff (an absolute instant, or the caller's signal, which sets
 * it to now) cancels pending decisions and waits, stops the live runs and
 * starts delivery (cutoff.ts); a cutoff reached during planning ends the run
 * as failed. A save that fails stops every live executor run, traces the
 * storage failure when the trace still accepts it, and ends the run as
 * failed; any other unexpected error ends it the same way. Every executor
 * lease still held is released when the run ends.
 */

import {
  RunOptionsSchema,
  SpecSchema,
  resolveRunLimits,
  topologicalOrder,
  type RunLimits,
  type RunOptionsInput,
  type RunOutcome,
  type RunState,
  type Spec,
} from '../domain';
import type { RunOutcomeRecord } from '../ports';

import { saveCancellation, watchCutoff } from './cutoff';
import { Decider } from './decide';
import { decideOutcome, deliverRun } from './delivery';
import { IntegrationQueue } from './integration-queue';
import { serializedReplan } from './replan';
import { resumeRun } from './resume';
import type { FactoryPorts, ReplanHook, RunContext } from './run-context';
import { rememberOutcome } from './run-memory';
import { RunOwner, StorageFailure } from './run-owner';
import { RunSlots } from './run-slots';
import { planRun } from './run-start';
import { RunTrace } from './run-trace';
import { runSchedule } from './scheduler';
import { stopAllWithoutState } from './stops';

/**
 * One run to make: its id, the spec, the caller's options, an optional
 * absolute cutoff (epoch ms) and an optional cancellation whose abort sets
 * the cutoff to now (the run still stops its executor runs and delivers).
 */
export interface RunRequest {
  readonly runId: string;
  readonly spec: Spec;
  readonly options?: RunOptionsInput;
  readonly cutoffAtMs?: number | null;
  readonly signal?: AbortSignal;
}

/** How a saved run continues: an optional cancellation that sets its cutoff to now. */
export interface ResumeOptions {
  readonly signal?: AbortSignal;
}

/** How the run ended: the outcome, why it fell short, and where the tree went (null when nothing was copied). */
export interface RunResult {
  readonly runId: string;
  readonly outcome: RunOutcome;
  readonly reason: string | null;
  readonly deliveredDir: string | null;
  readonly verified: boolean;
}

/** The orchestration seams a caller may replace, and what the factory must know but never save. */
export interface RunFactoryHooks {
  readonly replan?: ReplanHook;
  /**
   * The values every trace write redacts (the provider keys). They live
   * only in memory: the run state never holds them, so a resumed run gets
   * them again from its caller.
   */
  readonly secrets?: readonly string[];
}

/** What the end of a run reports, before it is traced and remembered. */
interface Ending {
  readonly outcome: RunOutcome;
  readonly reason: string | null;
  readonly deliveredDir: string | null;
  readonly verified: boolean;
  readonly failedCheckIds: readonly string[];
}

/** The parts of a run that exist before its state: the trace, the abort and cutoff controllers, the decider. */
interface Session {
  readonly trace: RunTrace;
  readonly limits: RunLimits;
  readonly controller: AbortController;
  readonly cutoff: AbortController;
  readonly decider: Decider;
  readonly startedAt: string;
}

export class RunFactory {
  private readonly ports: FactoryPorts;
  private readonly replan: ReplanHook;
  private readonly secrets: readonly string[];

  constructor(ports: FactoryPorts, hooks: RunFactoryHooks = {}) {
    this.ports = ports;
    this.replan = hooks.replan ?? serializedReplan;
    this.secrets = hooks.secrets ?? [];
  }

  /** Runs the spec to its outcome; never rejects for a failure the run can record. */
  async run(request: RunRequest): Promise<RunResult> {
    const spec = SpecSchema.parse(request.spec);
    const options = RunOptionsSchema.parse(request.options ?? {});
    const session = this.session(request.runId, spec, resolveRunLimits(options));
    const { trace } = session;
    trace.emit({ type: 'run_started', specName: spec.name });
    let ctx: RunContext | null = null;
    const unwatch = watchCutoff({
      cutoff: session.cutoff,
      atMs: request.cutoffAtMs ?? null,
      sleep: this.ports.sleep,
      nowMs: () => trace.nowMs(),
      signal: request.signal,
      onCancel: (atMs) => {
        if (ctx !== null) {
          saveCancellation(ctx, atMs);
        }
      },
    });
    const signal = AbortSignal.any([session.controller.signal, session.cutoff.signal]);
    const planning = await planRun({
      spec,
      brain: this.ports.brain,
      memory: this.ports.memory,
      sleep: this.ports.sleep,
      trace,
      decider: session.decider,
      signal,
    });
    if (!planning.ok || session.cutoff.signal.aborted) {
      unwatch();
      const reason = session.cutoff.signal.aborted ? 'cutoff: reached during planning' : planning.ok ? null : planning.reason;
      if (session.cutoff.signal.aborted) {
        trace.emit({ type: 'cutoff_reached' });
      }
      return this.end(session, request.runId, spec, null, {
        outcome: 'failed',
        reason,
        deliveredDir: null,
        verified: false,
        failedCheckIds: [],
      });
    }
    const state: RunState = {
      schemaVersion: 1,
      runId: request.runId,
      spec,
      plan: planning.plan,
      acceptanceChecks: [...planning.acceptanceChecks],
      acceptanceUnavailable: planning.acceptanceUnavailable,
      options,
      cutoffAtMs: request.cutoffAtMs ?? null,
      replansUsed: 0,
      tasks: Object.fromEntries(
        planning.plan.tasks.map((task) => [task.id, { revision: task.revision, state: 'pending', attemptsUsed: 0 }]),
      ),
      runs: {},
      intents: [],
      abandonedTrees: [],
      lastMainChecks: null,
      outcome: null,
      startedAt: session.startedAt,
      endedAt: null,
    };
    ctx = this.context(session, state);
    return this.carryOut(session, ctx, unwatch, false);
  }

  /**
   * Continues a saved run from its state; never rejects for a failure the
   * run can record. A run with no saved state fails without a trace; a run
   * that already ended returns its recorded outcome.
   */
  async resume(runId: string, options: ResumeOptions = {}): Promise<RunResult> {
    const state = await this.ports.store.load(runId);
    if (state === null) {
      return { runId, outcome: 'failed', reason: 'resume_unavailable: no saved state', deliveredDir: null, verified: false };
    }
    if (state.outcome !== null) {
      return { runId, outcome: state.outcome, reason: 'the run already ended', deliveredDir: null, verified: false };
    }
    const session = this.session(runId, state.spec, resolveRunLimits(state.options), state.startedAt);
    session.trace.emit({ type: 'run_started', specName: state.spec.name });
    const ctx = this.context(session, state);
    const unwatch = watchCutoff({
      cutoff: session.cutoff,
      atMs: state.cutoffAtMs,
      sleep: this.ports.sleep,
      nowMs: () => session.trace.nowMs(),
      signal: options.signal,
      onCancel: (atMs) => {
        saveCancellation(ctx, atMs);
      },
    });
    return this.carryOut(session, ctx, unwatch, true);
  }

  private session(runId: string, spec: Spec, limits: RunLimits, startedAt?: string): Session {
    const { ports } = this;
    const trace = new RunTrace({ sink: ports.sink, clock: ports.clock, runId, specName: spec.name, secrets: this.secrets });
    const controller = new AbortController();
    const cutoff = new AbortController();
    const decider = new Decider({
      trace,
      sleep: ports.sleep,
      costs: ports.costs,
      deadlineMs: limits.brainDecisionDeadlineMs,
      signal: AbortSignal.any([controller.signal, cutoff.signal]),
      // A resumed session prefixes its ids with the resume instant, so they never repeat the ids before the crash.
      ...(startedAt === undefined ? {} : { epoch: `r${trace.nowMs()}` }),
    });
    return { trace, limits, controller, cutoff, decider, startedAt: startedAt ?? trace.now() };
  }

  private context(session: Session, state: RunState): RunContext {
    const owner = new RunOwner({
      state,
      store: this.ports.store,
      trace: session.trace,
      onStorageFailure: () => session.controller.abort(),
    });
    return {
      ports: this.ports,
      owner,
      trace: session.trace,
      decider: session.decider,
      limits: session.limits,
      slots: new RunSlots({ cap: session.limits.runTaskConcurrency, global: this.ports.slots, runId: state.runId }),
      leases: new Map(),
      signal: session.controller.signal,
      cutoff: session.cutoff,
      history: new Map(),
      lastChecks: new Map(),
      integrations: new IntegrationQueue(topologicalOrder(state.plan)),
      replan: this.replan,
      runners: new Map(),
      work: new Map(),
    };
  }

  /** Executes the run with its state, then ends it whatever happened. */
  private async carryOut(session: Session, ctx: RunContext, unwatch: () => void, resuming: boolean): Promise<RunResult> {
    let ending: Ending;
    try {
      ending = await this.execute(ctx, resuming);
    } catch (error) {
      ending = await this.abort(ctx, session.controller, error);
    }
    unwatch();
    ctx.slots.releaseAll();
    return this.end(session, ctx.owner.state.runId, ctx.owner.state.spec, ctx.owner.state, ending);
  }

  /** The run after planning: save, prepare, reconcile on resume, schedule, deliver, record the outcome. */
  private async execute(ctx: RunContext, resuming: boolean): Promise<Ending> {
    const { owner } = ctx;
    await owner.save();
    await this.ports.workspace.prepare(owner.state.spec.name);
    if (resuming) {
      await resumeRun(ctx);
    }
    await runSchedule(ctx);
    const delivery = await deliverRun(ctx);
    const decided = decideOutcome(owner.state, delivery);
    const endedAt = ctx.trace.now();
    await owner.update((state) => {
      state.outcome = decided.outcome;
      state.endedAt = endedAt;
    });
    return { ...decided, deliveredDir: delivery.outDir, verified: delivery.verified, failedCheckIds: delivery.failedCheckIds };
  }

  /** A run that cannot go on: cancel everything, stop every live run, trace why, and fail. */
  private async abort(ctx: RunContext, controller: AbortController, error: unknown): Promise<Ending> {
    controller.abort();
    const storage = error instanceof StorageFailure ? error.message : ctx.owner.storageFailure;
    const detail = storage ?? ctx.trace.redact(error instanceof Error ? error.message : String(error));
    await stopAllWithoutState(ctx, storage === null ? 'run_error' : 'storage');
    if (storage === null) {
      await this.recordFailedOutcome(ctx);
    } else {
      try {
        ctx.trace.emit({ type: 'storage_failed', reason: storage });
      } catch {
        // The trace refused the event too; the outcome below still says why the run failed.
      }
    }
    const reason = storage === null ? `run_error: ${detail}` : `storage_failed: ${detail}`;
    return { outcome: 'failed', reason, deliveredDir: null, verified: false, failedCheckIds: [] };
  }

  /** Records the failed outcome in the state when it can still be saved. */
  private async recordFailedOutcome(ctx: RunContext): Promise<void> {
    const endedAt = ctx.trace.now();
    try {
      await ctx.owner.update((state) => {
        state.outcome = 'failed';
        state.endedAt = endedAt;
      });
    } catch {
      // A state that cannot be saved any more changes nothing about the outcome returned.
    }
  }

  /** Traces the end (a refusing trace is ignored), remembers the outcome (bounded), and returns the result. */
  private async end(session: Session, runId: string, spec: Spec, state: Readonly<RunState> | null, ending: Ending): Promise<RunResult> {
    const { trace } = session;
    try {
      trace.emit({ type: 'run_ended', outcome: ending.outcome, reason: ending.reason === null ? null : trace.redact(ending.reason) });
    } catch {
      // A trace that refuses the last event changes nothing about the outcome remembered and returned below.
    }
    const plan = state?.plan ?? null;
    const record: RunOutcomeRecord = {
      runId,
      specName: spec.name,
      outcome: ending.outcome,
      planSummary: plan === null ? 'no plan' : plan.tasks.map((task) => `${task.id}: ${task.title}`).join('; '),
      tasks: Object.entries(state?.tasks ?? {}).map(([taskId, task]) => ({
        taskId,
        revision: task.revision,
        integrated: task.state === 'integrated',
        attempts: task.attemptsUsed,
      })),
      failedCheckIds: ending.failedCheckIds,
      durationMs: trace.nowMs() - Date.parse(session.startedAt),
    };
    await rememberOutcome({ memory: this.ports.memory, sleep: this.ports.sleep, trace, record });
    return { runId, outcome: ending.outcome, reason: ending.reason, deliveredDir: ending.deliveredDir, verified: ending.verified };
  }
}
