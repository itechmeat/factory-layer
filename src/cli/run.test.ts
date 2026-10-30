/**
 * The run command's exit-code mapping, run id and two-step shutdown, which
 * an end-to-end run cannot exercise on demand: the first signal aborts the
 * run's cutoff controller, the second kills every live command process
 * group and exits 130 at once, and a run that throws is a failed one.
 */

import { describe, expect, test } from 'bun:test';

import { tmpdir } from 'node:os';

import { runCommand as runBoundedCommand } from '../adapters/check-runner/process';
import { pgrepCount, waitFor } from '../adapters/check-runner/testing/process-count';
import type { RunRequest, RunResult } from '../application/index';
import { RUN_ID_PATTERN } from '../adapters/trace-fs/read';
import { makeSpec } from '../domain/spec';
import { EXIT, exitCodeOf, newRunId, runCommand, type SignalSource } from './run';

type Fake = (request: RunRequest) => Promise<RunResult>;

/** A signal source the test fires by hand. */
class FakeSignals implements SignalSource {
  readonly listeners = new Map<string, Set<() => void>>();

  on(event: string, listener: () => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }

  off(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  count(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}
const REQUEST: RunRequest = { runId: 'r1', spec: makeSpec({ markdown: '# spec', sourceFile: 'spec.md' }), options: {} };

function harness(run: Fake): {
  signals: FakeSignals;
  cutoff: AbortController;
  lines: string[];
  exits: number[];
  run: () => ReturnType<typeof runCommand>;
} {
  const signals = new FakeSignals();
  const cutoff = new AbortController();
  const lines: string[] = [];
  const exits: number[] = [];
  const start = (): ReturnType<typeof runCommand> =>
    runCommand({ factory: { run }, signals, cutoff, write: (line) => lines.push(line), exit: (code) => exits.push(code) }, REQUEST);
  return { signals, cutoff, lines, exits, run: start };
}

describe('exit codes', () => {
  test('succeeded is 0, failed 1, partial 3; 2 stays the usage error', () => {
    expect([exitCodeOf('succeeded'), exitCodeOf('failed'), exitCodeOf('partial')]).toEqual([0, 1, 3]);
    expect(EXIT.usage).toBe(2);
  });

  test('a run that throws prints a failed outcome and exits 1 with its run id', async () => {
    const { run, lines } = harness(() => Promise.reject(new Error('boom')));
    expect(await run()).toEqual({ code: 1, runId: 'r1' });
    expect(lines.at(-1)).toContain('outcome: failed');
  });

  test('the run id is one safe directory name made of the spec name and the time', () => {
    const id = newRunId('wordfreq-20261030t120000z', new Date('2026-10-30T12:34:56.789Z'), 'ab12');
    expect(id).toBe('wordfreq-20261030t120000z-20261030t123456z-ab12');
    expect(RUN_ID_PATTERN.test(newRunId('todo', new Date()))).toBe(true);
  });
});

describe('signals', () => {
  test('the first signal aborts the signal passed to the run (its cutoff), the second exits 130 at once; listeners are removed after the run', async () => {
    const { promise: aborted, resolve } = Promise.withResolvers<void>();
    let received: AbortSignal | undefined;
    const { signals, cutoff, exits, run, lines } = harness(async (request) => {
      received = request.signal;
      request.signal?.addEventListener('abort', () => resolve());
      await aborted;
      return { outcome: 'partial', runId: 'r1', reason: 'cutoff', deliveredDir: 'out/spec', verified: false };
    });
    const running = run();
    expect(received).toBe(cutoff.signal);
    signals.emit('SIGINT');
    expect(cutoff.signal.aborted).toBe(true);
    expect(exits).toEqual([]);
    signals.emit('SIGTERM');
    expect(exits).toEqual([130]);
    expect(await running).toEqual({ code: 3, runId: 'r1' });
    expect(lines).toContain('run id: r1');
    expect(signals.count()).toBe(0);
  });

  test('the second signal kills a command process group that is still running before it exits', async () => {
    const mark = `fcr-orphan-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const command = runBoundedCommand({
      command: 'bash',
      args: ['-c', 'sleep 4174; true', mark],
      cwd: '.',
      env: { PATH: process.env['PATH'] ?? '', HOME: tmpdir() },
      timeoutMs: 60_000,
      secrets: [],
    });
    const { promise: never } = Promise.withResolvers<RunResult>();
    const { signals, exits, run } = harness(() => never);
    void run();
    await waitFor(async () => (await pgrepCount(mark)) > 0);
    signals.emit('SIGINT');
    signals.emit('SIGINT');
    expect(exits).toEqual([130]);
    await command;
    await waitFor(async () => (await pgrepCount(mark)) === 0);
  });
});
