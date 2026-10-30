/**
 * The file trace sink: appends every trace event as exactly one JSON line
 * to the run's trace.jsonl, synchronously, so the line is on disk before
 * emit returns. The run directory is owner-only (0700) and so is the file
 * (0600). Invariant: every event is redacted against the current
 * secret set before it is written, so no configured secret can reach the
 * file through any string of the event. `emit` never throws, as the port
 * requires: a failed write (a full or read-only disk) is counted and
 * reported once on stderr.
 */

import { join } from 'node:path';

import { redactJson } from '../../domain/redact';
import type { TraceEvent } from '../../domain/trace-event';
import type { TraceSink } from '../../ports/trace-sink';
import { appendPrivate, ensurePrivateDir } from './private-files';
import { TRACE_FILE_NAME } from './read';

/** Writes the run's trace events to `<dir>/trace.jsonl`, one JSON line per event. */
export class FileTraceSink implements TraceSink {
  private readonly dir: string;
  private readonly report: (line: string) => void;
  private secrets: readonly string[] = [];
  /** How many events could not be written. */
  failedWrites = 0;

  /** `dir` is the run directory that receives `trace.jsonl`; `report` gets the first write failure (stderr by default). */
  constructor(dir: string, report: (line: string) => void = (line) => console.error(line)) {
    this.dir = dir;
    this.report = report;
  }

  /** Replaces the redacted secret set; it applies from the next emit on. */
  setSecrets(secrets: readonly string[]): void {
    this.secrets = [...secrets];
  }

  emit(event: TraceEvent): void {
    const line = JSON.stringify(redactJson(event, this.secrets));
    try {
      ensurePrivateDir(this.dir);
      appendPrivate(join(this.dir, TRACE_FILE_NAME), `${line}\n`);
    } catch (error) {
      this.failedWrites += 1;
      if (this.failedWrites === 1) {
        const detail = redactJson(error instanceof Error ? error.message : String(error), this.secrets);
        this.report(`trace write failed for ${this.dir} (later failures are counted, not reported): ${detail}`);
      }
    }
  }
}
