/**
 * The trace of one factory run as the application writes it: every event is
 * stamped with the run's correlation base (time, run id, spec name) and
 * redacted with the run's secret set (the credentials of the run options plus
 * every supervisor token as it is learned) before it reaches the sink, so no
 * secret leaves through the trace even when the sink does not redact.
 */

import { redactJson, redactString, type TraceEvent } from '../domain';
import type { Clock, TraceSink } from '../ports';

/** Removes keys from every member of a union, keeping the union discriminated. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as a caller writes it: the base fields are filled in by the trace. */
export type TraceEventBody = DistributiveOmit<TraceEvent, 'at' | 'runId'>;

export class RunTrace {
  private readonly sink: TraceSink;
  private readonly clock: Clock;
  private readonly secrets: string[];
  readonly runId: string;
  readonly specName: string;

  constructor(info: { sink: TraceSink; clock: Clock; runId: string; specName: string; secrets: readonly string[] }) {
    this.sink = info.sink;
    this.clock = info.clock;
    this.runId = info.runId;
    this.specName = info.specName;
    this.secrets = info.secrets.filter((secret) => secret.length > 0);
  }

  /** The current instant as an ISO string. */
  now(): string {
    return this.clock.now().toISOString();
  }

  /** The current instant in epoch milliseconds. */
  nowMs(): number {
    return this.clock.now().getTime();
  }

  /** Adds a secret (a supervisor token) redacted from every later event and text. */
  addSecret(secret: string): void {
    if (secret.length > 0 && !this.secrets.includes(secret)) {
      this.secrets.push(secret);
    }
  }

  /** Redacts a text with the run's secret set. */
  redact(text: string): string {
    return redactString(text, this.secrets);
  }

  /** Emits an event stamped now with the run id and the spec name. */
  emit(body: TraceEventBody): void {
    this.emitEvent({ specName: this.specName, ...body, at: this.now(), runId: this.runId });
  }

  /** Emits a complete event (from the decision wrapper), adding the spec name and redacting it. */
  emitEvent(event: TraceEvent): void {
    this.sink.emit(redactJson({ specName: this.specName, ...event }, this.secrets));
  }
}
