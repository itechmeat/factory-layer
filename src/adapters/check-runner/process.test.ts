import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';

import { CHECK_OUTPUT_LIMIT_BYTES } from '../../domain/limits';
import { REDACTED } from '../../domain/redact';
import { TRUNCATION_MARK } from './output';
import { runCommand } from './process';
import { pgrepCount, waitFor } from './testing/process-count';

const HERE = '.';
const ENV = { PATH: process.env['PATH'] ?? '', HOME: tmpdir() };

describe('runCommand', () => {
  test('a hanging command is reported as timed out and its whole process group dies', async () => {
    const mark = `fcr-hang-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const started = performance.now();
    // Two commands keep bash alive as the group leader; its child sleeps under a rare name.
    const pending = runCommand({
      command: 'bash',
      args: ['-c', 'sleep 4171; true', mark],
      cwd: HERE,
      env: ENV,
      timeoutMs: 300,
      secrets: [],
    });
    await Bun.sleep(100);
    expect(await pgrepCount(mark)).toBeGreaterThan(0);

    const outcome = await pending;
    const elapsed = performance.now() - started;
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).toBeNull();
    expect(outcome.spawnFailure).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(2000);
    await waitFor(async () => (await pgrepCount(mark)) === 0 && (await pgrepCount('sleep 4171')) === 0);
  });

  test('a timed out command settles soon after the kill even when an escaped descendant holds its pipes', async () => {
    const mark = `fcr-escape-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const started = performance.now();
    // setsid moves the background sleep out of the killed process group; it keeps stdout open for 6 s.
    const outcome = await runCommand({
      command: 'bash',
      args: ['-c', 'setsid sleep 6 & sleep 30', mark],
      cwd: HERE,
      env: ENV,
      timeoutMs: 1000,
      secrets: [],
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).toBeNull();
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test('an abort while the command runs kills its whole process group', async () => {
    const mark = `fcr-abort-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const controller = new AbortController();
    const pending = runCommand({
      command: 'bash',
      args: ['-c', 'sleep 4173; true', mark],
      cwd: HERE,
      env: ENV,
      timeoutMs: 30_000,
      secrets: [],
      signal: controller.signal,
    });
    await Bun.sleep(100);
    controller.abort();
    const outcome = await pending;
    expect(outcome.exitCode).toBeNull();
    await waitFor(async () => (await pgrepCount(mark)) === 0);
  });

  test('a command that cannot be spawned is a typed spawn failure, not a throw', async () => {
    const outcome = await runCommand({ command: 'fcr-no-such-binary', args: [], cwd: HERE, env: ENV, timeoutMs: 1000, secrets: [] });
    expect(outcome.spawnFailure).not.toBeNull();
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).toBeNull();
    expect(outcome.stdout).toBe('');
    expect(outcome.stderr).toBe('');
  });

  test('output is redacted before it is truncated, so no secret survives the cut', async () => {
    const outcome = await runCommand({
      command: 'bash',
      args: ['-c', 'for i in $(seq 1 20000); do echo "pass hunter2 line $i"; done'],
      cwd: HERE,
      env: ENV,
      timeoutMs: 10_000,
      secrets: ['hunter2'],
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).not.toContain('hunter2');
    expect(outcome.stdout).toContain(REDACTED);
    expect(outcome.stdout).toContain(TRUNCATION_MARK);
    expect(Buffer.byteLength(outcome.stdout)).toBeLessThanOrEqual(CHECK_OUTPUT_LIMIT_BYTES + TRUNCATION_MARK.length);
  });

  test('a flood of output keeps its head and its tail within the cap', async () => {
    const outcome = await runCommand({
      command: 'bash',
      args: ['-c', 'echo FIRST-LINE; head -c 20000000 /dev/zero | tr "\\0" x; echo; echo LAST-LINE'],
      cwd: HERE,
      env: ENV,
      timeoutMs: 20_000,
      secrets: [],
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.startsWith('FIRST-LINE')).toBe(true);
    expect(outcome.stdout.trimEnd().endsWith('LAST-LINE')).toBe(true);
    expect(Buffer.byteLength(outcome.stdout)).toBeLessThanOrEqual(CHECK_OUTPUT_LIMIT_BYTES + TRUNCATION_MARK.length);
  });

  test('a clean exit reports the exit code and both streams', async () => {
    const outcome = await runCommand({
      command: 'bash',
      args: ['-c', 'echo out-line; echo err-line >&2; exit 3'],
      cwd: HERE,
      env: ENV,
      timeoutMs: 2000,
      secrets: [],
    });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.spawnFailure).toBeNull();
    expect(outcome.stdout).toBe('out-line\n');
    expect(outcome.stderr).toBe('err-line\n');
    expect(outcome.elapsedMs).toBeGreaterThan(0);
  });

  test('given stdin is written and closed', async () => {
    const outcome = await runCommand({
      command: 'bash',
      args: ['-c', 'tr a-z A-Z'],
      cwd: HERE,
      env: ENV,
      timeoutMs: 2000,
      stdin: 'loud',
      secrets: [],
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe('LOUD');
  });
});
