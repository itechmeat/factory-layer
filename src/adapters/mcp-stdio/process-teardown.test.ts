import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';

import { McpTeardownError } from './errors';
import { isProcessAlive, terminateProcess } from './process-teardown';

const STUBBORN_SCRIPT = "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000);";

function spawnStubborn(): number {
  const child = spawn(process.execPath, ['-e', STUBBORN_SCRIPT], { stdio: 'ignore' });
  if (child.pid === undefined) throw new Error('spawn gave no pid');
  return child.pid;
}

describe('isProcessAlive', () => {
  test('is true for this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test('is false for a pid that does not exist', () => {
    expect(isProcessAlive(2_147_483_000)).toBe(false);
  });
});

describe('terminateProcess', () => {
  test('kills a process that ignores the graceful close at the end of the grace period', async () => {
    const pid = spawnStubborn();
    const started = performance.now();
    await terminateProcess({ pid, graceMs: 300, close: () => new Promise<void>(() => {}) });
    const elapsed = performance.now() - started;
    expect(isProcessAlive(pid)).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(1300);
  });

  test('a rejecting close neither rejects nor leaves the process alive', async () => {
    const pid = spawnStubborn();
    await terminateProcess({
      pid,
      graceMs: 200,
      close: async () => {
        throw new Error('close failed');
      },
    });
    expect(isProcessAlive(pid)).toBe(false);
  });

  test('reports a typed teardown error when the pid outlives the kill', async () => {
    const started = performance.now();
    const error = await terminateProcess({
      pid: process.pid,
      graceMs: 50,
      close: async () => {},
      kill: () => {},
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpTeardownError);
    expect(error).toMatchObject({ kind: 'teardown', pid: process.pid });
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
