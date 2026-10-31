/**
 * Turns a start's typed inputs into what an APB playbook reads: the task
 * text goes to `.factory/task.md` inside the task tree (the workspace keeps
 * `.factory/` out of commits) and the params are strings, one item per line.
 * Every param the playbook declares must be supplied: APB has no required
 * flag and would render a missing one empty, so a start that lacks one is
 * refused here, naming it, before APB is called. A repair that follows a
 * run no check has judged yet (an aborted run retried, a re-plan downgraded)
 * carries only a hint in the task text: its `failing_checks` says so and
 * points at the task file instead of leaving the param missing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExecutorStartInputs } from '../../ports/executor';

/** Where the task text lives, relative to the task tree. */
export const TASK_FILE = '.factory/task.md';

/** The params the starter playbooks declare, so their starts need no lookup. */
export const STARTER_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'build-task': ['task_file', 'owned_paths', 'mode', 'failing_checks'],
  integrate: ['task_file', 'conflict_paths'],
};

/** The `failing_checks` of a repair no check has failed for yet: the failure is in the task file. */
export const NO_FAILING_CHECKS = `none: no check has failed yet; fix the failure described in ${TASK_FILE}`;

/** The params a start can supply, or `undefined` for one the inputs do not carry. */
function availableParams(inputs: ExecutorStartInputs): Readonly<Record<string, string | undefined>> {
  return {
    task_file: TASK_FILE,
    mode: inputs.mode,
    owned_paths: inputs.ownedPaths.length === 0 ? undefined : inputs.ownedPaths.join('\n'),
    failing_checks:
      inputs.failingChecks === undefined || inputs.failingChecks.length === 0
        ? NO_FAILING_CHECKS
        : inputs.failingChecks.map((check) => `${check.id}: ${check.reason}`).join('\n'),
    conflict_paths: inputs.conflictPaths === undefined || inputs.conflictPaths.length === 0 ? undefined : inputs.conflictPaths.join('\n'),
  };
}

/** The params of a start, or the declared params it cannot supply. */
export type StartParams =
  | { readonly ok: true; readonly params: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly missing: readonly string[] };

/** Maps `inputs` onto the `declared` params of a playbook. */
export function startParams(declared: readonly string[], inputs: ExecutorStartInputs): StartParams {
  const available = availableParams(inputs);
  const params: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of declared) {
    const value = available[name];
    if (value === undefined) missing.push(name);
    else params[name] = value;
  }
  return missing.length === 0 ? { ok: true, params } : { ok: false, missing };
}

/** Writes the task text into `tree` at `TASK_FILE`. */
export function writeTaskFile(tree: string, taskText: string): void {
  const path = join(tree, TASK_FILE);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, taskText.endsWith('\n') ? taskText : `${taskText}\n`);
}
