/**
 * The recorded APB 1.0.0-beta.1 answers under `tests/fixtures/apb/` for the
 * adapter's contract tests: each file holds one tool call (`tool`, `args`,
 * `isError`, `answer`), with supervisor tokens redacted and machine paths
 * replaced by `/project`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const FIXTURE_DIR = join(import.meta.dir, '../../../../tests/fixtures/apb');

const RecordedSchema = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()), isError: z.boolean(), answer: z.unknown() });

/** One recorded call. */
export type Recorded = z.infer<typeof RecordedSchema>;

/** The recorded call in `tests/fixtures/apb/<name>.json`. */
export function recorded(name: string): Recorded {
  return RecordedSchema.parse(JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')));
}

/** A deep copy of the recorded answer of `name`, as a plain object, for a test to alter. */
export function answerOf(name: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(structuredClone(recorded(name).answer));
}

const ObjectListSchema = z.array(z.record(z.string(), z.unknown()));

/** A deep copy of a recorded answer that is a list of objects (`runs_list`). */
export function listOf(name: string): Record<string, unknown>[] {
  return ObjectListSchema.parse(structuredClone(recorded(name).answer));
}

/** A deep copy of the journal entries of a recorded `run_events` answer. */
export function eventsOf(name: string): Record<string, unknown>[] {
  return ObjectListSchema.parse(answerOf(name)['events']);
}

/** A deep copy of a recorded answer with `field` removed from the object at `path` (list items by index). */
export function without(name: string, path: readonly (string | number)[], field: string): unknown {
  const answer: unknown = structuredClone(recorded(name).answer);
  let target: unknown = answer;
  for (const key of path) {
    if (typeof target !== 'object' || target === null) throw new Error(`${name}: nothing at ${String(key)}`);
    target = Reflect.get(target, key);
  }
  if (typeof target !== 'object' || target === null || !Reflect.deleteProperty(target, field))
    throw new Error(`${name}: no ${field} to drop`);
  return answer;
}
