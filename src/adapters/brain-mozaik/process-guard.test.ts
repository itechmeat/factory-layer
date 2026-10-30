import { describe, expect, test } from 'bun:test';
import { guardUnattributedRejections, type RejectionSource } from './process-guard';

/** A stand-in for `process` that records its rejection listeners. */
class FakeProcess implements RejectionSource {
  readonly listeners: ((reason: unknown) => void)[] = [];

  on(_event: 'unhandledRejection', listener: (reason: unknown) => void): this {
    this.listeners.push(listener);
    return this;
  }

  reject(reason: unknown): void {
    for (const listener of this.listeners) listener(reason);
  }
}

describe('guardUnattributedRejections', () => {
  test('an unattributed rejection is logged, an attributed one is ignored, and the guard is installed once', () => {
    const target = new FakeProcess();
    const logged: unknown[] = [];
    const attributed = new Error('already settled on its attempt');
    const options = { isAttributed: (reason: unknown) => reason === attributed, log: (reason: unknown) => logged.push(reason) };
    guardUnattributedRejections(target, options);
    guardUnattributedRejections(target, options);
    expect(target.listeners).toHaveLength(1);

    const stray = new Error('from nowhere');
    target.reject(stray);
    target.reject(attributed);
    expect(logged).toEqual([stray]);
  });
});
