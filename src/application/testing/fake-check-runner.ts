/**
 * A scriptable `CheckRunner` for tests: results scripted per check id or per
 * directory (the directory script wins), package steps scripted per
 * directory with a passing default, every call recorded, and on-demand
 * failures for the error paths. No process is ever started.
 */

import type { AcceptanceCheck, CheckResult, Runtime } from '../../domain';
import type { CheckRunner, CommandOutcome, PackageStepResult, PackageStepsResult } from '../../ports';

/** A captured command outcome of a passed step. */
const PASSED_OUTCOME: CommandOutcome = { exitCode: 0, timedOut: false, spawnFailure: null, stdout: '', stderr: '', elapsedMs: 0 };

const STEP_NAMES: readonly PackageStepResult['step'][] = ['install', 'build', 'test'];

/** One runChecks call the fake recorded. */
export interface FakeCheckCall {
  readonly dir: string;
  readonly checks: readonly AcceptanceCheck[];
}

/** One packageSteps call the fake recorded. */
export interface FakePackageCall {
  readonly dir: string;
  readonly runtimes: readonly Runtime[];
}

export class FakeCheckRunner implements CheckRunner {
  private readonly resultsByCheckId = new Map<string, CheckResult>();
  private readonly resultsByDir = new Map<string, readonly CheckResult[]>();
  private readonly packagesByDir = new Map<string, PackageStepsResult>();
  private readonly callLog: FakeCheckCall[] = [];
  private readonly packageCallLog: FakePackageCall[] = [];
  private failuresLeft = 0;
  private failure: Error = new Error('check runner failure scripted by the test');

  /** Every runChecks call, in call order. */
  get calls(): readonly FakeCheckCall[] {
    return this.callLog;
  }

  /** Every packageSteps call, in call order. */
  get packageCalls(): readonly FakePackageCall[] {
    return this.packageCallLog;
  }

  /** Scripts the result of one check id, replacing the default pass. */
  setResult(checkId: string, result: CheckResult): void {
    this.resultsByCheckId.set(checkId, result);
  }

  /** Scripts the whole result list of one directory; it wins over the per check scripts. */
  setResultsForDir(dir: string, results: readonly CheckResult[]): void {
    this.resultsByDir.set(dir, results);
  }

  /** Scripts what packageSteps(dir, ...) returns. */
  setPackageSteps(dir: string, result: PackageStepsResult): void {
    this.packagesByDir.set(dir, result);
  }

  /** Makes the next runChecks calls throw the error, then the script resumes. */
  failNext(times: number, error: Error): void {
    this.failuresLeft = times;
    this.failure = error;
  }

  async runChecks(dir: string, checks: readonly AcceptanceCheck[]): Promise<readonly CheckResult[]> {
    this.callLog.push({ dir, checks });
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw this.failure;
    }
    const scriptedDir = this.resultsByDir.get(dir);
    if (scriptedDir !== undefined) {
      return scriptedDir;
    }
    return checks.map((check) => this.resultsByCheckId.get(check.id) ?? { checkId: check.id, status: 'passed', reasons: [], detail: '' });
  }

  async packageSteps(dir: string, runtimes: readonly Runtime[]): Promise<PackageStepsResult> {
    this.packageCallLog.push({ dir, runtimes });
    const scripted = this.packagesByDir.get(dir);
    if (scripted !== undefined) {
      return scripted;
    }
    const steps = runtimes.flatMap((runtime) =>
      STEP_NAMES.map((step) => ({
        runtime,
        step,
        ok: true,
        missingScript: false,
        outcome: PASSED_OUTCOME,
        detail: `${runtime} ${step} passed`,
      })),
    );
    return { dir, runtimes, ok: true, steps };
  }
}
