/**
 * Zod schemas of the `apb mcp` answers a finished run's report is built
 * from: `run_report` (node states, outputs, headline, the model of each
 * agent attempt) and `run_events` (the journal, whose `attempt_started` and
 * `attempt_finished` entries carry each agent attempt and its usage). Shapes
 * were recorded from APB 1.0.0-beta.1 (`tests/fixtures/apb/`); unknown
 * fields are kept. A script-only run has no `attempt_models` at all.
 */

import { z } from 'zod';

import { RunStatusSchema } from './apb-run-schemas';

/** `run_report`, reduced to what the report reads. */
export const RunReportSchema = z.looseObject({
  run_id: z.string(),
  run_status: RunStatusSchema,
  /** Node id to node state (`succeeded`, `failed`, `cancelled`, ...). */
  nodes: z.record(z.string(), z.string()),
  /** Node id to its output: the JSON of the status-file outputs for an agent node, the stdout tail for a script. */
  outputs: z.record(z.string(), z.string()),
  outcome: z.looseObject({ headline: z.string() }),
  duration_table: z.array(z.looseObject({ node: z.string(), kind: z.string() })),
  attempt_models: z
    .array(
      z.looseObject({
        node: z.string(),
        attempt: z.number().int().positive(),
        agent: z.string().optional(),
        expected: z.string().nullable().optional(),
        model: z.string().nullable(),
      }),
    )
    .optional(),
});

/** A `run_report` answer. */
export type RunReport = z.infer<typeof RunReportSchema>;

/** `run_events`: the run's journal in order. Each entry is read by its `type`. */
export const RunEventsSchema = z.looseObject({
  events: z.array(z.looseObject({ seq: z.number().int().nonnegative(), ts: z.number(), type: z.string() })),
});

/** `attempt_started`: an agent attempt began. */
export const AttemptStartedSchema = z.looseObject({
  type: z.literal('attempt_started'),
  ts: z.number(),
  node: z.string(),
  attempt: z.number().int().positive(),
  agent: z.string().optional(),
  model: z.string().nullable().optional(),
});

/** The usage an agent CLI reported for one attempt. */
const AttemptUsageSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  cache_write_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().nullable().optional(),
});

/** `attempt_finished`: an agent attempt ended, with its usage when the CLI reported one. */
export const AttemptFinishedSchema = z.looseObject({
  type: z.literal('attempt_finished'),
  ts: z.number(),
  node: z.string(),
  attempt: z.number().int().positive(),
  summary: z.string().nullable().optional(),
  usage: AttemptUsageSchema.nullable().optional(),
});

/** `node_started`: one start of a node, counted again after a retry. */
export const NodeStartedSchema = z.looseObject({ type: z.literal('node_started'), node: z.string() });
