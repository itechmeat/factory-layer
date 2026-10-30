/**
 * `MozaikBrain`: the `Brain` port over the Mozaik decider. Each port call is
 * one decision attempt on the agent of its role (the Architect plans,
 * corrects, re-plans and proposes playbooks; the Acceptance analyst derives
 * the checks beyond the spec's examples; the Critic reviews derived checks,
 * judges, chooses recoveries and reviews authored playbooks) with the role's
 * prompt, the user message of the decision and its narrowed submit schema;
 * core-owned fields (plan revisions) are filled in here. The caller bounds
 * and retries the decision; this adapter only maps.
 *
 * The executor report is redacted of the configured secrets before it is
 * put into the judge's message, as it may carry raw agent output.
 *
 * Every model call becomes one usage record of source `brain`, tagged with
 * the decision kind (which names the role) and priced from the cost table;
 * its model is the one the provider's answer named (`actual`) or, when it
 * named none or the call failed, the configured one (`expected`). A failed
 * attempt rejects with the port's `BrainError` carrying those records.
 *
 * Re-plan budget: the recovery message states the run's resolved re-plan
 * budget (one brain serves one run); the core enforces it and turns a
 * `replan` past it into a repair, so a `replan` answer is passed on as is.
 * A rebind may name only the configured agent profiles, which the recovery
 * message lists; any other name goes back to the model as invalid.
 */

import type { z } from 'zod';

import type { AcceptanceCheck, CheckObjection, CheckResult } from '../../domain/acceptance';
import type { PlaybookReview } from '../../domain/authoring';
import type { Playbook, PlaybookDraft, RecoveryChoice, TaskFailure, TaskHistoryEntry, Verdict } from '../../domain/decisions';
import { BRAIN_DECISION_DEADLINE_MS } from '../../domain/limits';
import type { Plan, PlanInvalidReason, PlanTask } from '../../domain/plan';
import type { Spec } from '../../domain/spec';
import { specExampleChecks } from '../../domain/spec-examples';
import { redactJson } from '../../domain/redact';
import { computeCost, type DecisionKind, type Usage, type UsageRecord } from '../../domain/usage';
import { type Brain, type BrainDecision, BrainError, type PlaybookRequest } from '../../ports/brain';
import type { CostTable } from '../../ports/cost-table';
import type { ExecutorReport } from '../../ports/executor';
import type { PlaybookTrial, PlaybookValidation } from '../../ports/playbook-authoring';
import type { Clock } from '../../ports/index';
import type { RecalledRun } from '../../ports/memory';
import type { CloudGuardScope } from './cloud-guard';
import type { BrainConfig } from './config';
import { type BrainRole, type BrainUsageRecord, DecisionError, type DecisionRequest, type DecisionResult } from './decision';
import { createMozaikDecider } from './decider';
import {
  acceptanceMessage,
  correctPlanMessage,
  judgeMessage,
  planMessage,
  playbookMessage,
  playbookReviewMessage,
  recoveryMessage,
  replanMessage,
  reviewMessage,
} from './messages';
import { ROLE_PROMPTS } from './prompts/index';
import {
  acceptanceSubmissionSchema,
  completePlan,
  PlanSubmissionSchema,
  PlaybookReviewSubmissionSchema,
  PlaybookSubmissionSchema,
  AGENT_PROFILES,
  recoverySubmissionSchema,
  reviewSubmissionSchema,
  VerdictSubmissionSchema,
} from './submit-schemas';

/** What the brain needs of a decider: one bounded decision attempt. */
export interface Decider {
  decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>>;
}

/** What a brain is built from; the attempt deadline defaults to the factory's decision deadline. */
export interface MozaikBrainOptions {
  readonly decider: Decider;
  readonly costs: CostTable;
  readonly deadlineMs?: number;
  /** The run's resolved re-plan budget, stated in the recovery message. */
  readonly replanBudget: number;
  /** Redacted from the executor report before it reaches the model (the provider keys). */
  readonly secrets?: readonly string[];
  /** The APB agent profiles a rebind may name; defaults to `AGENT_PROFILES`. */
  readonly profiles?: readonly [string, ...string[]];
}

/** One decision: its kind, role, prompt, message and submit schema. */
interface Ask<S> {
  readonly kind: DecisionKind;
  readonly role: BrainRole;
  readonly system: string;
  readonly user: string;
  readonly schema: z.ZodType<S>;
  readonly signal: AbortSignal;
}

function usageOf(call: BrainUsageRecord): Usage {
  if (call.usage.kind === 'measured') {
    return {
      status: 'measured',
      inputTokens: call.usage.input,
      outputTokens: call.usage.output,
      cacheReadTokens: call.usage.cacheRead,
      cacheWriteTokens: call.usage.cacheWrite,
    };
  }
  return { status: 'unavailable', reason: call.failure === undefined ? call.usage.reason : `${call.usage.reason}: ${call.failure}` };
}

/** The brain over the Mozaik decider. */
export class MozaikBrain implements Brain {
  readonly #decider: Decider;
  readonly #costs: CostTable;
  readonly #deadlineMs: number;
  readonly #replanBudget: number;
  readonly #profiles: readonly [string, ...string[]];
  readonly #secrets: readonly string[];

  constructor(options: MozaikBrainOptions) {
    this.#decider = options.decider;
    this.#costs = options.costs;
    this.#deadlineMs = options.deadlineMs ?? BRAIN_DECISION_DEADLINE_MS;
    this.#replanBudget = options.replanBudget;
    this.#profiles = options.profiles ?? AGENT_PROFILES;
    this.#secrets = options.secrets ?? [];
  }

  async plan(spec: Spec, recalled: readonly RecalledRun[], signal: AbortSignal): Promise<BrainDecision<Plan>> {
    const ask = { kind: 'plan', role: 'architect', system: ROLE_PROMPTS.architect.plan, user: planMessage(spec, recalled) } as const;
    const answer = await this.#decide({ ...ask, schema: PlanSubmissionSchema, signal });
    return { decision: completePlan(answer.decision, null), usage: answer.usage };
  }

  async correctPlan(spec: Spec, plan: Plan, reasons: readonly PlanInvalidReason[], signal: AbortSignal): Promise<BrainDecision<Plan>> {
    const user = correctPlanMessage(spec, plan, reasons);
    const answer = await this.#decide({
      kind: 'correct_plan',
      role: 'architect',
      system: ROLE_PROMPTS.architect.correctPlan,
      user,
      schema: PlanSubmissionSchema,
      signal,
    });
    return { decision: completePlan(answer.decision, plan), usage: answer.usage };
  }

  async replan(
    spec: Spec,
    plan: Plan,
    failure: TaskFailure,
    integrated: readonly string[],
    signal: AbortSignal,
  ): Promise<BrainDecision<Plan>> {
    const user = replanMessage(spec, plan, failure, integrated);
    const answer = await this.#decide({
      kind: 'replan',
      role: 'architect',
      system: ROLE_PROMPTS.architect.replan,
      user,
      schema: PlanSubmissionSchema,
      signal,
    });
    return { decision: completePlan(answer.decision, plan, new Set(integrated)), usage: answer.usage };
  }

  deriveAcceptance(spec: Spec, signal: AbortSignal): Promise<BrainDecision<readonly AcceptanceCheck[]>> {
    return this.#decide({
      kind: 'acceptance',
      role: 'acceptance_analyst',
      system: ROLE_PROMPTS.acceptance_analyst.acceptance,
      user: acceptanceMessage(spec, specExampleChecks(spec.markdown)),
      schema: acceptanceSubmissionSchema(spec.markdown),
      signal,
    });
  }

  reviewAcceptance(
    spec: Spec,
    examples: readonly AcceptanceCheck[],
    checks: readonly AcceptanceCheck[],
    results: readonly CheckResult[],
    signal: AbortSignal,
  ): Promise<BrainDecision<readonly CheckObjection[]>> {
    return this.#decide({
      kind: 'acceptance_review',
      role: 'critic',
      system: ROLE_PROMPTS.critic.acceptanceReview,
      user: reviewMessage(spec, examples, checks, results),
      schema: reviewSubmissionSchema(checks.map((check) => check.id)),
      signal,
    });
  }

  judge(
    task: PlanTask,
    report: ExecutorReport,
    checkResults: readonly CheckResult[],
    signal: AbortSignal,
  ): Promise<BrainDecision<Verdict>> {
    return this.#decide({
      kind: 'judge',
      role: 'critic',
      system: ROLE_PROMPTS.critic.verdict,
      user: judgeMessage(task, redactJson(report, this.#secrets), checkResults),
      schema: VerdictSubmissionSchema,
      signal,
    });
  }

  chooseRecovery(
    task: PlanTask,
    failure: TaskFailure,
    history: readonly TaskHistoryEntry[],
    signal: AbortSignal,
  ): Promise<BrainDecision<RecoveryChoice>> {
    return this.#decide({
      kind: 'recovery',
      role: 'critic',
      system: ROLE_PROMPTS.critic.recovery,
      user: recoveryMessage(task, failure, history, this.#replanBudget, this.#profiles),
      schema: recoverySubmissionSchema(this.#profiles),
      signal,
    });
  }

  proposePlaybook(request: PlaybookRequest, signal: AbortSignal): Promise<BrainDecision<PlaybookDraft | null>> {
    return this.#decide({
      kind: 'playbook',
      role: 'architect',
      system: ROLE_PROMPTS.architect.playbook,
      user: playbookMessage(request),
      schema: PlaybookSubmissionSchema,
      signal,
    });
  }

  /** The trial output may carry raw agent output, so it is redacted before it reaches the model. */
  reviewPlaybook(
    playbook: Playbook,
    validation: PlaybookValidation,
    trial: PlaybookTrial,
    signal: AbortSignal,
  ): Promise<BrainDecision<PlaybookReview>> {
    return this.#decide({
      kind: 'playbook_review',
      role: 'critic',
      system: ROLE_PROMPTS.critic.playbookReview,
      user: playbookReviewMessage(playbook, validation, redactJson(trial, this.#secrets)),
      schema: PlaybookReviewSubmissionSchema,
      signal,
    });
  }

  /** Runs one decision attempt and maps its answer, or its failure, onto the port. */
  async #decide<S>(ask: Ask<S>): Promise<BrainDecision<S>> {
    const { kind, ...request } = ask;
    try {
      const result = await this.#decider.decide({ ...request, deadlineMs: this.#deadlineMs });
      return { decision: result.value, usage: this.#records(result.usage, kind) };
    } catch (error) {
      if (!(error instanceof DecisionError)) {
        throw new BrainError({ reason: 'failed', detail: error instanceof Error ? error.message : String(error), usage: [] });
      }
      const reason = error.reason === 'timeout' || error.reason === 'cancelled' ? error.reason : 'failed';
      throw new BrainError({ reason, detail: error.message, usage: this.#records(error.usage, kind) });
    }
  }

  #records(calls: readonly BrainUsageRecord[], kind: DecisionKind): readonly UsageRecord[] {
    return calls.map((call) => {
      const usage = usageOf(call);
      const model = call.reportedModel ?? call.model;
      return {
        at: call.at,
        source: 'brain',
        provider: call.provider,
        model,
        modelSource: call.reportedModel === undefined ? 'expected' : 'actual',
        usage,
        cost: computeCost(usage, this.#costs.price(model)),
        decisionKind: kind,
      };
    });
  }
}

/**
 * The brain for a configuration: refuses with `MozaikCloudKeyError` when a
 * Mozaik cloud key is configured without the opt-in, builds the decider (which installs the
 * process guard) and prices calls from `costs`.
 */
export function createMozaikBrain(
  config: BrainConfig,
  clock: Clock,
  costs: CostTable,
  options: { readonly scope?: CloudGuardScope; readonly replanBudget: number; readonly secrets?: readonly string[] },
): MozaikBrain {
  return new MozaikBrain({
    decider: createMozaikDecider(config, clock, options.scope),
    costs,
    replanBudget: options.replanBudget,
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
  });
}
