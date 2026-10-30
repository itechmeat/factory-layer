/**
 * The `factory report` and `factory intervene` commands over a run's
 * directory (`runs/<run id>/`). `report` renders the Markdown report from
 * the run's trace alone, writes it to `runs/<run id>/report.md` and prints
 * it; `intervene` records a human note through the run store, which
 * appends it to the trace with its time. Both refuse a run id
 * that has no trace.
 */

import { renderReport, writeReport } from '../adapters/report-markdown/report';
import { readTrace, runDir } from '../adapters/trace-fs/read';
import type { RunStore } from '../ports/run-store';

/** The exit code of a command over a run: 0 done, 1 when the run has no trace. */
type Code = 0 | 1;

/** Renders, writes and prints the report of `runId`; returns the written file or the exit code 1. */
export async function writeRunReport(root: string, runId: string, write: (line: string) => void): Promise<string | null> {
  const directory = runDir(root, runId);
  const { events, invalid } = readTrace(directory);
  if (events.length === 0) {
    write(`no trace for run ${runId} under ${directory}`);
    return null;
  }
  for (const line of invalid) write(`warning: trace line ${String(line.line)} skipped: ${line.detail}`);
  const { file } = await writeReport(directory, renderReport(events, { title: `Factory run ${runId}` }));
  return file;
}

/** `factory report <runId>`. */
export async function reportCommand(root: string, runId: string, write: (line: string) => void): Promise<Code> {
  const file = await writeRunReport(root, runId, write);
  if (file === null) return 1;
  write(await Bun.file(file).text());
  write(`report written to ${file}`);
  return 0;
}

/** `factory intervene <runId> <note>`. */
export async function interveneCommand(info: {
  root: string;
  store: RunStore;
  runId: string;
  note: string;
  write: (line: string) => void;
}): Promise<Code> {
  const directory = runDir(info.root, info.runId);
  if (readTrace(directory).events.length === 0) {
    info.write(`no trace for run ${info.runId} under ${directory}`);
    return 1;
  }
  const recorded = await info.store.appendIntervention(info.runId, info.note);
  info.write(`intervention recorded for run ${info.runId} at ${recorded.at}`);
  return 0;
}
