/**
 * The run's trace as the operator sees it: a `TraceSink` that writes every
 * event to its run's `trace.jsonl` (one file sink per run id, created on the
 * first event) and prints one plain line, with the time, for each notable
 * event (decisions, plan, task state changes, recoveries, cutoff, delivery,
 * the run's start and end). Printed lines come from the redacted event, so a
 * configured secret never reaches the terminal.
 */

import { redactJson } from '../domain/redact';
import type { TraceEvent } from '../domain/trace-event';
import { runDir } from '../adapters/trace-fs/read';
import { FileTraceSink } from '../adapters/trace-fs/trace-fs';
import type { TraceSink } from '../ports/trace-sink';

function where(event: TraceEvent): string {
  if (event.taskId === undefined) return '';
  return ` [${event.taskId}${event.revision === undefined ? '' : ` r${String(event.revision)}`}]`;
}

/** The text of a notable event, or `null` for one the terminal does not show. */
export function eventText(event: TraceEvent): string | null {
  switch (event.type) {
    case 'run_started':
      return `run ${event.runId} started for spec ${event.specName}`;
    case 'run_ended':
      return `run ended: ${event.outcome}${event.reason === null ? '' : ` (${event.reason})`}`;
    case 'plan_produced':
      return `plan (${event.source}): ${String(event.taskCount)} tasks`;
    case 'plan_rejected':
      return `plan (${event.source}) rejected: ${event.reasons.map((reason) => reason.kind).join(', ')}`;
    case 'acceptance_produced':
      return `acceptance: ${String(event.checkIds.length)} checks`;
    case 'acceptance_unavailable':
      return `acceptance unavailable: ${event.reason}`;
    case 'acceptance_check_dropped':
      return `acceptance check ${event.checkId} dropped (${event.stage}): ${event.reason}`;
    case 'decision_started':
      return `decision ${event.kind} started`;
    case 'decision_ended':
      return `decision ${event.kind} ${event.outcome}${event.detail === '' ? '' : `: ${event.detail}`}`;
    case 'task_state_changed':
      return `${event.from} -> ${event.to} (${event.reason})`;
    case 'executor_failure':
      return `executor failure: ${event.reason}`;
    case 'recovery_chosen':
      return `recovery: ${event.choice}${event.detail === '' ? '' : ` (${event.detail})`}`;
    case 'replan_started':
      return 're-plan started';
    case 'replan_ended':
      return `re-plan ${event.ok ? 'done' : 'failed'}: ${event.detail}`;
    case 'merge_conflict':
      return `merge conflict: ${event.paths.join(', ')}`;
    case 'cutoff_reached':
      return 'cutoff reached: stopping live runs and delivering what is integrated';
    case 'delivery_done':
      return `delivery: ${event.copied ? `copied to ${event.outDir ?? 'unknown'}` : 'nothing copied'}, ${event.verified ? 'verified' : 'not verified'}`;
    case 'memory_failed':
      return `memory ${event.phase} failed: ${event.reason}`;
    case 'storage_failed':
      return `storage failed: ${event.reason}`;
    case 'executor_started':
    case 'executor_event':
    case 'executor_ended':
    case 'executor_stopped':
    case 'checks_run':
    case 'verdict':
    case 'recovery_command':
    case 'merge_produced':
    case 'main_advanced':
    case 'delivery_step':
    case 'orphan_found':
    case 'stale_result_discarded':
    case 'intervention_recorded':
      return null;
  }
}

/** One printed line: the time of day, the task when there is one, and the text. */
export function eventLine(event: TraceEvent): string | null {
  const text = eventText(event);
  return text === null ? null : `${event.at.slice(11, 19)}${where(event)} ${text}`;
}

/** Writes each event to its run's trace file and prints its line. */
export class PrintingTraceSink implements TraceSink {
  readonly #root: string;
  readonly #write: (line: string) => void;
  readonly #secrets: readonly string[];
  readonly #files = new Map<string, FileTraceSink>();

  /** `root` holds `runs/<run id>/`; `secrets` are redacted from files and lines. */
  constructor(root: string, write: (line: string) => void, secrets: readonly string[]) {
    this.#root = root;
    this.#write = write;
    this.#secrets = secrets;
  }

  emit(event: TraceEvent): void {
    let file = this.#files.get(event.runId);
    if (file === undefined) {
      file = new FileTraceSink(runDir(this.#root, event.runId));
      file.setSecrets(this.#secrets);
      this.#files.set(event.runId, file);
    }
    file.emit(event);
    const line = eventLine(redactJson(event, this.#secrets));
    if (line !== null) this.#write(line);
  }
}
