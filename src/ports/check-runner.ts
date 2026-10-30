/**
 * The CheckRunner port: runs the package steps (install, build, test) and
 * the acceptance checks in a directory, and reports what happened instead
 * of throwing for a failing package or check.
 */

import type { AcceptanceCheck, CheckResult } from '../domain/acceptance';
import type { Runtime } from '../domain/limits';

/** What one executed command produced; streams are redacted and truncated. */
export interface CommandOutcome {
  readonly exitCode: number | null; // null on timeout or spawn failure
  readonly timedOut: boolean;
  readonly spawnFailure: string | null; // typed spawn failure as text, null when spawned
  readonly stdout: string; // redacted, truncated to CHECK_OUTPUT_LIMIT_BYTES, truncation stated
  readonly stderr: string; // same
  readonly elapsedMs: number;
}

/** One package step under one runtime; a missing script is a failed step. */
export interface PackageStepResult {
  readonly runtime: Runtime;
  readonly step: 'install' | 'build' | 'test';
  readonly ok: boolean;
  readonly missingScript: boolean; // the package.json lacks the script: a FAILED step, never a pass
  readonly outcome: CommandOutcome | null; // null exactly when missingScript
  readonly detail: string;
}

/** The package steps of a directory under the requested runtimes. */
export interface PackageStepsResult {
  readonly dir: string;
  readonly runtimes: readonly Runtime[];
  readonly ok: boolean;
  readonly steps: readonly PackageStepResult[];
}

/**
 * Runs the proofs. Every wait is bounded: each package step by the
 * adapter's step timeout and each acceptance check by its own `timeoutMs`
 * (both milliseconds, the check default DEFAULT_CHECK_TIMEOUT_MS); the
 * port never waits unbounded. Failure: failing steps and checks are
 * reported in the results (a check that cannot run is 'errored'); the
 * methods reject only when the runner itself cannot operate (an Error
 * instance from the adapter; the contract defines no dedicated error
 * class), never for a failing package or check, and never hang.
 */
export interface CheckRunner {
  /**
   * Installs, builds (when a build script exists) and tests the package,
   * per runtime, in the directory. Deadline: bounded by the adapter's
   * per-step timeout (milliseconds). Failure: resolves with
   * PackageStepsResult whose steps carry ok false, missingScript true or
   * the errored outcome; never throws for a failing package; never hangs.
   */
  packageSteps(dir: string, runtimes: readonly Runtime[]): Promise<PackageStepsResult>;

  /**
   * Runs all acceptance checks in the directory; an HTTP batch starts the
   * server once (bounded by HTTP_SERVER_START_TIMEOUT_MS, milliseconds).
   * Deadline: each check is bounded by its own timeoutMs (milliseconds).
   * Failure: resolves with one CheckResult per check, status 'errored'
   * when the check could not run; never throws for a failing check; never
   * hangs.
   */
  runChecks(dir: string, checks: readonly AcceptanceCheck[]): Promise<readonly CheckResult[]>;
}
