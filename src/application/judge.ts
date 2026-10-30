/**
 * Judging a finished task (task 3.5) and the check run it shares with
 * integration: the package steps (install, build when present, tests under
 * every required runtime) and every acceptance check run in a directory,
 * the steps reported as check results (`package-<runtime>-<step>`) beside the
 * acceptance results. The critic gets the task, the executor's report and
 * every result; results inform the verdict, so a scaffold may be accepted
 * while feature checks still fail. A judge decision that fails every attempt
 * rejects with `brain_unavailable`. Judges of different tasks run
 * concurrently because each task judges in its own promise. A verdict that
 * arrives after a re-plan took the task over (or after the cutoff) is
 * discarded and changes nothing.
 */

import type { CheckResult, PlanTask, TaskFailure } from '../domain';
import type { ExecutorReport, PackageStepsResult } from '../ports';

import { defaultVerdict } from './decisions';
import { discardedAsStale, halted, recordHistory, taskFailure, taskSignal, type RunContext } from './run-context';

/** The results of one check run, and whether the package steps passed. */
export interface CheckRun {
  readonly results: readonly CheckResult[];
  readonly acceptance: readonly CheckResult[];
  readonly packageOk: boolean;
}

/** What the judge decided for the task: accepted, or rejected with the failure recovery starts from. */
export type JudgeOutcome =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly failure: TaskFailure }
  | { readonly accepted: null };

/** Package steps as check results, so the critic and the trace see them beside the acceptance checks. */
function packageResults(steps: PackageStepsResult): CheckResult[] {
  return steps.steps.map((step) => ({
    checkId: `package-${step.runtime}-${step.step}`,
    status: step.ok ? 'passed' : 'failed',
    reasons: step.ok ? [] : [step.missingScript ? `the ${step.step} script is missing` : `${step.runtime} ${step.step} failed`],
    detail: step.detail,
  }));
}

/** Runs the package steps and every acceptance check in `dir`, traced with the scope and the task. */
export async function runChecksIn(ctx: RunContext, dir: string, scope: 'task' | 'integration', taskId: string): Promise<CheckRun> {
  const { checks } = ctx.ports;
  const steps = await checks.packageSteps(dir, ctx.owner.state.options.requiredRuntimes);
  const acceptance = await runAcceptance(ctx, dir);
  const results = [...packageResults(steps), ...acceptance];
  ctx.lastChecks.set(taskId, results);
  ctx.trace.emit({ type: 'checks_run', ...ctx.owner.correlation(taskId), scope, results: [...results] });
  for (const failed of results.filter((result) => result.status !== 'passed')) {
    recordHistory(ctx, taskId, 'failed_check', `${failed.checkId}: ${failed.reasons.join('; ')}`);
  }
  return { results, acceptance, packageOk: steps.ok };
}

/** Every acceptance check of the run; a check runner that throws errors every check instead of the run. */
export async function runAcceptance(ctx: RunContext, dir: string): Promise<readonly CheckResult[]> {
  const checks = ctx.owner.state.acceptanceChecks;
  if (checks.length === 0) {
    return [];
  }
  try {
    return await ctx.ports.checks.runChecks(dir, checks);
  } catch (error) {
    const detail = ctx.trace.redact(error instanceof Error ? error.message : String(error));
    return checks.map((check) => ({ checkId: check.id, status: 'errored', reasons: ['the check runner failed'], detail }));
  }
}

/** Runs the checks in the run's tree and asks the critic for a verdict; moves the task to accepted, reports the rejection, or (null) drops a late verdict. */
export async function judgeTask(ctx: RunContext, task: PlanTask, tree: string, report: ExecutorReport): Promise<JudgeOutcome> {
  const { owner } = ctx;
  if (owner.task(task.id).state !== 'judging') {
    await owner.transition(task.id, 'judging', 'the run finished successfully');
  }
  const checkRun = await runChecksIn(ctx, tree, 'task', task.id);
  const decided = await ctx.decider.decide(
    'judge',
    owner.correlation(task.id),
    (signal) => ctx.ports.brain.judge(task, report, checkRun.results, signal),
    taskSignal(ctx, task.id),
  );
  if (discardedAsStale(ctx, task.id, 'the verdict') || halted(ctx, task.id)) {
    return { accepted: null };
  }
  const verdict = decided.ok ? decided.decision : defaultVerdict();
  ctx.trace.emit({
    type: 'verdict',
    ...owner.correlation(task.id),
    outcome: verdict.outcome,
    reasons: verdict.outcome === 'reject' ? [...verdict.reasons] : [],
    failedCheckIds: verdict.outcome === 'reject' ? [...verdict.failedCheckIds] : [],
  });
  if (verdict.outcome === 'accept') {
    await owner.transition(task.id, 'accepted', 'the critic accepted the task');
    return { accepted: true };
  }
  const detail = verdict.reasons.join('; ');
  recordHistory(ctx, task.id, 'rejected', detail);
  return {
    accepted: false,
    failure: taskFailure(ctx, task.id, {
      reason: decided.ok ? 'verdict_rejected' : 'brain_unavailable',
      detail,
      failingCheckIds: verdict.failedCheckIds,
    }),
  };
}
