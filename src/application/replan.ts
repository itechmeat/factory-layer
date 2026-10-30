/**
 * The serialized runtime re-plan (task 3.7), the default of the re-plan
 * seam. Asked by a task whose attempts are spent (or whose recovery chose
 * it), it spends one of the run's re-plans and saves a re-plan intent, which
 * pauses dispatch. Every other task's runner is taken over (its pending
 * decisions are cancelled, a result that still arrives is discarded as
 * stale) and awaited; then every live or held executor run of a task that
 * is not integrated, the asker's included, is stopped and confirmed. The
 * brain is asked for a new plan that keeps every integrated task unchanged;
 * the plan is validated (including that it keeps the integrated tasks), and
 * every task that is not integrated gets a new revision with a fresh budget.
 * When the decision fails, the plan is invalid, or a stop is not confirmed,
 * the allowance stays spent, the asker and every task whose stop was not
 * confirmed fail, a task whose run was stopped goes back to `pending` as a
 * new revision with its remaining attempts (the stop consumes none), and
 * every other task continues under the current plan from its state (a
 * finished run is judged again). The intent records the phase, so a resume
 * continues the re-plan before any dispatch. At the cutoff the re-plan ends
 * and leaves the tasks to the cutoff.
 */

import {
  normalizePath,
  resetForReplan,
  topologicalOrder,
  validatePlan,
  type Plan,
  type PlanTask,
  type ReplanPhase,
  type RunIntent,
  type RunState,
  type TaskState,
} from '../domain';

import {
  cutoffPassed,
  latestRun,
  replanInProgress,
  supersede,
  superseded,
  type ReplanHook,
  type ReplanRequest,
  type RunContext,
} from './run-context';
import { dropConfirmedStops } from './run-owner';
import { isHeld, stopRun } from './stops';

type ReplanIntent = Extract<RunIntent, { kind: 'replan' }>;

/** One task state change the re-plan made directly, traced after the save. */
interface Change {
  readonly taskId: string;
  readonly from: TaskState;
  readonly to: TaskState;
  readonly reason: string;
}

/** The task states a re-plan leaves alone: integrated and failed are final, pending and ready wait for dispatch. */
const UNTOUCHED: readonly TaskState[] = ['integrated', 'failed', 'pending', 'ready'];

/** The default re-plan seam: the serialized re-plan of the module header. */
export const serializedReplan: ReplanHook = {
  async requestReplan(ctx, request) {
    await startReplan(ctx, request);
  },
};

/** Spends the allowance, takes the other runners over, then runs the re-plan. */
async function startReplan(ctx: RunContext, request: ReplanRequest): Promise<void> {
  if (cutoffPassed(ctx) || superseded(ctx, request.taskId) || replanInProgress(ctx)) {
    return;
  }
  const failure = { ...request.failure, failingCheckIds: [...request.failure.failingCheckIds] };
  const intent: ReplanIntent = { kind: 'replan', taskId: request.taskId, failure, phase: 'stopping_runs', at: ctx.trace.now() };
  await ctx.owner.update((state) => {
    state.replansUsed += 1;
    dropConfirmedStops(state, request.taskId);
    state.intents.push(intent);
  });
  ctx.trace.emit({ type: 'replan_started', ...ctx.owner.correlation(request.taskId) });
  const others = [...ctx.runners.entries()].filter(([taskId]) => taskId !== request.taskId);
  supersede(
    ctx,
    others.map(([taskId]) => taskId),
  );
  await Promise.allSettled(others.map(([, runner]) => runner));
  await continueReplan(ctx);
}

/** Runs the saved re-plan from its phase (also on resume); see the module header. */
export async function continueReplan(ctx: RunContext): Promise<void> {
  const intent = ctx.owner.state.intents.find((candidate): candidate is ReplanIntent => candidate.kind === 'replan');
  if (intent === undefined) {
    return;
  }
  const unconfirmed = await stopRunsOfOpenTasks(ctx);
  if (cutoffPassed(ctx)) {
    return endAtCutoff(ctx, intent);
  }
  if (unconfirmed.length > 0) {
    return failReplan(ctx, intent, 'replan_failed', unconfirmed, `stops not confirmed for ${unconfirmed.join(', ')}`);
  }
  await setPhase(ctx, 'asking_brain');
  const { owner } = ctx;
  const integrated = Object.entries(owner.state.tasks)
    .filter(([, task]) => task.state === 'integrated')
    .map(([taskId]) => taskId);
  const decided = await ctx.decider.decide('replan', owner.correlation(intent.taskId), (signal) =>
    ctx.ports.brain.replan(owner.state.spec, owner.state.plan, intent.failure, integrated, signal),
  );
  if (cutoffPassed(ctx)) {
    return endAtCutoff(ctx, intent);
  }
  if (!decided.ok) {
    return failReplan(ctx, intent, 'replan_unavailable', [], `the re-plan decision failed: ${decided.failure.detail}`);
  }
  await setPhase(ctx, 'validating');
  const reasons = validatePlan(decided.decision);
  const changed = changedIntegrated(owner.state.plan, decided.decision, integrated);
  if (reasons.length > 0) {
    ctx.trace.emit({ type: 'plan_rejected', source: 'replan', reasons: [...reasons] });
  }
  if (reasons.length > 0 || changed.length > 0) {
    const detail = changed.length > 0 ? `the new plan changes integrated tasks: ${changed.join(', ')}` : 'the new plan is invalid';
    return failReplan(ctx, intent, 'replan_invalid', [], detail);
  }
  await applyPlan(ctx, decided.decision, integrated);
}

/** Stops every live or held run of a task that is not integrated or failed; returns the tasks whose stop was not confirmed. */
async function stopRunsOfOpenTasks(ctx: RunContext): Promise<string[]> {
  const open = (taskId: string): boolean => {
    const state = ctx.owner.state.tasks[taskId]?.state;
    return state !== undefined && state !== 'integrated' && state !== 'failed';
  };
  const targets = Object.values(ctx.owner.state.runs).filter((run) => (run.state === 'live' || isHeld(run)) && open(run.taskId));
  const unconfirmed: string[] = [];
  await Promise.all(
    targets.map(async (run) => {
      if (!(await stopRun(ctx, run, 'replan', { do: 'continue_replan', phase: 'stopping_runs' }))) {
        unconfirmed.push(run.taskId);
      }
    }),
  );
  return unconfirmed;
}

async function setPhase(ctx: RunContext, phase: ReplanPhase): Promise<void> {
  await ctx.owner.update((state) => {
    for (const intent of state.intents) {
      if (intent.kind === 'replan') {
        intent.phase = phase;
      }
    }
  });
}

/**
 * The integrated tasks the new plan drops or changes: only the id, the owned
 * paths (normalized, sorted) and the dependency set count; wording and order
 * do not.
 */
function changedIntegrated(current: Plan, next: Plan, integrated: readonly string[]): string[] {
  const comparable = (task: PlanTask | undefined): string =>
    task === undefined
      ? 'missing'
      : JSON.stringify({
          id: task.id,
          ownedPaths: task.ownedPaths.map((path) => normalizePath(path) ?? path).toSorted(),
          dependsOn: [...new Set(task.dependsOn)].toSorted(),
        });
  return integrated.filter(
    (taskId) => comparable(current.tasks.find((task) => task.id === taskId)) !== comparable(next.tasks.find((task) => task.id === taskId)),
  );
}

/** The new plan: integrated tasks kept as they are, every other task a new revision, pending, with a fresh budget. */
async function applyPlan(ctx: RunContext, next: Plan, integrated: readonly string[]): Promise<void> {
  const { owner } = ctx;
  const previous = owner.state;
  const tasks = next.tasks.map((task) => {
    const kept = integrated.includes(task.id) ? previous.plan.tasks.find((candidate) => candidate.id === task.id) : undefined;
    return kept ?? { ...task, revision: (previous.tasks[task.id]?.revision ?? 0) + 1 };
  });
  const plan: Plan = { tasks };
  const changes: Change[] = tasks
    .filter((task) => !integrated.includes(task.id))
    .map((task) => ({
      taskId: task.id,
      from: previous.tasks[task.id]?.state ?? 'pending',
      to: 'pending',
      reason: 'new revision of the re-plan',
    }));
  await owner.update((state) => {
    const entries = tasks.map((task) => {
      const before = state.tasks[task.id];
      return [
        task.id,
        before !== undefined && integrated.includes(task.id)
          ? before
          : resetForReplan(before ?? { revision: 1, state: 'pending', attemptsUsed: 0 }, task.revision),
      ] as const;
    });
    state.plan = plan;
    state.tasks = Object.fromEntries(entries);
    state.intents = state.intents.filter(
      (intent) => intent.kind !== 'replan' && !('taskId' in intent && intent.taskId !== null && !integrated.includes(intent.taskId)),
    );
  });
  ctx.integrations.setOrder(topologicalOrder(plan));
  ctx.trace.emit({ type: 'plan_produced', source: 'replan', taskCount: tasks.length });
  traceChanges(ctx, changes);
  ctx.trace.emit({ type: 'replan_ended', ok: true, detail: `${changes.length} tasks continue as new revisions` });
}

/**
 * A re-plan that could not happen: the asker and the tasks whose stop was not
 * confirmed fail, a task whose run is stopped (or that has none) goes back to
 * pending as a new revision with its attempts, every other task continues
 * from its state. One save, then the trace.
 */
async function failReplan(
  ctx: RunContext,
  intent: ReplanIntent,
  reason: string,
  unconfirmed: readonly string[],
  detail: string,
): Promise<void> {
  const changes: Change[] = [];
  const failures = new Map<string, string>([
    [intent.taskId, reason],
    ...unconfirmed.map((taskId) => [taskId, 'stop_unconfirmed'] as const),
  ]);
  const redispatch = Object.keys(ctx.owner.state.tasks).filter((taskId) => {
    const state = ctx.owner.task(taskId).state;
    const last = latestRun(ctx, taskId);
    return !failures.has(taskId) && !UNTOUCHED.includes(state) && (last === undefined || last.state === 'stopped');
  });
  await ctx.owner.update((state) => {
    state.intents = state.intents.filter((candidate) => candidate.kind !== 'replan');
    for (const [taskId, why] of failures) {
      failTask(state, taskId, why, changes);
    }
    for (const taskId of redispatch) {
      const task = state.tasks[taskId];
      if (task !== undefined) {
        changes.push({ taskId, from: task.state, to: 'pending', reason: 'dispatched again as a new revision after the failed re-plan' });
        state.tasks[taskId] = { revision: task.revision + 1, state: 'pending', attemptsUsed: task.attemptsUsed };
        dropConfirmedStops(state, taskId);
      }
    }
  });
  traceChanges(ctx, changes);
  ctx.trace.emit({ type: 'replan_ended', ...ctx.owner.correlation(intent.taskId), ok: false, detail: ctx.trace.redact(detail) });
}

function failTask(state: RunState, taskId: string, reason: string, changes: Change[]): void {
  const task = state.tasks[taskId];
  if (task === undefined || task.state === 'failed' || task.state === 'integrated') {
    return;
  }
  changes.push({ taskId, from: task.state, to: 'failed', reason });
  state.tasks[taskId] = { ...task, state: 'failed', failReason: reason };
  dropConfirmedStops(state, taskId);
}

/** The cutoff passed during the re-plan: it ends, and the cutoff stops the runs and ends the tasks. */
async function endAtCutoff(ctx: RunContext, intent: ReplanIntent): Promise<void> {
  await ctx.owner.removeIntents((candidate) => candidate.kind === 'replan');
  ctx.trace.emit({
    type: 'replan_ended',
    ...ctx.owner.correlation(intent.taskId),
    ok: false,
    detail: 'the cutoff passed during the re-plan',
  });
}

function traceChanges(ctx: RunContext, changes: readonly Change[]): void {
  for (const change of changes) {
    ctx.trace.emit({
      type: 'task_state_changed',
      ...ctx.owner.correlation(change.taskId),
      from: change.from,
      to: change.to,
      reason: change.reason,
    });
  }
}
