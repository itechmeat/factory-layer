/**
 * One bounded git command: spawns `git` with a hard per-command timeout,
 * kills the process when the timeout fires and reports its streams. A
 * timeout is a typed `WorkspaceError` (no exit code, redacted stderr tail);
 * a non-zero exit is a VALUE the caller decides on, because a merge
 * conflict is an outcome here, not a failure. Git sees only the variables
 * it needs for its own configuration (never a provider key) and never
 * prompts.
 */

import { redactString } from '../../domain/redact';
import { WorkspaceError, type WorkspaceErrorInfo } from '../../ports';
import { gitEnv } from '../child-env';

/** What one git command left behind. */
export interface GitOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The raw material of one git command. */
export interface GitRun {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  /** Values replaced with `[redacted]` in every error text the runner reports. */
  readonly secrets: readonly string[];
}

/** The `git ...` text a `WorkspaceError` carries for these arguments. */
export function commandText(args: readonly string[]): string {
  return `git ${args.join(' ')}`;
}

/** The redacted tail of a stderr: its last twenty lines. */
export function stderrTail(stderr: string, secrets: readonly string[]): string {
  return redactString(stderr, secrets).split('\n').slice(-20).join('\n');
}

/**
 * How long the runner waits for the pipes to close after the kill. The
 * killed git may already have started a child (a hook) that inherits the
 * pipes and outlives it; the runner stops waiting for that orphan after
 * this grace and reports the timeout.
 */
const KILL_READ_GRACE_MS = 250;

/**
 * Reads a stream to its end; gives up with what the race yields once
 * `giveUp` resolves (an orphaned grandchild may hold the pipe open long
 * after the killed git is gone).
 */
async function readAll(stream: ReadableStream<Uint8Array>, giveUp: Promise<null>): Promise<string> {
  const reading = new Response(stream).text();
  const settled = await Promise.race([reading, giveUp]);
  if (settled === null) {
    reading.catch(() => '');
    return '';
  }
  return settled;
}

/**
 * Runs one git command under the timeout and returns its exit code and
 * streams. On timeout the process is killed and a `WorkspaceError` with no
 * exit code and the redacted stderr so far is thrown; the same typed error
 * reports a command that never started (missing working directory, missing
 * binary). Never hangs: the kill and the read grace settle every wait, even
 * when a hook child outlives the killed command.
 */
export async function runGit(run: GitRun): Promise<GitOutcome> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(['git', ...run.args], {
      cwd: run.cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: gitEnv(),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new WorkspaceError({ command: commandText(run.args), exitCode: null, stderrTail: stderrTail(detail, run.secrets) });
  }
  let timedOut = false;
  let releaseReads: () => void = () => undefined;
  const readsSettled = new Promise<null>((resolve) => {
    releaseReads = () => resolve(null);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
    // The orphaned children of the killed command may still hold the pipes; wait one grace for the buffered output.
    setTimeout(releaseReads, KILL_READ_GRACE_MS);
  }, run.timeoutMs);
  const [stdout, stderr] = await Promise.all([readAll(proc.stdout, readsSettled), readAll(proc.stderr, readsSettled)]);
  clearTimeout(timer);
  const exitCode = await proc.exited;
  if (timedOut) {
    const timedOutLine = `timed out after ${run.timeoutMs} ms`;
    const info: WorkspaceErrorInfo = {
      command: commandText(run.args),
      exitCode: null,
      stderrTail: stderrTail(stderr.length > 0 ? `${stderr}\n${timedOutLine}` : timedOutLine, run.secrets),
    };
    throw new WorkspaceError(info);
  }
  return { exitCode, stdout, stderr };
}
