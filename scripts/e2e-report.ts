/**
 * What the end-to-end run reads from the factory and what it prints. The
 * factory's side is read leniently, by labels, from its CLI output (the
 * `run id: <id>` line) and from the run's Markdown report
 * (`runs/<run-id>/report.md`): the outcome, the wall time and the task
 * table with its state, time and cost columns. A value the report does not
 * carry is shown as unavailable, never guessed. The summary is plain text
 * for the operator's terminal.
 */

import type { ExampleResult, RuntimeResult } from './e2e-verify';

/** What the run's report says, as far as it could be read. */
export interface FactoryReport {
  readonly outcome: string | undefined;
  readonly wallTime: string | undefined;
  readonly tasks: readonly TaskRow[];
}

/** One task row of the report. */
export interface TaskRow {
  readonly task: string;
  readonly state: string;
  readonly time: string;
  readonly cost: string;
}

const UNAVAILABLE = 'unavailable';

/** The run id printed by `factory run`, from its `run id: <id>` line. */
export function parseRunId(cliOutput: string): string | undefined {
  return /^run id:\s*(\S+)\s*$/m.exec(cliOutput)?.[1];
}

/** The outcome named after an `outcome` label, in a report or in the CLI output. */
export function parseOutcome(text: string): string | undefined {
  return /outcome\W{0,8}(succeeded|partial|failed)/i.exec(text)?.[1]?.toLowerCase();
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function column(header: readonly string[], pattern: RegExp): number {
  return header.findIndex((cell) => pattern.test(cell));
}

/** The rows of the first Markdown table whose header has a task column. */
function parseTaskTable(lines: readonly string[]): TaskRow[] {
  for (const [index, line] of lines.entries()) {
    if (!line.trim().startsWith('|')) continue;
    const header = cells(line);
    const taskColumn = column(header, /^task/i);
    if (taskColumn < 0 || !/^\s*\|?\s*:?-/.test(lines[index + 1] ?? '')) continue;
    const at = { state: column(header, /state/i), time: column(header, /time/i), cost: column(header, /cost/i) };
    const pick = (row: readonly string[], i: number): string => (i < 0 ? UNAVAILABLE : (row[i] ?? UNAVAILABLE));
    const rows: TaskRow[] = [];
    for (const rowLine of lines.slice(index + 2)) {
      if (!rowLine.trim().startsWith('|')) break;
      const row = cells(rowLine);
      rows.push({ task: pick(row, taskColumn), state: pick(row, at.state), time: pick(row, at.time), cost: pick(row, at.cost) });
    }
    return rows;
  }
  return [];
}

/** Read the outcome, wall time and task rows of a Markdown run report. */
export function parseReport(markdown: string): FactoryReport {
  return {
    outcome: parseOutcome(markdown),
    wallTime: /wall time\W{0,8}([^|\n]+)/i.exec(markdown)?.[1]?.trim(),
    tasks: parseTaskTable(markdown.split('\n')),
  };
}

/** Everything the end-to-end run prints at its end. */
export interface E2eSummary {
  readonly specName: string;
  readonly runId: string | undefined;
  readonly outcome: string;
  readonly factoryWallMs: number | undefined;
  readonly report: FactoryReport | undefined;
  readonly runtimes: readonly RuntimeResult[];
  readonly examples: readonly ExampleResult[];
  readonly examplesError: string | undefined;
  readonly notes: readonly string[];
  readonly passed: boolean;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function pad(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length))) ?? [];
  return rows.map((row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd(),
  );
}

function taskLines(tasks: readonly TaskRow[]): string[] {
  if (tasks.length === 0) return [`tasks           ${UNAVAILABLE}`];
  const table = pad([['task', 'state', 'time', 'cost'], ...tasks.map((t) => [t.task, t.state, t.time, t.cost])]);
  return ['tasks', ...table.map((line) => `  ${line}`)];
}

function runtimeLines(runtime: RuntimeResult): string[] {
  const steps = runtime.steps.map(
    (s) => `${s.name} ${s.passed ? 'ok' : s.timedOut ? 'timed out' : `exit ${s.exitCode ?? 'none'}`} ${seconds(s.durationMs)}`,
  );
  const failed = runtime.steps.find((s) => !s.passed);
  return [
    `${runtime.runtime.padEnd(16)}${runtime.passed ? 'pass' : 'FAIL'} (${steps.join(', ')}) in ${runtime.copyDir}`,
    ...(failed === undefined ? [] : failed.outputTail.split('\n').map((line) => `    | ${line}`)),
  ];
}

function exampleLines(summary: E2eSummary): string[] {
  const passed = summary.examples.filter((e) => e.mismatch === null).length;
  const counted = summary.examples.length === 0 ? 'not run' : `${passed}/${summary.examples.length} passed`;
  return [
    `examples        ${summary.examplesError ?? counted}`,
    ...summary.examples.flatMap((e) => (e.mismatch === null ? [] : [`    - ${e.command}`, `      ${e.mismatch}`])),
  ];
}

/** The summary as plain text lines. */
export function formatSummary(summary: E2eSummary): string {
  const measured = summary.factoryWallMs === undefined ? 'not run' : seconds(summary.factoryWallMs);
  return [
    '',
    '== end-to-end summary ==',
    `spec            ${summary.specName}`,
    `run id          ${summary.runId ?? UNAVAILABLE}`,
    `outcome         ${summary.outcome}`,
    `wall time       ${summary.report?.wallTime ?? UNAVAILABLE} (report), ${measured} (measured)`,
    ...taskLines(summary.report?.tasks ?? []),
    ...summary.runtimes.flatMap(runtimeLines),
    ...exampleLines(summary),
    ...summary.notes.map((note) => `note            ${note}`),
    `result          ${summary.passed ? 'PASS' : 'FAIL'}`,
  ].join('\n');
}
