/**
 * A `Map`-backed `RunStore` for tests: states saved as JSON deep clones, a
 * snapshot and restore for crash-point tests, saves that fail on demand with
 * a `StorageError`, and interventions timestamped by the injected clock.
 */

import { RunStateSchema, type RunState } from '../../domain';
import { StorageError, type Clock, type RunStore } from '../../ports';

/** The detail of a scripted storage failure. */
const FAILURE_DETAIL = 'storage failure scripted by the test';

/** One human intervention the fake recorded. */
export interface FakeIntervention {
  readonly at: string;
  readonly note: string;
}

function deepClone(state: RunState): RunState {
  return RunStateSchema.parse(JSON.parse(JSON.stringify(state)));
}

export class FakeStore implements RunStore {
  private readonly clock: Clock;
  private readonly states = new Map<string, RunState>();
  private readonly interventionsByRun = new Map<string, FakeIntervention[]>();
  private failuresLeft = 0;

  constructor(deps: { clock: Clock }) {
    this.clock = deps.clock;
  }

  /** Every intervention recorded for the run, in order. */
  interventionsFor(runId: string): readonly FakeIntervention[] {
    return this.interventionsByRun.get(runId) ?? [];
  }

  /** Makes the next save calls throw a StorageError, then saving works again. */
  failSaves(times: number): void {
    this.failuresLeft = times;
  }

  /** The states currently held, as one JSON document for a crash-point snapshot. */
  snapshot(): string {
    return JSON.stringify(Object.fromEntries(this.states));
  }

  /** Replaces everything held with the states of the snapshot, validated and cloned again. */
  restore(snapshot: string): void {
    const raw: unknown = JSON.parse(snapshot);
    if (typeof raw !== 'object' || raw === null) {
      throw new StorageError({ detail: 'malformed snapshot' });
    }
    this.states.clear();
    for (const [runId, value] of Object.entries(raw)) {
      this.states.set(runId, RunStateSchema.parse(value));
    }
  }

  async save(state: RunState): Promise<void> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new StorageError({ detail: FAILURE_DETAIL });
    }
    this.states.set(state.runId, deepClone(state));
  }

  async load(runId: string): Promise<RunState | null> {
    const stored = this.states.get(runId);
    return stored === undefined ? null : deepClone(stored);
  }

  async appendIntervention(runId: string, note: string): Promise<FakeIntervention> {
    const intervention: FakeIntervention = { at: this.clock.now().toISOString(), note };
    const existing = this.interventionsByRun.get(runId);
    if (existing === undefined) {
      this.interventionsByRun.set(runId, [intervention]);
    } else {
      existing.push(intervention);
    }
    return intervention;
  }
}
