/**
 * The process-backed CheckRunner adapter: bounded commands, the package
 * steps (install, build, test) per runtime, and the acceptance checks
 * (CLI, command, HTTP) against a package directory. Each call is one
 * batch with its own scratch HOME, removed afterwards; the optional abort
 * signal kills the commands running when it fires. Invariant: outcomes
 * are reported as values and never thrown for a failing package, and the
 * settable secret set redacts every captured byte that leaves the runner.
 */

import type { AcceptanceCheck, CheckResult, HttpCheck } from '../../domain/acceptance';
import type { Runtime } from '../../domain/limits';

import type { CheckRunner, PackageStepsResult } from '../../ports/check-runner';
import { withScratchHome } from '../child-env';
import { runCommandCheck, runCliCheck } from './checks';
import { runHttpBatch } from './http';
import { runPackageSteps } from './package-steps';
import type { Batch } from './process';

/** Runs the proofs with real processes: the factory's hands-on judge of a delivery. */
export class ProcessCheckRunner implements CheckRunner {
  #secrets: readonly string[] = [];
  readonly #signal: AbortSignal | undefined;

  /** `signal` (the run's cutoff) kills the commands running when it fires. */
  constructor(options: { readonly signal?: AbortSignal | undefined } = {}) {
    this.#signal = options.signal;
  }

  /** Sets the secrets redacted from every captured output afterwards. */
  setSecrets(secrets: readonly string[]): void {
    this.#secrets = [...secrets];
  }

  /** Install, build (when a build script exists) and test, per runtime; never throws for a failing package. */
  async packageSteps(dir: string, runtimes: readonly Runtime[]): Promise<PackageStepsResult> {
    return this.#batch((batch) => runPackageSteps(dir, runtimes, batch));
  }

  /** Runs `body` as one batch: the current secrets, a fresh scratch HOME, the abort signal. */
  #batch<T>(body: (batch: Batch) => Promise<T>): Promise<T> {
    return withScratchHome((home) => body({ secrets: this.#secrets, home, signal: this.#signal }));
  }

  /** Runs all checks in input order; an HTTP batch starts the server once. */
  async runChecks(dir: string, checks: readonly AcceptanceCheck[]): Promise<readonly CheckResult[]> {
    return this.#batch((batch) => this.#runChecks(dir, checks, batch));
  }

  async #runChecks(dir: string, checks: readonly AcceptanceCheck[], batch: Batch): Promise<readonly CheckResult[]> {
    const results = Array.from({ length: checks.length }, (): CheckResult | undefined => undefined);
    const httpChecks: HttpCheck[] = [];
    for (const [index, check] of checks.entries()) {
      if (check.kind === 'http') {
        httpChecks.push(check);
        continue;
      }
      results[index] = check.kind === 'cli' ? await runCliCheck(dir, check, batch) : await runCommandCheck(dir, check, batch);
    }
    if (httpChecks.length > 0) {
      const httpResults = await runHttpBatch(dir, httpChecks, batch);
      let cursor = 0;
      for (const [index, check] of checks.entries()) {
        if (check.kind !== 'http') continue;
        const result = httpResults[cursor];
        cursor += 1;
        if (result !== undefined) results[index] = result;
      }
    }
    return results.filter((result): result is CheckResult => result !== undefined);
  }
}
