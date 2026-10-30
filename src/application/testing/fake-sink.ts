/**
 * A `TraceSink` for tests: it keeps every event in emission order and offers
 * typed filters (`ofType`) and the interval of one brain decision
 * (`decisionInterval`) so tests can assert what the trace recorded.
 */

import type { TraceEvent } from '../../domain';
import type { TraceSink } from '../../ports';

export class FakeSink implements TraceSink {
  private readonly eventLog: TraceEvent[] = [];

  /** Every emitted event, in emission order. */
  get events(): readonly TraceEvent[] {
    return this.eventLog;
  }

  emit(event: TraceEvent): void {
    this.eventLog.push(event);
  }

  /** The events of one type, in emission order. */
  ofType<K extends TraceEvent['type']>(type: K): Array<Extract<TraceEvent, { type: K }>> {
    return this.eventLog.filter((event): event is Extract<TraceEvent, { type: K }> => event.type === type);
  }

  /** The { start, end } instants of the decision, or null when either is missing. */
  decisionInterval(decisionId: string): { readonly start: string; readonly end: string } | null {
    const start = this.eventLog.find((event) => event.type === 'decision_started' && event.decisionId === decisionId);
    const end = this.eventLog.find((event) => event.type === 'decision_ended' && event.decisionId === decisionId);
    return start === undefined || end === undefined ? null : { start: start.at, end: end.at };
  }
}
