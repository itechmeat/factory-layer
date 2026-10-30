/**
 * The Markdown report adapter: a pure renderer from trace events alone (no
 * IO, offline, and no redaction of its own: the events arrive already
 * redacted by the trace sink) and a thin writer that puts the rendered
 * markdown into an output directory.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { aggregateUsage, type TraceEvent } from '../../domain';

import {
  allUsageRecords,
  decisionIntervals,
  decisionKindsPresent,
  decisionLabel,
  executorRecords,
  overlappingPairs,
  runFraming,
  sumCosts,
  taskStats,
  usageOfKind,
  type RunFraming,
} from './aggregate';
import { formatCosts, formatDurationMs, formatModel, formatModels, formatUsageTotal } from './format';

/** The file name the writer uses inside the output directory. */
export const REPORT_FILE_NAME = 'report.md';

/** Renders the report of one run from its trace events. */
export function renderReport(events: readonly TraceEvent[], options: { readonly title: string }): string {
  const framing = runFraming(events);
  const sections = [
    `# ${options.title}`,
    renderRun(framing),
    renderTasks(events),
    renderTotals(events),
    renderExecutorUsage(events),
    renderBrainUsage(events),
    renderDecisions(events),
    renderRecoveries(events),
    renderFailedChecks(events),
    renderInterventions(events),
  ];
  return `${sections.join('\n\n')}\n`;
}

/** Writes the markdown to `report.md` inside `outDir`, creating the directory when missing. */
export async function writeReport(outDir: string, markdown: string): Promise<{ readonly file: string }> {
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, REPORT_FILE_NAME);
  await writeFile(file, markdown, 'utf8');
  return { file };
}

function renderRun(framing: RunFraming): string {
  const lines = [`## Run`, `- Outcome: ${framing.outcome ?? 'unavailable'}`];
  if (framing.startedAt !== null && framing.endedAt !== null) {
    const wallMs = Date.parse(framing.endedAt) - Date.parse(framing.startedAt);
    lines.push(`- Wall time: ${formatDurationMs(wallMs)} (${framing.startedAt} -> ${framing.endedAt})`);
  } else {
    lines.push('- Wall time: unavailable');
  }
  if (framing.reason !== null) lines.push(`- Reason: ${framing.reason}`);
  return lines.join('\n');
}

function renderTasks(events: readonly TraceEvent[]): string {
  const stats = taskStats(events);
  if (stats.length === 0) {
    return ['## Tasks', 'No tasks were recorded.'].join('\n');
  }
  const header = ['| Task | Final state | Attempts | Wall time | Models | Tokens | Cost |', '| --- | --- | --- | --- | --- | --- | --- |'];
  const rows = stats.map((task) => {
    const wall = task.wallTimeMs === null ? '-' : formatDurationMs(task.wallTimeMs);
    const tokens = formatUsageTotal(aggregateUsage(task.records.map((record) => record.usage)));
    const cost = formatCosts(sumCosts(task.records));
    return `| ${task.taskId} | ${task.finalState ?? 'unavailable'} | ${task.attempts} | ${wall} | ${formatModels(task.records)} | ${tokens} | ${cost} |`;
  });
  return ['## Tasks', ...header, ...rows].join('\n');
}

function renderTotals(events: readonly TraceEvent[]): string {
  const records = allUsageRecords(events);
  const tokens = formatUsageTotal(aggregateUsage(records.map((record) => record.usage)));
  const cost = formatCosts(sumCosts(records));
  return ['## Totals', `- Tokens: ${tokens}`, `- Cost: ${cost}`].join('\n');
}

function renderExecutorUsage(events: readonly TraceEvent[]): string {
  const rows = executorRecords(events);
  if (rows.length === 0) {
    return ['## Executor usage', 'No executor usage was recorded.'].join('\n');
  }
  const lines = rows.map(({ taskId, attempt, record }) => {
    const tokens = formatUsageTotal(aggregateUsage([record.usage]));
    const where = `${taskId ?? 'run'}, attempt ${attempt ?? '-'}, node ${record.nodeId ?? '-'}`;
    return `- ${where}: ${formatModel(record)}, ${tokens}, ${formatCosts(sumCosts([record]))}`;
  });
  return ['## Executor usage', ...lines].join('\n');
}

function renderBrainUsage(events: readonly TraceEvent[]): string {
  if (decisionKindsPresent(events).length === 0) {
    return ['## Brain usage per decision kind', 'No brain decisions were recorded.'].join('\n');
  }
  const lines = decisionKindsPresent(events).map((kind) => {
    const records = usageOfKind(events, kind);
    const tokens = formatUsageTotal(aggregateUsage(records.map((record) => record.usage)));
    return `- ${kind}: ${tokens}, cost ${formatCosts(sumCosts(records))}`;
  });
  return ['## Brain usage per decision kind', ...lines].join('\n');
}

function renderDecisions(events: readonly TraceEvent[]): string {
  const intervals = decisionIntervals(events);
  if (intervals.length === 0) {
    return ['## Decision intervals', 'No brain decisions were recorded.'].join('\n');
  }
  const lines = intervals.map((interval) => `- ${decisionLabel(interval)}: ${interval.startAt} -> ${interval.endAt}`);
  const pairs = overlappingPairs(intervals);
  if (pairs.length === 0) {
    lines.push('No overlapping decision pairs.');
  } else {
    lines.push('Overlapping pairs:', ...pairs.map(([first, second]) => `- ${decisionLabel(first)} overlaps ${decisionLabel(second)}`));
  }
  return ['## Decision intervals', ...lines].join('\n');
}

function renderRecoveries(events: readonly TraceEvent[]): string {
  const lines = events
    .filter((event) => event.type === 'recovery_chosen')
    .map((event) => `- ${event.taskId ?? 'run'}: ${event.choice} (${event.detail})`);
  if (lines.length === 0) {
    return ['## Recoveries', 'No recoveries were recorded.'].join('\n');
  }
  return ['## Recoveries', ...lines].join('\n');
}

function renderFailedChecks(events: readonly TraceEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type !== 'checks_run') continue;
    for (const result of event.results) {
      if (result.status === 'passed') continue;
      const reasons = result.reasons.length > 0 ? result.reasons.join('; ') : '(no reasons recorded)';
      lines.push(`- ${result.checkId} (${result.status}, ${event.scope}): ${reasons}`);
    }
  }
  if (lines.length === 0) {
    return ['## Failed checks', 'No failed checks were recorded.'].join('\n');
  }
  return ['## Failed checks', ...lines].join('\n');
}

function renderInterventions(events: readonly TraceEvent[]): string {
  const lines = events.filter((event) => event.type === 'intervention_recorded').map((event) => `- ${event.at}: ${event.note}`);
  if (lines.length === 0) {
    return ['## Intervention log', 'No human intervention was recorded.'].join('\n');
  }
  return ['## Intervention log', ...lines].join('\n');
}
