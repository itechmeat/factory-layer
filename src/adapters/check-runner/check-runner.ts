/**
 * The process-backed CheckRunner adapter: bounded commands, the package
 * steps (install, build, test) per runtime, and the acceptance checks
 * (CLI, command, HTTP) against a package directory. Each call is one
 * batch with its own scratch HOME, removed afterwards; the optional abort
 * signal kills the commands running when it fires. The HTTP checks taken
 * from the spec's examples and the derived ones run as two groups, each in
 * order against its own freshly started server, so neither sees state the
 * other left. Invariant: outcomes
 * are reported as values and never thrown for a failing package, and the
 * settable secret set redacts every captured byte that leaves the runner.
 */

import type { AcceptanceCheck, CheckResult, HttpCheck } from '../../domain/acceptance';
import type { Runtime } from '../../domain/limits';
import { isSpecExampleCheckId } from '../../domain/spec-examples';

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

  /** Runs all checks in input order; each HTTP group (spec examples, derived) starts its own server once. */
  async runChecks(dir: string, checks: readonly AcceptanceCheck[]): Promise<readonly CheckResult[]> {
    return this.#batch((batch) => this.#runChecks(dir, checks, batch));
  }

  async #runChecks(dir: string, checks: readonly AcceptanceCheck[], batch: Batch): Promise<readonly CheckResult[]> {
    const results = new Map<string, CheckResult>();
    const examples: HttpCheck[] = [];
    const derived: HttpCheck[] = [];
    for (const check of checks) {
      if (check.kind === 'http') {
        (isSpecExampleCheckId(check.id) ? examples : derived).push(check);
        continue;
      }
      results.set(check.id, check.kind === 'cli' ? await runCliCheck(dir, check, batch) : await runCommandCheck(dir, check, batch));
    }
    for (const group of [examples, derived]) {
      for (const result of await runHttpBatch(dir, group, batch)) results.set(result.checkId, result);
    }
    return checks.flatMap((check) => {
      const result = results.get(check.id);
      return result === undefined ? [] : [result];
    });
  }
}
