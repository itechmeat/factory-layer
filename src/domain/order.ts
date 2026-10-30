/**
 * Stable topological order of a valid plan: every dependency before its
 * dependants, ties broken by plan order (Kahn with a plan-order queue). The
 * caller validates the plan first; on a plan with a cycle or an unknown
 * dependency the emitted order simply skips the tasks that never become
 * ready.
 */

import type { Plan } from './plan';

export function topologicalOrder(plan: Plan): readonly string[] {
  const planIndexOf = new Map<string, number>();
  const unmet = new Map<string, number>(); // task id -> dependency edges not yet emitted
  const dependents = new Map<string, string[]>(); // dependency id -> task ids waiting on it
  plan.tasks.forEach((task, index) => {
    planIndexOf.set(task.id, index);
    unmet.set(task.id, task.dependsOn.length);
    for (const dependsOn of task.dependsOn) {
      const waiting = dependents.get(dependsOn);
      if (waiting === undefined) {
        dependents.set(dependsOn, [task.id]);
      } else {
        waiting.push(task.id);
      }
    }
  });

  const inPlanOrder = (a: string, b: string): number => (planIndexOf.get(a) ?? 0) - (planIndexOf.get(b) ?? 0);
  const ready = plan.tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const next = ready.reduce((a, b) => (inPlanOrder(b, a) < 0 ? b : a));
    ready.splice(ready.indexOf(next), 1);
    order.push(next);
    for (const dependent of dependents.get(next) ?? []) {
      const left = (unmet.get(dependent) ?? 0) - 1;
      unmet.set(dependent, left);
      if (left === 0) {
        ready.push(dependent);
      }
    }
  }
  return order;
}
