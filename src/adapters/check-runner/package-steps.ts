/**
 * The package steps of the check runner: install, build (when the package
 * has a build script) and the package's own test script, per requested
 * runtime. An install is bounded by PACKAGE_INSTALL_TIMEOUT_MS, build and
 * test by DEFAULT_CHECK_TIMEOUT_MS. Every runtime installs into a clean
 * `node_modules`, so no runtime reuses another one's install. An install
 * never runs the package's lifecycle scripts (`--ignore-scripts`): the
 * build is its own step. Every step sees only the allowlisted environment
 * of the batch. An install that leaves a type library the package's
 * `tsconfig.json` names out of its own `node_modules` fails, naming it: the
 * build would only pass through a parent directory's install. Invariant: a
 * missing test script is a failed step under every runtime (never a silent
 * pass), a missing build script is a passing no-op, and no failing package
 * makes the steps throw.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_CHECK_TIMEOUT_MS } from '../../domain/acceptance';
import { PACKAGE_INSTALL_TIMEOUT_MS, type Runtime } from '../../domain/limits';

import type { CommandOutcome, PackageStepResult, PackageStepsResult } from '../../ports/check-runner';
import { generatedCodeEnv } from '../child-env';
import { readPackageJson } from './package-json';
import { missingTypeLibraries } from './type-libraries';
import { runCommand, type Batch } from './process';

type StepName = PackageStepResult['step'];

/** The binary and arguments one step runs under one runtime: an install without lifecycle scripts, else the package's own script. */
function commandFor(runtime: Runtime, step: StepName): { command: string; args: string[] } {
  if (step === 'install') return { command: runtime, args: ['install', '--ignore-scripts'] };
  return { command: runtime, args: ['run', step] };
}

/** The bound of one step: an install may download, so it gets the longer timeout. */
function timeoutFor(step: StepName): number {
  return step === 'install' ? PACKAGE_INSTALL_TIMEOUT_MS : DEFAULT_CHECK_TIMEOUT_MS;
}

/** Short human summary of an executed step. */
function detailFor(step: StepName, runtime: Runtime, outcome: CommandOutcome): string {
  if (outcome.spawnFailure !== null) return `${step} (${runtime}) spawn failed: ${outcome.spawnFailure}`;
  if (outcome.timedOut) return `${step} (${runtime}) timed out after ${timeoutFor(step)} ms`;
  return `${step} (${runtime}) exited with code ${outcome.exitCode ?? 'no exit'}`;
}

/** Runs one step of one runtime, or reports its script situation. */
async function runStep(
  dir: string,
  runtime: Runtime,
  step: StepName,
  scripts: Readonly<Record<string, string>>,
  batch: Batch,
): Promise<PackageStepResult> {
  if (step === 'build' && scripts['build'] === undefined) {
    return { runtime, step, ok: true, missingScript: false, outcome: null, detail: 'no build script' };
  }
  if (step === 'test' && scripts['test'] === undefined) {
    return { runtime, step, ok: false, missingScript: true, outcome: null, detail: 'no test script in package.json' };
  }
  const { command, args } = commandFor(runtime, step);
  const outcome = await runCommand({
    command,
    args,
    cwd: dir,
    timeoutMs: timeoutFor(step),
    env: generatedCodeEnv(batch.home),
    secrets: batch.secrets,
    signal: batch.signal,
  });
  const ok = outcome.exitCode === 0 && !outcome.timedOut && outcome.spawnFailure === null;
  const missing = ok && step === 'install' ? await missingTypeLibraries(dir) : [];
  if (missing.length > 0) {
    const named = missing.map((name) => JSON.stringify(name)).join(', ');
    const detail = `install (${runtime}): tsconfig.json names the type library ${named} but the package does not install it; declare it in devDependencies (for example @types/${missing[0] ?? ''})`;
    return { runtime, step, ok: false, missingScript: false, outcome, detail };
  }
  return { runtime, step, ok, missingScript: false, outcome, detail: detailFor(step, runtime, outcome) };
}

/** Install, build and test the package per runtime, each from a clean node_modules; never throws for a failing package. */
export async function runPackageSteps(dir: string, runtimes: readonly Runtime[], batch: Batch): Promise<PackageStepsResult> {
  const pkg = await readPackageJson(dir);
  const scripts = pkg?.scripts ?? {};
  const steps: PackageStepResult[] = [];
  for (const runtime of runtimes) {
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    steps.push(
      await runStep(dir, runtime, 'install', scripts, batch),
      await runStep(dir, runtime, 'build', scripts, batch),
      await runStep(dir, runtime, 'test', scripts, batch),
    );
  }
  return { dir, runtimes, ok: steps.every((step) => step.ok), steps };
}
