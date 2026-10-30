/**
 * The task lifecycle: the nine states a task moves through, the only allowed
 * transitions between them (anything else is a programming error), the
 * readiness rule over integrated dependencies, and the per-task run-state
 * entry the application holds, with the re-plan reset to a fresh pending
 * state.
 */

import { z } from 'zod';

/** The states of the task lifecycle, in orchestration order. */
export const TASK_STATES = [
  'pending',
  'ready',
  'running',
  'judging',
  'recovering',
  'accepted',
  'integrating',
  'integrated',
  'failed',
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TaskStateSchema = z.enum(TASK_STATES);

/**
 * The only allowed transitions. Anything else is a programming error.
 * pending -> ready | failed; ready -> running | failed;
 * running -> judging | recovering | failed; judging -> accepted | recovering | failed;
 * recovering -> running | failed; accepted -> integrating | failed;
 * integrating -> integrated | recovering | failed;
 * integrated and failed are terminal.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ['ready', 'failed'],
  ready: ['running', 'failed'],
  running: ['judging', 'recovering', 'failed'],
  judging: ['accepted', 'recovering', 'failed'],
  recovering: ['running', 'failed'],
  accepted: ['integrating', 'failed'],
  integrating: ['integrated', 'recovering', 'failed'],
  integrated: [],
  failed: [],
};

/** True only for a transition listed in ALLOWED_TRANSITIONS. */
export function canTransition(from: TaskState, to: TaskState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Throws naming both states when the transition is illegal. */
export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal task state transition: ${from} -> ${to}`);
  }
}

/**
 * Ready when every dependency is integrated; a dependency with no recorded
 * state is not integrated, and a task with no dependencies is always ready.
 */
export function isReady(dependsOn: readonly string[], stateOf: (taskId: string) => TaskState | undefined): boolean {
  return dependsOn.every((taskId) => stateOf(taskId) === 'integrated');
}

/** A task's live run-state entry, held in the run state. */
export const TaskRunStateSchema = z.object({
  revision: z.number().int().positive(),
  state: TaskStateSchema,
  attemptsUsed: z.number().int().nonnegative(),
  failReason: z.string().optional(), // TaskFailure.reason when failed
});
export type TaskRunState = z.infer<typeof TaskRunStateSchema>;

/** Re-plan reset: same task id, new revision, pending, fresh budget, no fail reason. */
export function resetForReplan(_previous: TaskRunState, newRevision: number): TaskRunState {
  return { revision: newRevision, state: 'pending', attemptsUsed: 0 };
}
