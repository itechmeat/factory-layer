/**
 * Builds a finished run's report from `run_report` and `run_events`: one
 * node report per working node (start and finish nodes left out), and one
 * usage record per agent attempt. Usage per attempt exists only in the
 * journal (`attempt_finished.usage`: tokens, cache tokens, the cost when the
 * CLI reported it); the model comes from the report's `attempt_models`
 * (`model` when the CLI named it, else the profile's `expected` model,
 * marked as such) or the attempt's start entry. APB numbers a retried node's
 * attempts from 1 again, so attempts are counted per node in journal order,
 * and a finish belongs to the latest open start of its node. An attempt that
 * started and never finished (left open, or followed by a new start of its
 * node), or finished without usage, is recorded unavailable with the reason;
 * nothing is invented.
 */

import { z } from 'zod';

import { McpValidationError } from '../mcp-stdio/errors';
import { AttemptFinishedSchema, AttemptStartedSchema, NodeStartedSchema, type RunReport, type RunEventsSchema } from './apb-report-schemas';
import type { Cost, Usage, UsageRecord } from '../../domain/usage';
import type { ExecutorNodeReport, ExecutorReport } from '../../ports/executor';

type RunEvents = z.infer<typeof RunEventsSchema>['events'];
type AttemptStarted = z.infer<typeof AttemptStartedSchema>;
type AttemptFinished = z.infer<typeof AttemptFinishedSchema>;

/** Node kinds that do no work of their own. */
const STRUCTURAL_KINDS: ReadonlySet<string> = new Set(['start', 'finish']);

/** Parses one journal entry of a type the report reads; a changed shape names the tool. */
function entry<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new McpValidationError('run_events', z.prettifyError(parsed.error));
  return parsed.data;
}

/** The entries of one type, parsed. */
function entriesOf<T>(events: RunEvents, type: string, schema: z.ZodType<T>): T[] {
  return events.filter((event) => event.type === type).map((event) => entry(schema, event));
}

/** A node state as the port reports it. */
function nodeOutcome(state: string): ExecutorNodeReport['outcome'] {
  if (state === 'succeeded') return 'succeeded';
  if (state === 'failed' || state === 'cancelled' || state === 'lost' || state === 'interrupted') return 'failed';
  return 'skipped';
}

const OutputFieldsSchema = z.looseObject({ summary: z.string() });

/** The summary of a node: its status-file `summary`, else its last attempt's summary, else its raw output. */
function nodeSummary(output: string | undefined, lastAttempt: AttemptFinished | undefined): string {
  if (output !== undefined && output.startsWith('{')) {
    try {
      const parsed = OutputFieldsSchema.safeParse(JSON.parse(output));
      if (parsed.success) return parsed.data.summary;
    } catch {
      // Not JSON after all: a script's output that starts with a brace; fall through.
    }
  }
  return lastAttempt?.summary ?? output ?? '';
}

function usageOf(finished: AttemptFinished | undefined): Usage {
  if (finished === undefined) return { status: 'unavailable', reason: 'the attempt never finished' };
  const usage = finished.usage;
  if (usage === null || usage === undefined) return { status: 'unavailable', reason: 'the agent CLI reported no usage for the attempt' };
  return {
    status: 'measured',
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_tokens ?? 0,
    cacheWriteTokens: usage.cache_write_tokens ?? 0,
    ...(usage.cost_usd === null || usage.cost_usd === undefined ? {} : { reportedCostUsd: usage.cost_usd }),
  };
}

/** The cost the agent CLI reported; anything else is left for the core to price from its cost table. */
function costOf(usage: Usage): Cost {
  if (usage.status === 'unavailable') return { status: 'unavailable', reason: usage.reason };
  if (usage.status !== 'measured' || usage.reportedCostUsd === undefined) {
    return { status: 'unavailable', reason: 'the agent CLI reported no cost' };
  }
  return { status: 'priced', amountUsd: usage.reportedCostUsd, basis: 'reported' };
}

/** The model of the `index`-th attempt (0-based) of `node`, with where it came from. */
function modelOf(
  report: RunReport,
  node: string,
  index: number,
  started: AttemptStarted,
): Pick<UsageRecord, 'model' | 'modelSource' | 'provider'> {
  const models = (report.attempt_models ?? []).filter((model) => model.node === node);
  const known = models[index];
  const provider = known?.agent ?? started.agent;
  const withProvider = provider === undefined ? {} : { provider };
  if (known?.model !== null && known?.model !== undefined) return { ...withProvider, model: known.model, modelSource: 'actual' };
  const expected = known?.expected ?? started.model ?? null;
  if (expected !== null) return { ...withProvider, model: expected, modelSource: 'expected' };
  return { ...withProvider, modelSource: 'unknown' };
}

/** One agent attempt: its start and, once paired, its finish. */
interface Attempt {
  readonly started: AttemptStarted;
  finished: AttemptFinished | undefined;
}

/** Each agent attempt with its finish: a finish belongs to the latest open start of its node, in journal order. */
function pairedAttempts(events: RunEvents): Attempt[] {
  const attempts: Attempt[] = [];
  const open = new Map<string, Attempt>();
  for (const event of events) {
    if (event.type === 'attempt_started') {
      const started = entry(AttemptStartedSchema, event);
      // A new start leaves an earlier open attempt of the node never finished.
      const attempt: Attempt = { started, finished: undefined };
      attempts.push(attempt);
      open.set(started.node, attempt);
    } else if (event.type === 'attempt_finished') {
      const finished = entry(AttemptFinishedSchema, event);
      const attempt = open.get(finished.node);
      if (attempt === undefined) continue;
      attempt.finished = finished;
      open.delete(finished.node);
    }
  }
  return attempts;
}

/** One usage record per agent attempt, in journal order. */
function usageRecords(runId: string, report: RunReport, events: RunEvents): UsageRecord[] {
  const perNode = new Map<string, number>();
  return pairedAttempts(events).map(({ started, finished }) => {
    const index = perNode.get(started.node) ?? 0;
    perNode.set(started.node, index + 1);
    const usage = usageOf(finished);
    return {
      at: new Date(finished?.ts ?? started.ts).toISOString(),
      source: 'executor',
      ...modelOf(report, started.node, index, started),
      usage,
      cost: costOf(usage),
      executorRunId: runId,
      nodeId: started.node,
      attempt: index + 1,
    };
  });
}

/** The node reports of the run's working nodes. */
function nodeReports(report: RunReport, events: RunEvents): ExecutorNodeReport[] {
  const kinds = new Map(report.duration_table.map((row) => [row.node, row.kind]));
  const startsOf = new Map<string, number>();
  for (const started of entriesOf(events, 'node_started', NodeStartedSchema))
    startsOf.set(started.node, (startsOf.get(started.node) ?? 0) + 1);
  const finishes = entriesOf(events, 'attempt_finished', AttemptFinishedSchema);
  return Object.entries(report.nodes)
    .filter(([node]) => !STRUCTURAL_KINDS.has(kinds.get(node) ?? ''))
    .map(([node, state]) => ({
      nodeId: node,
      outcome: nodeOutcome(state),
      summary: nodeSummary(report.outputs[node], finishes.filter((finished) => finished.node === node).at(-1)),
      attempts: startsOf.get(node) ?? 0,
    }));
}

/** The report of a terminal run; `status` is already mapped (a stop the factory asked for is `stopped`). */
export function buildReport(report: RunReport, events: RunEvents, status: ExecutorReport['status']): ExecutorReport {
  return {
    runId: report.run_id,
    status,
    summary: report.outcome.headline,
    nodes: nodeReports(report, events),
    usage: usageRecords(report.run_id, report, events),
  };
}
