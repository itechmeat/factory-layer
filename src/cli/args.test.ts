import { describe, expect, test } from 'bun:test';

import { parseArgs, UsageError } from './args';

/** 18:05 local time today, the start of every run here. */
function localNow(): Date {
  const now = new Date();
  now.setHours(18, 5, 0, 0);
  return now;
}

describe('parseArgs, run options', () => {
  test('--cutoff HH:MM is that local time today, as epoch ms', () => {
    const now = localNow();
    const expected = new Date(now);
    expected.setHours(19, 15, 0, 0);
    const command = parseArgs(['run', 'a.md', '--cutoff', '19:15'], now);
    expect(command.name === 'run' ? command.cutoffAtMs : null).toBe(expected.getTime());
  });

  test('--cutoff in the past or unparsable is a usage error', () => {
    const now = localNow();
    expect(() => parseArgs(['run', 'a.md', '--cutoff', '09:00'], now)).toThrow(UsageError);
    expect(() => parseArgs(['run', 'a.md', '--cutoff', 'soon'], now)).toThrow(UsageError);
  });

  test('--task-concurrency maps to the run task concurrency', () => {
    const command = parseArgs(['run', 'a.md', '--task-concurrency', '2']);
    expect(command.name === 'run' ? command.taskConcurrency : null).toBe(2);
  });

  test('--task-concurrency other than a positive integer is a usage error', () => {
    for (const value of ['0', '-1', '1.5', 'two', '', '99999999999999999999']) {
      expect(() => parseArgs(['run', 'a.md', '--task-concurrency', value])).toThrow(UsageError);
    }
  });
});

describe('parseArgs, author', () => {
  test('author takes a kind and an example file named by --example', () => {
    expect(parseArgs(['author', 'readme', '--example', 'x.md'])).toEqual({ name: 'author', taskKind: 'readme', examplePath: 'x.md' });
  });

  test('author without --example is a usage error', () => {
    expect(() => parseArgs(['author', 'readme', 'x.md'])).toThrow(UsageError);
    expect(() => parseArgs(['author', 'readme', '--out', 'x.md'])).toThrow(UsageError);
  });
});
