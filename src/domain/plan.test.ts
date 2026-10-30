import { describe, expect, test } from 'bun:test';

import { PlanSchema, validatePlan, type Plan, type PlanTask } from './plan';

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

describe('PlanSchema', () => {
  test('parsing a task without an id fails naming the path of the missing field', () => {
    const parsed = PlanSchema.safeParse({
      tasks: [{ revision: 1, title: 'serve requests', description: '', playbook: 'task-playbook', ownedPaths: [], dependsOn: [] }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('tasks.0.id');
    }
  });

  test('a task id must be a slug safe in branch names and paths', () => {
    const parse = (id: string): boolean => PlanSchema.safeParse({ tasks: [aTask(id)] }).success;
    expect(parse('cli-adds-2')).toBe(true);
    expect(parse('a'.repeat(40))).toBe(true);
    for (const bad of ['Task', '2fast', '-lead', 'has_underscore', 'with space', '../escape', 'a/b', 'a'.repeat(41)]) {
      expect(parse(bad)).toBe(false);
    }
  });

  test('an empty task list is not a plan', () => {
    expect(PlanSchema.safeParse({ tasks: [] }).success).toBe(false);
  });
});

describe('validatePlan', () => {
  test('a well formed plan lists no reasons', () => {
    expect(validatePlan(aPlan(aTask('a'), aTask('b', { dependsOn: ['a'] })))).toEqual([]);
  });

  test('every duplicated id yields its own reason', () => {
    const plan = aPlan(aTask('a', { ownedPaths: ['x/one.ts'] }), aTask('a', { ownedPaths: ['y/one.ts'] }), aTask('b'), aTask('b'));
    expect(validatePlan(plan)).toEqual([
      { kind: 'duplicate_id', taskId: 'a' },
      { kind: 'duplicate_id', taskId: 'b' },
    ]);
  });

  test('an unknown dependency names the task and the unknown id', () => {
    expect(validatePlan(aPlan(aTask('a', { dependsOn: ['ghost'] })))).toEqual([
      { kind: 'unknown_dependency', taskId: 'a', dependsOn: 'ghost' },
    ]);
  });

  test('a cycle names every task on it', () => {
    const plan = aPlan(aTask('a', { dependsOn: ['b'] }), aTask('b', { dependsOn: ['a'] }));
    expect(validatePlan(plan)).toEqual([{ kind: 'cycle', taskIds: ['a', 'b'] }]);
  });

  test('independent tasks may not own a directory and a file inside it', () => {
    const plan = aPlan(aTask('a', { ownedPaths: ['src/'] }), aTask('b', { ownedPaths: ['src/cli.ts'] }));
    expect(validatePlan(plan)).toEqual([{ kind: 'path_overlap', taskIdA: 'a', taskIdB: 'b', pathA: 'src', pathB: 'src/cli.ts' }]);
  });

  test('sequential tasks may own the same path', () => {
    const plan = aPlan(aTask('a', { ownedPaths: ['src/index.ts'] }), aTask('b', { ownedPaths: ['src/index.ts'], dependsOn: ['a'] }));
    expect(validatePlan(plan)).toEqual([]);
  });

  test('a shared prefix that is not a directory boundary does not overlap', () => {
    const plan = aPlan(aTask('a', { ownedPaths: ['src'] }), aTask('b', { ownedPaths: ['srcx/a.ts'] }));
    expect(validatePlan(plan)).toEqual([]);
  });

  test('the root path overlaps every other owned path', () => {
    const plan = aPlan(aTask('a', { ownedPaths: ['.'] }), aTask('b', { ownedPaths: ['lib/x.ts'] }));
    expect(validatePlan(plan)).toEqual([{ kind: 'path_overlap', taskIdA: 'a', taskIdB: 'b', pathA: '.', pathB: 'lib/x.ts' }]);
  });

  test('a transitive dependency counts as sequential', () => {
    const plan = aPlan(
      aTask('a', { ownedPaths: ['docs'] }),
      aTask('b', { ownedPaths: ['src'], dependsOn: ['a'] }),
      aTask('c', { ownedPaths: ['src'], dependsOn: ['b'] }),
    );
    expect(validatePlan(plan)).toEqual([]);
  });

  test('every parallel pair with an overlap is reported', () => {
    const plan = aPlan(aTask('x', { ownedPaths: ['src'] }), aTask('y', { ownedPaths: ['src'] }), aTask('z', { ownedPaths: ['src'] }));
    expect(validatePlan(plan)).toEqual([
      { kind: 'path_overlap', taskIdA: 'x', taskIdB: 'y', pathA: 'src', pathB: 'src' },
      { kind: 'path_overlap', taskIdA: 'x', taskIdB: 'z', pathA: 'src', pathB: 'src' },
      { kind: 'path_overlap', taskIdA: 'y', taskIdB: 'z', pathA: 'src', pathB: 'src' },
    ]);
  });

  test('owned paths are compared after posix normalization', () => {
    const plan = aPlan(aTask('a', { ownedPaths: ['./src/'] }), aTask('b', { ownedPaths: ['lib/../src//cli.ts'] }));
    expect(validatePlan(plan)).toEqual([{ kind: 'path_overlap', taskIdA: 'a', taskIdB: 'b', pathA: 'src', pathB: 'src/cli.ts' }]);
  });

  test('a path that collapses to the root overlaps everything', () => {
    const plan = aPlan(aTask('a', { ownedPaths: ['lib/..'] }), aTask('b', { ownedPaths: ['src/x.ts'] }));
    expect(validatePlan(plan)).toEqual([{ kind: 'path_overlap', taskIdA: 'a', taskIdB: 'b', pathA: '.', pathB: 'src/x.ts' }]);
  });

  test('absolute paths and paths escaping the root are invalid and never compared', () => {
    const plan = aPlan(aTask('a', { ownedPaths: ['/etc/passwd', '../outside', 'src/../../x', 'ok'] }), aTask('b', { ownedPaths: ['src'] }));
    expect(validatePlan(plan)).toEqual([
      { kind: 'invalid_path', taskId: 'a', path: '/etc/passwd' },
      { kind: 'invalid_path', taskId: 'a', path: '../outside' },
      { kind: 'invalid_path', taskId: 'a', path: 'src/../../x' },
    ]);
  });
});
