/**
 * The user messages of the brain's decisions: the material each role decides
 * on (spec, plan, failure, report, check results), rendered as Markdown
 * sections with JSON blocks. Plans are shown without revisions, which the
 * model does not set. The checks taken from the spec's examples are shown to
 * the Acceptance analyst (not to repeat them) and to the Critic's review (as
 * the authoritative ones). Pure text building, no IO.
 */

import type { AcceptanceCheck, CheckResult } from '../../domain/acceptance';
import type { TaskFailure, TaskHistoryEntry } from '../../domain/decisions';
import type { Plan, PlanInvalidReason, PlanTask } from '../../domain/plan';
import type { Spec } from '../../domain/spec';
import type { ExecutorReport } from '../../ports/executor';
import type { RecalledRun } from '../../ports/memory';

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

function json(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function specSection(spec: Spec): string {
  return section(`Spec \`${spec.name}\``, spec.markdown);
}

function planSection(title: string, plan: Plan): string {
  return section(title, json({ tasks: plan.tasks.map(({ revision: _revision, ...task }) => task) }));
}

function taskSection(task: PlanTask): string {
  const { revision: _revision, ...shown } = task;
  return section('Task', json(shown));
}

function join(parts: readonly string[]): string {
  return `${parts.join('\n\n')}\n`;
}

/** The plan request: the spec and the outcomes of similar earlier runs. */
export function planMessage(spec: Spec, recalled: readonly RecalledRun[]): string {
  const earlier =
    recalled.length === 0
      ? 'None.'
      : recalled.map((run) => `- ${run.at} \`${run.specName}\`: ${run.outcome}. Plan: ${run.summary}`).join('\n');
  return join([specSection(spec), section('Earlier runs on similar specs', earlier)]);
}

/** The correction request: the spec, the invalid plan and the exact reasons. */
export function correctPlanMessage(spec: Spec, plan: Plan, reasons: readonly PlanInvalidReason[]): string {
  return join([specSection(spec), planSection('Plan that failed validation', plan), section('Validation reasons', json(reasons))]);
}

/** The re-plan request: the spec, the current plan, the failure and the integrated tasks. */
export function replanMessage(spec: Spec, plan: Plan, failure: TaskFailure, integrated: readonly string[]): string {
  return join([
    specSection(spec),
    planSection('Current plan', plan),
    section('Failure', json(failure)),
    section('Integrated tasks (keep unchanged)', integrated.length === 0 ? 'None.' : integrated.map((id) => `- ${id}`).join('\n')),
  ]);
}

function checksJson(checks: readonly AcceptanceCheck[]): string {
  return json(checks.map(({ timeoutMs: _timeoutMs, ...check }) => check));
}

/** The acceptance request: the spec and the checks already taken from its examples. */
export function acceptanceMessage(spec: Spec, examples: readonly AcceptanceCheck[]): string {
  return join([
    specSection(spec),
    section(
      'Checks already taken from the spec examples (they run as they are; do not repeat them)',
      examples.length === 0 ? 'None: the spec has no runnable shell examples.' : checksJson(examples),
    ),
  ]);
}

/** The review request: the spec, the authoritative example checks, the candidate checks and, at delivery, every check result. */
export function reviewMessage(
  spec: Spec,
  examples: readonly AcceptanceCheck[],
  checks: readonly AcceptanceCheck[],
  results: readonly CheckResult[],
): string {
  return join([
    specSection(spec),
    section(
      'Example checks (authoritative: taken verbatim from the spec examples)',
      examples.length === 0 ? 'None.' : checksJson(examples),
    ),
    section('Candidate checks to review', checksJson(checks)),
    ...(results.length === 0 ? [] : [section('Check results on the delivered package', json(results))]),
  ]);
}

/** The verdict request: the task, the agent run's report and the check results. */
export function judgeMessage(task: PlanTask, report: ExecutorReport, checkResults: readonly CheckResult[]): string {
  const { usage: _usage, ...shown } = report;
  return join([taskSection(task), section('Agent run report', json(shown)), section('Check results', json(checkResults))]);
}

/** The recovery request: the task, the failure, the task's history, the run's re-plan budget and the agent profiles a rebind may name. */
export function recoveryMessage(
  task: PlanTask,
  failure: TaskFailure,
  history: readonly TaskHistoryEntry[],
  replanBudget: number,
  profiles: readonly string[],
): string {
  return join([
    taskSection(task),
    section('Failure of the last attempt', json(failure)),
    section('History', json(history)),
    section(
      'Re-plan',
      replanBudget > 0
        ? `This run may re-plan at most ${String(replanBudget)} time(s) in all; once they are spent, the factory turns a replan into a repair.`
        : 'Not available: this run cannot re-plan. Do not choose replan.',
    ),
    section('Agent profiles a rebind may name', profiles.map((profile) => `- ${profile}`).join('\n')),
  ]);
}

/** The playbook request: the kind of task and examples of it. */
export function playbookMessage(taskKind: string, examples: readonly string[]): string {
  return join([section('Kind of task', taskKind), section('Examples', examples.map((example) => `- ${example}`).join('\n') || 'None.')]);
}
