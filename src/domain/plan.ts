/**
 * The plan the brain produces and its validity rules: the shape at the
 * boundary (PlanSchema) and validatePlan, which lists every reason a plan is
 * invalid: repeated task ids, dependencies naming unknown tasks, dependency
 * cycles, owned paths that are absolute or escape the repository root, and
 * overlapping owned paths between tasks that could run at the same time.
 * Task ids are slugs, so they are safe in branch names and paths.
 */

import { z } from 'zod';

/** A task id: lowercase letters, digits and hyphens, starting with a letter, at most 40 characters. */
const TASK_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** One task of a plan, as the brain proposes it. */
export const PlanTaskSchema = z.object({
  id: z.string().regex(TASK_ID_PATTERN),
  revision: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string(),
  playbook: z.string().min(1),
  ownedPaths: z.array(z.string().min(1)),
  dependsOn: z.array(z.string().min(1)),
});
export type PlanTask = z.infer<typeof PlanTaskSchema>;

/** A whole plan: one or more tasks. */
export const PlanSchema = z.object({ tasks: z.array(PlanTaskSchema).min(1) });
export type Plan = z.infer<typeof PlanSchema>;

/** One reason a plan is invalid, naming the tasks and paths that caused it. */
export type PlanInvalidReason =
  | { readonly kind: 'duplicate_id'; readonly taskId: string }
  | { readonly kind: 'unknown_dependency'; readonly taskId: string; readonly dependsOn: string }
  | { readonly kind: 'cycle'; readonly taskIds: readonly string[] } // every task on the cycle, plan order
  | { readonly kind: 'invalid_path'; readonly taskId: string; readonly path: string } // absolute or escaping the root, as written
  | { readonly kind: 'path_overlap'; readonly taskIdA: string; readonly taskIdB: string; readonly pathA: string; readonly pathB: string };

/** Lists every reason the plan is invalid; an empty array means the plan is valid. */
export function validatePlan(plan: Plan): readonly PlanInvalidReason[] {
  const entries = withDependencyClosures(plan);
  return [
    ...duplicateIdReasons(plan),
    ...unknownDependencyReasons(plan),
    ...cycleReasons(entries),
    ...invalidPathReasons(plan),
    ...pathOverlapReasons(entries),
  ];
}

// ---- duplicate ids ----

/** One reason per id that more than one task carries, in plan order. */
function duplicateIdReasons(plan: Plan): PlanInvalidReason[] {
  const counts = new Map<string, number>();
  for (const task of plan.tasks) {
    counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
  }
  const reported = new Set<string>();
  const reasons: PlanInvalidReason[] = [];
  for (const task of plan.tasks) {
    if ((counts.get(task.id) ?? 0) > 1 && !reported.has(task.id)) {
      reported.add(task.id);
      reasons.push({ kind: 'duplicate_id', taskId: task.id });
    }
  }
  return reasons;
}

// ---- unknown dependencies ----

/** One reason per dependency that names no task of the plan, per task in plan order. */
function unknownDependencyReasons(plan: Plan): PlanInvalidReason[] {
  const ids = new Set(plan.tasks.map((task) => task.id));
  const reasons: PlanInvalidReason[] = [];
  for (const task of plan.tasks) {
    for (const dependsOn of task.dependsOn) {
      if (!ids.has(dependsOn)) {
        reasons.push({ kind: 'unknown_dependency', taskId: task.id, dependsOn });
      }
    }
  }
  return reasons;
}

// ---- cycles and reachability ----

/** A plan task paired with everything it depends on, directly or transitively. */
interface TaskWithClosure {
  readonly task: PlanTask;
  readonly closure: Set<string>; // contains the task's own id exactly when the task sits on a cycle
}

function withDependencyClosures(plan: Plan): TaskWithClosure[] {
  const byId = new Map<string, PlanTask>();
  for (const task of plan.tasks) {
    byId.set(task.id, task);
  }
  return plan.tasks.map((task) => ({ task, closure: dependencyClosure(task, byId) }));
}

function dependencyClosure(task: PlanTask, byId: ReadonlyMap<string, PlanTask>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...task.dependsOn];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const direct = byId.get(id);
    if (direct !== undefined) {
      queue.push(...direct.dependsOn);
    }
  }
  return seen;
}

/** One reason per strongly connected cycle, its tasks in plan order. */
function cycleReasons(entries: readonly TaskWithClosure[]): PlanInvalidReason[] {
  const reasons: PlanInvalidReason[] = [];
  const reported = new Set<number>();
  entries.forEach((entry, index) => {
    if (reported.has(index) || !entry.closure.has(entry.task.id)) {
      return;
    }
    const taskIds: string[] = [];
    entries.forEach((other, otherIndex) => {
      if (entry.closure.has(other.task.id) && other.closure.has(entry.task.id)) {
        taskIds.push(other.task.id);
        reported.add(otherIndex);
      }
    });
    reasons.push({ kind: 'cycle', taskIds });
  });
  return reasons;
}

// ---- owned paths ----

/**
 * Normalizes a relative path with posix semantics: collapses repeated
 * slashes, drops '.' segments and resolves '..'. The root is '.'. Null for
 * an absolute path or one that climbs above the root.
 */
export function normalizePath(path: string): string | null {
  if (path.startsWith('/')) return null;
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') {
      segments.push(segment);
      continue;
    }
    if (segments.pop() === undefined) return null;
  }
  return segments.length === 0 ? '.' : segments.join('/');
}

/** One reason per owned path that is absolute or escapes the root, per task in plan order. */
function invalidPathReasons(plan: Plan): PlanInvalidReason[] {
  return plan.tasks.flatMap((task) =>
    task.ownedPaths
      .filter((path) => normalizePath(path) === null)
      .map((path): PlanInvalidReason => ({ kind: 'invalid_path', taskId: task.id, path })),
  );
}

/** Equal paths, the root against anything, or an ancestor directory at a '/' boundary. */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a === '.' || b === '.' || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/**
 * One reason per overlapping path pair of two tasks that could run at the
 * same time: tasks are sequential, and free to share paths, when either can
 * reach the other through dependencies. Reported pair by pair in plan order.
 */
function pathOverlapReasons(entries: readonly TaskWithClosure[]): PlanInvalidReason[] {
  const reasons: PlanInvalidReason[] = [];
  for (const [indexA, a] of entries.entries()) {
    for (const b of entries.slice(indexA + 1)) {
      if (a.closure.has(b.task.id) || b.closure.has(a.task.id)) {
        continue; // one depends on the other, so they never run at the same time
      }
      reasons.push(...overlappingPathReasons(a.task, b.task));
    }
  }
  return reasons;
}

/** One reason per overlapping path pair of the two tasks, in owned-path order; invalid paths are reported elsewhere. */
function overlappingPathReasons(taskA: PlanTask, taskB: PlanTask): PlanInvalidReason[] {
  const reasons: PlanInvalidReason[] = [];
  for (const rawA of taskA.ownedPaths) {
    for (const rawB of taskB.ownedPaths) {
      const pathA = normalizePath(rawA);
      const pathB = normalizePath(rawB);
      if (pathA !== null && pathB !== null && pathsOverlap(pathA, pathB)) {
        reasons.push({ kind: 'path_overlap', taskIdA: taskA.id, taskIdB: taskB.id, pathA, pathB });
      }
    }
  }
  return reasons;
}
