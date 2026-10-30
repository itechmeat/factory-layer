/**
 * The `factory doctor` runner: every check runs at the same time, each
 * bounded by its own deadline (a check past it is failed and its signal
 * aborted), and prints one line per check in a fixed order: `ok` with what
 * it found, or `FAIL` with why and the fix. Exit code 0 when every check
 * passed, 1 otherwise.
 */

import { messageOf } from '../adapters/mcp-stdio/errors';

/** One check: it resolves with what it found or rejects with why it failed. */
export interface DoctorCheck {
  readonly name: string;
  readonly deadlineMs: number;
  /** What the operator should do when the check fails. */
  readonly fix: string;
  run(signal: AbortSignal): Promise<string>;
}

/** What one check found. */
export interface DoctorResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Runs one check within its deadline. */
async function settle(check: DoctorCheck): Promise<DoctorResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer within ${String(check.deadlineMs)} ms`));
    }, check.deadlineMs);
  });
  try {
    const detail = await Promise.race([check.run(controller.signal), deadline]);
    return { name: check.name, ok: true, detail };
  } catch (error) {
    return { name: check.name, ok: false, detail: `${messageOf(error)}; fix: ${check.fix}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs every check concurrently, prints one line each, and returns the exit code. */
export async function runDoctor(checks: readonly DoctorCheck[], write: (line: string) => void): Promise<number> {
  const results = await Promise.all(checks.map((check) => settle(check)));
  const width = Math.max(0, ...results.map((result) => result.name.length));
  for (const result of results) write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name.padEnd(width)}  ${result.detail}`);
  const failed = results.filter((result) => !result.ok).length;
  write(failed === 0 ? 'doctor: every check passed' : `doctor: ${String(failed)} of ${String(results.length)} checks failed`);
  return failed === 0 ? 0 : 1;
}
