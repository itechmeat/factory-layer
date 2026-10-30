/**
 * A `Memory` for tests: recall batches scripted in order (empty by default),
 * on-demand recall and remember failures, and every remember recorded, so
 * tests can drive the memory failure paths without OSB.
 */

import type { Spec } from '../../domain';
import { MemoryError, type Memory, type RecalledRun, type RunOutcomeRecord } from '../../ports';

/** The detail of a scripted memory failure. */
const FAILURE_DETAIL = 'memory failure scripted by the test';

/** One recall call the fake recorded. */
export interface FakeRecallCall {
  readonly specName: string;
  readonly limit: number;
}

export class FakeMemory implements Memory {
  private readonly recallBatches: RecalledRun[][] = [];
  private readonly rememberLog: RunOutcomeRecord[] = [];
  private readonly recallCallLog: FakeRecallCall[] = [];
  private recallFailuresLeft = 0;
  private rememberFailuresLeft = 0;

  /** Every remembered outcome, in order. */
  get remembered(): readonly RunOutcomeRecord[] {
    return this.rememberLog;
  }

  /** Every recall call, in call order. */
  get recallCalls(): readonly FakeRecallCall[] {
    return this.recallCallLog;
  }

  /** Scripts one batch the next recall call returns; calls without a batch return nothing. */
  recallReturns(runs: readonly RecalledRun[]): void {
    this.recallBatches.push([...runs]);
  }

  /** Makes the next recall calls reject with a MemoryError, then recall works again. */
  failRecall(times: number): void {
    this.recallFailuresLeft = times;
  }

  /** Makes the next remember calls reject with a MemoryError, then remember works again. */
  failRemember(times: number): void {
    this.rememberFailuresLeft = times;
  }

  async recall(spec: Spec, limit: number, _signal: AbortSignal): Promise<readonly RecalledRun[]> {
    this.recallCallLog.push({ specName: spec.name, limit });
    if (this.recallFailuresLeft > 0) {
      this.recallFailuresLeft -= 1;
      throw new MemoryError({ reason: 'failed', detail: FAILURE_DETAIL });
    }
    return this.recallBatches.shift() ?? [];
  }

  async remember(outcome: RunOutcomeRecord, _signal: AbortSignal): Promise<void> {
    if (this.rememberFailuresLeft > 0) {
      this.rememberFailuresLeft -= 1;
      throw new MemoryError({ reason: 'failed', detail: FAILURE_DETAIL });
    }
    this.rememberLog.push(outcome);
  }
}
