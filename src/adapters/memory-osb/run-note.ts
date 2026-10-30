/**
 * The OSB note of one finished factory run: its vault path, its body and the
 * parsing of that body back into a recalled run. The note body holds the
 * outcome as a one-line fenced JSON block right under the title. Invariant: a recalled run is
 * built only from a block that matched `RunNoteSchema`; anything else is
 * skipped, never guessed.
 * The record and recalled-run types are the Memory port's
 * (`RunOutcomeRecord`, `RecalledRun`); the schema validates a record at the
 * vault boundary in both directions.
 */

import { z } from 'zod';

import { RunOutcomeSchema } from '../../domain/run-state';
import type { RecalledRun, RunOutcomeRecord } from '../../ports/memory';

/** The vault folder of the factory's run notes. */
export const RUN_NOTES_PREFIX = 'factory/runs/';

/** The vault folder of the memory smoke's fake run notes: outside `RUN_NOTES_PREFIX`, so a real recall never sees them. */
export const SMOKE_NOTES_PREFIX = 'factory/smoke-runs/';

/** A fake note an older memory smoke wrote under `RUN_NOTES_PREFIX` (run id `smoke-<ms>`); a recall there skips it. */
const LEGACY_SMOKE_NOTE = /-smoke-\d+\.md$/;

/** Whether `path` is a legacy smoke note among the real run notes; notes under any other prefix never are. */
export function isLegacySmokeNote(path: string): boolean {
  return path.startsWith(RUN_NOTES_PREFIX) && LEGACY_SMOKE_NOTE.test(path);
}

/** The version of the JSON block written into each run note. */
const RUN_NOTE_VERSION = 1;

/** One finished run as the factory remembers it. */
export const RunOutcomeRecordSchema: z.ZodType<RunOutcomeRecord> = z.object({
  runId: z.string().min(1),
  specName: z.string().min(1),
  outcome: RunOutcomeSchema,
  planSummary: z.string(),
  tasks: z.array(
    z.object({
      taskId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      integrated: z.boolean(),
      attempts: z.number().int().nonnegative(),
    }),
  ),
  failedCheckIds: z.array(z.string()),
  durationMs: z.number().nonnegative(),
});

/** The JSON block of a run note. */
const RunNoteSchema = z.object({
  version: z.literal(RUN_NOTE_VERSION),
  rememberedAt: z.iso.datetime(),
  record: RunOutcomeRecordSchema,
});

/** A one-line fenced JSON block. */
const JSON_BLOCK = /```json\n(.+)\n```/;

/** Replaces every character a vault path should not carry with `-`. */
function pathSafe(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, '-');
}

/** The vault path of a run's note: `<prefix><spec>-<run id>.md`, under `factory/runs/` by default. */
export function runNotePath(record: RunOutcomeRecord, prefix: string = RUN_NOTES_PREFIX): string {
  return `${prefix}${pathSafe(record.specName)}-${pathSafe(record.runId)}.md`;
}

/** The note body: a title, the JSON block (first, so a cut read keeps it), the plan summary and the per-task lines. */
export function runNoteBody(record: RunOutcomeRecord, rememberedAt: Date): string {
  const note = { version: RUN_NOTE_VERSION, rememberedAt: rememberedAt.toISOString(), record };
  const tasks = record.tasks.map(
    (task) => `- ${task.taskId} r${task.revision}: ${task.integrated ? 'integrated' : 'not integrated'} after ${task.attempts} attempt(s)`,
  );
  const failed = record.failedCheckIds.length === 0 ? 'none' : record.failedCheckIds.join(', ');
  return [
    `# Factory run ${record.runId}: ${record.specName}`,
    '',
    '```json',
    JSON.stringify(note),
    '```',
    '',
    `Outcome: ${record.outcome}. Duration: ${Math.round(record.durationMs / 1000)} s. Failed checks: ${failed}.`,
    '',
    record.planSummary,
    '',
    ...tasks,
    '',
  ].join('\n');
}

/** The recalled run in a note's content, or undefined when it holds no valid block. */
export function parseRunNote(content: string): RecalledRun | undefined {
  const block = JSON_BLOCK.exec(content)?.[1];
  if (block === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return undefined;
  }
  const parsed = RunNoteSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { record, rememberedAt } = parsed.data;
  return { specName: record.specName, outcome: record.outcome, summary: record.planSummary, at: rememberedAt };
}
