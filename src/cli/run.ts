/**
 * The `factory run` command: names the run (a safe slug of the spec name and
 * the start time), hands the spec to the core's `RunFactory`, takes the
 * cutoff path on the first SIGINT or SIGTERM (which also kills the check
 * commands running at that moment) and leaves at once with exit code 130
 * on the second, after killing every command process group still alive
 * (the run store saves the state on every change, so nothing is pending),
 * then prints the outcome, the delivered directory and
 * the run id, and maps the outcome to the exit code: 0 succeeded, 1 failed,
 * 3 partial (2 is a usage error).
 */

import { randomBytes } from 'node:crypto';

import { killLiveProcessGroups } from '../adapters/check-runner/process';
import { messageOf } from '../adapters/mcp-stdio/errors';
import type { RunRequest, RunResult } from '../application/index';
import type { RunOutcome } from '../domain/run-state';

/** Exit codes of the CLI. */
export const EXIT = { succeeded: 0, failed: 1, usage: 2, partial: 3, interrupted: 130 } as const;

/** The exit code of a run outcome. */
export function exitCodeOf(outcome: RunOutcome): number {
  return EXIT[outcome];
}

/** A run id for `specName` started at `now`: `<spec>-<yyyymmddthhmmssz>-<4 hex>`, one safe directory name. */
export function newRunId(specName: string, now: Date, suffix: string = randomBytes(2).toString('hex')): string {
  const stamp = now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'z')
    .toLowerCase();
  return `${specName}-${stamp}-${suffix}`;
}

/** Where the process signals come from; `process` in production. */
export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Installs the two-step shutdown: the first signal aborts `controller`, the
 * second calls `exit(130)`. Returns the uninstaller.
 */
export function installShutdown(
  source: SignalSource,
  controller: AbortController,
  write: (line: string) => void,
  exit: (code: number) => void,
): () => void {
  let received = 0;
  const onSignal = (): void => {
    received += 1;
    if (received === 1) {
      write('signal received: taking the cutoff path (stopping live runs, delivering what is integrated); a second signal exits at once');
      controller.abort(new Error('interrupted by a signal'));
      return;
    }
    write('second signal: the run state is saved on every change; exiting now');
    killLiveProcessGroups();
    exit(EXIT.interrupted);
  };
  for (const name of SIGNALS) source.on(name, onSignal);
  return () => {
    for (const name of SIGNALS) source.off(name, onSignal);
  };
}

/** The core's use case as this command calls it; `RunFactory` in production. */
export interface FactoryRunner {
  run(request: RunRequest): Promise<RunResult>;
}

/** What the run command needs beyond its request. */
export interface RunCommandDeps {
  readonly factory: FactoryRunner;
  readonly signals: SignalSource;
  /** Aborted by the first signal: the run's cutoff. */
  readonly cutoff: AbortController;
  readonly write: (line: string) => void;
  readonly exit: (code: number) => void;
}

/**
 * Runs the factory once with the cutoff controller's signal as the run's
 * abort signal and returns the exit code; a run that throws is `failed`.
 */
export async function runCommand(command: RunCommandDeps, request: RunRequest): Promise<{ readonly code: number; readonly runId: string }> {
  const uninstall = installShutdown(command.signals, command.cutoff, command.write, command.exit);
  command.write(`run id: ${request.runId}`);
  try {
    const result = await command.factory.run({ ...request, signal: command.cutoff.signal });
    command.write(`outcome: ${result.outcome}${result.reason === null ? '' : ` (${result.reason})`}`);
    command.write(`out: ${result.deliveredDir ?? 'nothing delivered'}`);
    command.write(`verified: ${result.verified ? 'yes' : 'no'}`);
    return { code: exitCodeOf(result.outcome), runId: result.runId };
  } catch (error) {
    command.write(`outcome: failed (${messageOf(error)})`);
    return { code: EXIT.failed, runId: request.runId };
  } finally {
    uninstall();
  }
}
