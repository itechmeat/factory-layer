/**
 * A scriptable `Brain` for tests: per decision kind answers queued with an
 * optional delay on the fake clock, on-demand failures before the script
 * resumes, and a record of every call with its start and end instants, so
 * tests can assert order, overlap and cancellation without any model.
 */

import {
  computeCost,
  type AcceptanceCheck,
  type CheckObjection,
  type CheckResult,
  type DecisionKind,
  type Plan,
  type PlanInvalidReason,
  type PlanTask,
  type Playbook,
  type PlaybookDraft,
  type PlaybookReview,
  type RecoveryChoice,
  type Spec,
  type TaskFailure,
  type TaskHistoryEntry,
  type Usage,
  type UsageRecord,
  type Verdict,
} from '../../domain';
import {
  BrainError,
  type Brain,
  type BrainDecision,
  type Clock,
  type ExecutorReport,
  type PlaybookRequest,
  type PlaybookTrial,
  type PlaybookValidation,
  type RecalledRun,
  type Sleep,
} from '../../ports';

/** The provider and model every default usage record names. */
export const FAKE_BRAIN_PROVIDER = 'fake';
export const FAKE_BRAIN_MODEL = 'fake-brain-1';

const DEFAULT_INPUT_TOKENS = 100;
const DEFAULT_OUTPUT_TOKENS = 20;

/** The decision payload each decision kind answers with. */
export type DecisionOf<K extends DecisionKind> = K extends 'plan' | 'correct_plan' | 'replan'
  ? Plan
  : K extends 'acceptance'
    ? readonly AcceptanceCheck[]
    : K extends 'acceptance_review'
      ? readonly CheckObjection[]
      : K extends 'judge'
        ? Verdict
        : K extends 'recovery'
          ? RecoveryChoice
          : K extends 'playbook_review'
            ? PlaybookReview
            : PlaybookDraft | null;

/** One scripted answer: the decision, how long it takes, and the usage it reports. */
export interface BrainAnswer<K extends DecisionKind> {
  readonly decision: DecisionOf<K>;
  readonly delayMs?: number;
  readonly usage?: readonly UsageRecord[];
}

/** One call the fake saw, with its interval; `endedAt` is null while it is unresolved. */
export interface BrainCallRecord {
  readonly kind: DecisionKind;
  readonly startedAt: string;
  endedAt: string | null;
  readonly args: Readonly<Record<string, unknown>>;
}

/** The script handles of one decision kind. */
export interface KindScript<K extends DecisionKind> {
  answerWith(answer: BrainAnswer<K>): void;
  defaultAnswer(answer: BrainAnswer<K>): void;
}

interface KindState {
  readonly queue: unknown[];
  fallback: unknown;
  failuresLeft: number;
  failureReason: string;
}

function defaultUsageRecord(at: string): UsageRecord {
  const usage: Usage = {
    status: 'measured',
    inputTokens: DEFAULT_INPUT_TOKENS,
    outputTokens: DEFAULT_OUTPUT_TOKENS,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  return {
    at,
    source: 'brain',
    modelSource: 'actual',
    provider: FAKE_BRAIN_PROVIDER,
    model: FAKE_BRAIN_MODEL,
    usage,
    cost: computeCost(usage, { available: false, reason: 'no price table in the fake brain' }),
  };
}

/** Narrows a stored script entry back to the answer of the kind it was queued for. */
function isBrainAnswer<K extends DecisionKind>(value: unknown): value is BrainAnswer<K> {
  return typeof value === 'object' && value !== null && 'decision' in value;
}

export class FakeBrain implements Brain {
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly states = new Map<DecisionKind, KindState>();
  private readonly callLog: BrainCallRecord[] = [];

  /** The acceptance review objects to nothing unless a test scripts it. */
  constructor(deps: { clock: Clock; sleep: Sleep }) {
    this.clock = deps.clock;
    this.sleep = deps.sleep;
    this.stateFor('acceptance_review').fallback = { decision: [] };
  }

  /** The script handles, one per decision kind: `brain.script.plan.answerWith(...)`. */
  readonly script: {
    readonly plan: KindScript<'plan'>;
    readonly correct_plan: KindScript<'correct_plan'>;
    readonly replan: KindScript<'replan'>;
    readonly acceptance: KindScript<'acceptance'>;
    readonly acceptance_review: KindScript<'acceptance_review'>;
    readonly judge: KindScript<'judge'>;
    readonly recovery: KindScript<'recovery'>;
    readonly playbook: KindScript<'playbook'>;
    readonly playbook_review: KindScript<'playbook_review'>;
  } = {
    plan: this.kindScript('plan'),
    correct_plan: this.kindScript('correct_plan'),
    replan: this.kindScript('replan'),
    acceptance: this.kindScript('acceptance'),
    acceptance_review: this.kindScript('acceptance_review'),
    judge: this.kindScript('judge'),
    recovery: this.kindScript('recovery'),
    playbook: this.kindScript('playbook'),
    playbook_review: this.kindScript('playbook_review'),
  };

  /** Every call the fake saw, in call order. */
  get calls(): readonly BrainCallRecord[] {
    return this.callLog;
  }

  /** The calls of one decision kind, in call order. */
  callsOf(kind: DecisionKind): readonly BrainCallRecord[] {
    return this.callLog.filter((call) => call.kind === kind);
  }

  /** Makes the next `times` calls of the kind reject with BrainError(detail); the script then resumes. */
  failNext(kind: DecisionKind, times: number, detail: string): void {
    const state = this.stateFor(kind);
    state.failuresLeft = times;
    state.failureReason = detail;
  }

  async plan(spec: Spec, recalled: readonly RecalledRun[], signal: AbortSignal): Promise<BrainDecision<Plan>> {
    return this.decide('plan', { spec, recalled }, signal);
  }

  async correctPlan(spec: Spec, plan: Plan, reasons: readonly PlanInvalidReason[], signal: AbortSignal): Promise<BrainDecision<Plan>> {
    return this.decide('correct_plan', { spec, plan, reasons }, signal);
  }

  async replan(
    spec: Spec,
    plan: Plan,
    failure: TaskFailure,
    integrated: readonly string[],
    signal: AbortSignal,
  ): Promise<BrainDecision<Plan>> {
    return this.decide('replan', { spec, plan, failure, integrated }, signal);
  }

  async deriveAcceptance(spec: Spec, signal: AbortSignal): Promise<BrainDecision<readonly AcceptanceCheck[]>> {
    return this.decide('acceptance', { spec }, signal);
  }

  async reviewAcceptance(
    spec: Spec,
    examples: readonly AcceptanceCheck[],
    checks: readonly AcceptanceCheck[],
    results: readonly CheckResult[],
    signal: AbortSignal,
  ): Promise<BrainDecision<readonly CheckObjection[]>> {
    return this.decide('acceptance_review', { spec, examples, checks, results }, signal);
  }

  async judge(
    task: PlanTask,
    report: ExecutorReport,
    checkResults: readonly CheckResult[],
    signal: AbortSignal,
  ): Promise<BrainDecision<Verdict>> {
    return this.decide('judge', { task, report, checkResults }, signal);
  }

  async chooseRecovery(
    task: PlanTask,
    failure: TaskFailure,
    history: readonly TaskHistoryEntry[],
    signal: AbortSignal,
  ): Promise<BrainDecision<RecoveryChoice>> {
    return this.decide('recovery', { task, failure, history }, signal);
  }

  async proposePlaybook(request: PlaybookRequest, signal: AbortSignal): Promise<BrainDecision<PlaybookDraft | null>> {
    return this.decide('playbook', { request }, signal);
  }

  async reviewPlaybook(
    playbook: Playbook,
    validation: PlaybookValidation,
    trial: PlaybookTrial,
    signal: AbortSignal,
  ): Promise<BrainDecision<PlaybookReview>> {
    return this.decide('playbook_review', { playbook, validation, trial }, signal);
  }

  private kindScript<K extends DecisionKind>(kind: K): KindScript<K> {
    return {
      answerWith: (answer: BrainAnswer<K>): void => {
        this.stateFor(kind).queue.push(answer);
      },
      defaultAnswer: (answer: BrainAnswer<K>): void => {
        this.stateFor(kind).fallback = answer;
      },
    };
  }

  private stateFor(kind: DecisionKind): KindState {
    const existing = this.states.get(kind);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: KindState = { queue: [], fallback: undefined, failuresLeft: 0, failureReason: '' };
    this.states.set(kind, fresh);
    return fresh;
  }

  private async decide<K extends DecisionKind>(
    kind: K,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<BrainDecision<DecisionOf<K>>> {
    const startedAt = this.clock.now().toISOString();
    const state = this.stateFor(kind);
    const record: BrainCallRecord = { kind, startedAt, endedAt: null, args };
    this.callLog.push(record);
    const incurred = [defaultUsageRecord(startedAt)];
    if (state.failuresLeft > 0) {
      state.failuresLeft -= 1;
      throw new BrainError({ reason: 'failed', detail: state.failureReason, usage: incurred });
    }
    const raw: unknown = state.queue.length > 0 ? state.queue.shift() : state.fallback;
    if (!isBrainAnswer<K>(raw)) {
      throw new BrainError({ reason: 'failed', detail: `no scripted ${kind} answer`, usage: incurred });
    }
    const answer = raw;
    try {
      if (answer.delayMs !== undefined && answer.delayMs > 0) {
        await this.sleep(answer.delayMs, signal);
      } else {
        signal.throwIfAborted();
      }
    } catch {
      throw new BrainError({ reason: 'cancelled', detail: `${kind} decision cancelled`, usage: incurred });
    }
    record.endedAt = this.clock.now().toISOString();
    return { decision: answer.decision, usage: answer.usage ?? incurred };
  }
}
