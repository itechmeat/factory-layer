/**
 * What a task's executor runs are started with: the playbook per run role
 * (the task's own playbook, `repair` for a repair run, `integrate` for a
 * conflict resolution) and the typed start inputs (task text with any hint,
 * owned paths, failing checks with their reasons and invocations,
 * conflicting paths), and
 * the follow-up run of a failed one in the same tree.
 */

import { checkInvocation, type ExecutorRunRef } from '../domain';
import type { ExecutorStartInputs } from '../ports';

import type { DispatchRequest } from './dispatch';
import type { RunContext } from './run-context';

/** The playbook of a repair run: fix the given failing checks or follow the hint. */
export const REPAIR_PLAYBOOK = 'repair';
/** The playbook of an integrate run: resolve a merge conflict in the task tree. */
export const INTEGRATE_PLAYBOOK = 'integrate';

/** The start inputs of a task: its text (plus a hint when given) and its owned paths. */
function baseInputs(ctx: RunContext, taskId: string, hint: string | null): ExecutorStartInputs {
  const task = ctx.owner.planTask(taskId);
  const text = `${task.title}\n\n${task.description}`;
  return { taskText: hint === null ? text : `${text}\n\nHint: ${hint}`, ownedPaths: task.ownedPaths };
}

/** The first run of a task, with its own playbook. */
export function taskRequest(ctx: RunContext, taskId: string): DispatchRequest {
  return { taskId, role: 'task', playbook: ctx.owner.planTask(taskId).playbook, inputs: baseInputs(ctx, taskId, null) };
}

/**
 * A repair run in the task's tree, with the hint and the failing checks:
 * each with its last reasons and, for an acceptance check, how to run it
 * (the definitions never live in the tree, so without it the agent cannot
 * reproduce the failure).
 */
export function repairRequest(
  ctx: RunContext,
  taskId: string,
  repair: { readonly hint: string | null; readonly failingCheckIds: readonly string[] },
): DispatchRequest {
  const last = ctx.lastChecks.get(taskId) ?? [];
  const checks = ctx.owner.state.acceptanceChecks;
  const failingChecks = repair.failingCheckIds.map((id) => {
    const reason = last.find((result) => result.checkId === id)?.reasons.join('; ') ?? 'failed';
    const check = checks.find((candidate) => candidate.id === id);
    return { id, reason: check === undefined ? reason : `${reason}; ${checkInvocation(check)}` };
  });
  return {
    taskId,
    role: 'repair',
    playbook: REPAIR_PLAYBOOK,
    inputs: { ...baseInputs(ctx, taskId, repair.hint), ...(failingChecks.length > 0 ? { failingChecks } : {}) },
  };
}

/** An integrate run in the task's tree that resolves the conflicting paths (with a hint when given). */
export function integrateRequest(
  ctx: RunContext,
  taskId: string,
  conflictPaths: readonly string[],
  hint: string | null = null,
): DispatchRequest {
  return { taskId, role: 'integrate', playbook: INTEGRATE_PLAYBOOK, inputs: { ...baseInputs(ctx, taskId, hint), conflictPaths } };
}

/**
 * The run that follows a failed one in the same tree: after an integrate run
 * another integrate run on the paths still unresolved there (the conflict is
 * not resolved yet); after an integrate run with nothing left unresolved, or
 * after any other run, a repair run.
 */
export async function followUpRequest(
  ctx: RunContext,
  ref: ExecutorRunRef | null,
  taskId: string,
  repair: { readonly hint: string | null; readonly failingCheckIds: readonly string[] },
): Promise<DispatchRequest> {
  if (ref?.role !== 'integrate') {
    return repairRequest(ctx, taskId, repair);
  }
  const unresolved = await ctx.ports.workspace.unresolvedPaths(ref.tree);
  return unresolved.length === 0 ? repairRequest(ctx, taskId, repair) : integrateRequest(ctx, taskId, unresolved, repair.hint);
}
