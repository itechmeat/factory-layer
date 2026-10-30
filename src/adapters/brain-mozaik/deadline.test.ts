import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { raceDeadline } from './deadline';

describe('raceDeadline', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  test('a late rejection of abandoned work after the deadline is not an unhandled rejection', async () => {
    let failLate: (error: Error) => void = () => undefined;
    const work = new Promise<string>((_resolve, reject) => {
      failLate = reject;
    });

    await expect(raceDeadline(work, 5, () => new Error('deadline passed'))).rejects.toThrow('deadline passed');
    failLate(new Error('late failure of abandoned work'));
    // Let the rejection propagate and the runtime report it if nobody observes it.
    await Bun.sleep(50);

    expect(unhandled).toEqual([]);
  });
});
