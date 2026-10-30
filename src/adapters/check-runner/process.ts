/**
 * Bounded command execution for the check runner and the end-to-end
 * script: every command runs detached as a process group leader, with
 * exactly the environment its caller gives (nothing is inherited), and a
 * hard timeout that kills the whole group; an abort signal that fires while
 * the command runs kills the group too. Every live group is held in a
 * registry, so the process can kill them all before it exits. Invariant:
 * the returned promise always settles within the timeout plus one read
 * grace after the command exits and never throws, whatever the command
 * did (plus the term grace when one is given), even when a descendant
 * that escaped the group keeps the pipes open;
 * its streams come back redacted and capped.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type { CommandOutcome } from '../../ports/check-runner';
import type { ChildEnv } from '../child-env';
import { CappedCollector } from './output';

/**
 * How long the runner keeps reading after the command exited. A descendant
 * that left the process group (setsid) survives the kill and may hold the
 * pipes open indefinitely; the result settles with the output read so far.
 */
const EXIT_READ_GRACE_MS = 250;

/** What every command of one check-runner batch shares: the secrets to redact, the scratch HOME, the run's abort. */
export interface Batch {
  readonly secrets: readonly string[];
  readonly home: string;
  readonly signal?: AbortSignal | undefined;
}

/** One bounded command to run. */
export interface RunCommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdin?: string;
  /** The whole environment of the command; nothing of the factory's own environment is inherited. */
  readonly env: ChildEnv;
  readonly secrets: readonly string[];
  /**
   * Kills the command's group when it fires while the command runs. A
   * command started after the abort runs normally, so the cutoff path can
   * still verify its delivery.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * After the timeout the leader gets SIGTERM and the group SIGKILL only
   * after this grace, in milliseconds; without it the group is killed at
   * once.
   */
  readonly termGraceMs?: number;
  /** Told the leader's pid once the command started (the end-to-end script forwards Ctrl-C to it). */
  readonly onStart?: (pid: number) => void;
  /** Receives every raw output chunk as it arrives (a live copy for a human). */
  readonly onOutput?: (chunk: Buffer, stream: 'stdout' | 'stderr') => void;
}

/** The process groups started here that may still run: killed all at once before the process exits. */
const liveGroups = new Set<ChildProcess>();

/** Tracks a detached child as a live process group until it is killed or forgotten. */
export function trackProcessGroup(child: ChildProcess): void {
  liveGroups.add(child);
}

/** SIGKILLs every process group started here that may still run. */
export function killLiveProcessGroups(): void {
  for (const child of liveGroups) killProcessGroup(child);
}

/** True while a process group with this leader pid exists (signal 0 probe; EPERM means it exists). */
export function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** Kills the command's whole process group, falling back to the child alone. */
export function killProcessGroup(child: ChildProcess): void {
  liveGroups.delete(child);
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // The group is already gone: nothing to kill.
    }
  }
}

/** Runs the command bounded; captured streams are redacted with `secrets` and capped. */
export function runCommand(input: RunCommandInput): Promise<CommandOutcome> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      // The child leads its own process group, so a timeout kills its descendants too.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    trackProcessGroup(child);
    if (child.pid !== undefined) input.onStart?.(child.pid);
    let timedOut = false;
    let spawnFailure: string | null = null;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    // Both streams are capped while they are read, so a flood of output never grows the factory's memory.
    const stdout = new CappedCollector();
    const stderr = new CappedCollector();

    const timer = setTimeout(() => {
      timedOut = true;
      if (input.termGraceMs === undefined) {
        killProcessGroup(child);
        return;
      }
      child.kill('SIGTERM');
      termTimer = setTimeout(() => killProcessGroup(child), input.termGraceMs);
    }, input.timeoutMs);
    const onAbort = (): void => killProcessGroup(child);
    input.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      input.onOutput?.(chunk, 'stdout');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      input.onOutput?.(chunk, 'stderr');
    });
    child.stdin?.on('error', () => {
      // The child may exit before reading all of stdin: a broken write is not the command's outcome.
    });
    child.stdin?.end(input.stdin); // no stdin still ends the stream, so readers see EOF

    child.on('error', (error: Error) => {
      spawnFailure = error.message;
    });
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearTimeout(termTimer);
      input.signal?.removeEventListener('abort', onAbort);
      // Whatever the leader left running in its group (a background server, a stray sleep) dies with it.
      killProcessGroup(child);
      resolve({
        exitCode: timedOut || spawnFailure !== null ? null : child.exitCode,
        timedOut,
        spawnFailure: spawnFailure === null ? null : `spawn failed: ${spawnFailure}`,
        stdout: stdout.text(input.secrets),
        stderr: stderr.text(input.secrets),
        elapsedMs: Math.round(performance.now() - started),
      });
    };
    child.on('close', finish);
    child.on('exit', () => {
      graceTimer = setTimeout(finish, EXIT_READ_GRACE_MS);
    });
    child.on('error', finish); // a spawn failure may fire 'error' without a later 'close'
  });
}
