import { describe, expect, test } from 'bun:test';

import { topologicalOrder } from './order';
import type { Plan, PlanTask } from './plan';

const aTask = (id: string, overrides: Partial<PlanTask> = {}): PlanTask => ({
  id,
  revision: 1,
  title: `task ${id}`,
  description: `what task ${id} does`,
  playbook: 'task-playbook',
  ownedPaths: [],
  dependsOn: [],
  ...overrides,
});

const aPlan = (...tasks: PlanTask[]): Plan => ({ tasks });

describe('topologicalOrder', () => {
  test('a reversed listing still runs the dependency first', () => {
    expect(topologicalOrder(aPlan(aTask('b', { dependsOn: ['a'] }), aTask('a')))).toEqual(['a', 'b']);
  });

  test('plan order breaks ties among independent tasks', () => {
    expect(topologicalOrder(aPlan(aTask('c'), aTask('a'), aTask('b')))).toEqual(['c', 'a', 'b']);
  });

  test('a diamond runs its shared dependency before the join', () => {
    const plan = aPlan(
      aTask('d', { dependsOn: ['b', 'c'] }),
      aTask('b', { dependsOn: ['a'] }),
      aTask('c', { dependsOn: ['a'] }),
      aTask('a'),
    );
    expect(topologicalOrder(plan)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('the tie is broken by plan order, not by when a task became runnable', () => {
    const plan = aPlan(aTask('c', { dependsOn: ['a'] }), aTask('a'), aTask('b'));
    expect(topologicalOrder(plan)).toEqual(['a', 'c', 'b']);
  });
});
