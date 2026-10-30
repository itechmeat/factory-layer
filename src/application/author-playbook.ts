/**
 * The playbook authoring use case: the brain proposes an APB playbook for a
 * kind of task, the factory checks it against the authoring policy, stores
 * it under an id unique to the run and the draft attempt, validates it
 * (one correction for a draft that fails any of these), trials it on the
 * operator's instruction within a bounded time, asks the Critic to review
 * it, checks the stored playbook against the policy again, and approves it
 * only when the validation and trial passed and the review approves. The
 * draft is untrusted model output: nothing in it widens what the policy
 * allows. A trial that fails to answer in time, or a flow past its
 * deadline, has its APB runs found and stopped, and the flow ends `failed`.
 * The approval starts only with a margin left before the flow deadline; one
 * that still ends after it is reported `failed` with the approved id.
 * Every step is traced in the authoring run's own trace.
 */

import {
  AUTHORING_APPROVE_MARGIN_MS,
  AUTHORING_DRAFT_ATTEMPTS,
  AUTHORING_FLOW_DEADLINE_MS,
  AUTHORING_TRIAL_DEADLINE_MS,
  AUTHORING_TRIAL_STOP_MS,
  authoredPlaybookId,
  BRAIN_DECISION_DEADLINE_MS,
  authoringPolicyIssues,
  type AuthoringExample,
  type AuthoringResult,
  type AuthoringStep,
  type Playbook,
  type PlaybookDraft,
  type PlaybookReview,
} from '../domain';
import type { Brain, Clock, CostTable, PlaybookAuthoring, PlaybookTrial, PlaybookValidation, Sleep, TraceSink } from '../ports';

import { Decider } from './decide';
import { RunTrace } from './run-trace';

/** The stored playbook whose YAML the Architect gets as the format example. */
export const FORMAT_PLAYBOOK_ID = 'implement-task';

/** What the authoring run is built from. */
export interface AuthoringPorts {
  readonly brain: Brain;
  readonly playbooks: PlaybookAuthoring;
  readonly sink: TraceSink;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly costs: CostTable;
}

/** One authoring run. */
export interface AuthoringRequest {
  readonly runId: string;
  readonly taskKind: string;
  /** Unique to the run; part of every draft id. */
  readonly suffix: string;
  readonly example: AuthoringExample;
  readonly secrets: readonly string[];
}

/** One traced step, as the report lists it. */
export interface AuthoringStepRecord {
  readonly step: AuthoringStep;
  readonly ok: boolean;
  readonly playbookId: string | null;
  readonly detail: string;
}

/** How the run ended, with the playbook, the review's reasons and every step. */
export interface AuthoringOutcome {
  readonly result: AuthoringResult;
  readonly playbookId: string | null;
  readonly detail: string;
  readonly reasons: readonly string[];
  readonly steps: readonly AuthoringStepRecord[];
}

/** A draft that APB stored and validated. */
interface Stored {
  readonly id: string;
  readonly validation: PlaybookValidation;
}

/** The reason a draft attempt failed, sent back to the Architect once. */
interface Refused {
  readonly draft: PlaybookDraft;
  readonly issues: readonly string[];
}

type Ended = { readonly result: AuthoringResult; readonly detail: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The draft with `id` as its declared id, or the issue of a draft that is not a YAML mapping. */
type Assigned =
  | { readonly ok: true; readonly parsed: unknown; readonly draft: PlaybookDraft }
  | { readonly ok: false; readonly issue: string };

function withId(draft: PlaybookDraft, id: string): Assigned {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(draft.content);
  } catch (error) {
    return { ok: false, issue: `the draft is not YAML: ${messageOf(error)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { ok: false, issue: 'the draft is not a YAML mapping' };
  const assigned = { ...parsed, id };
  return { ok: true, parsed: assigned, draft: { ...draft, content: Bun.YAML.stringify(assigned, null, 2) } };
}

class AuthoringRun {
  private readonly ports: AuthoringPorts;
  private readonly request: AuthoringRequest;
  private readonly trace: RunTrace;
  private readonly decider: Decider;
  private readonly flowEndMs: number;
  private readonly steps: AuthoringStepRecord[] = [];
  private reasons: readonly string[] = [];

  constructor(ports: AuthoringPorts, request: AuthoringRequest) {
    this.ports = ports;
    this.request = request;
    this.trace = new RunTrace({
      sink: ports.sink,
      clock: ports.clock,
      runId: request.runId,
      specName: `author-${request.taskKind}`,
      secrets: request.secrets,
    });
    this.decider = new Decider({
      trace: this.trace,
      sleep: ports.sleep,
      costs: ports.costs,
      deadlineMs: BRAIN_DECISION_DEADLINE_MS,
      signal: new AbortController().signal,
    });
    this.flowEndMs = this.trace.nowMs() + AUTHORING_FLOW_DEADLINE_MS;
  }

  async run(): Promise<AuthoringOutcome> {
    this.trace.emit({ type: 'authoring_started', taskKind: this.request.taskKind });
    let ended: Ended & { readonly playbookId: string | null };
    try {
      ended = await this.flow();
    } catch (error) {
      ended = { result: 'failed', detail: `authoring error: ${messageOf(error)}`, playbookId: null };
    }
    this.trace.emit({ type: 'authoring_ended', result: ended.result, playbookId: ended.playbookId, detail: ended.detail });
    return { ...ended, reasons: this.reasons, steps: this.steps };
  }

  private step(step: AuthoringStep, ok: boolean, playbookId: string | null, detail: string): void {
    const redacted = this.trace.redact(detail);
    this.steps.push({ step, ok, playbookId, detail: redacted });
    this.trace.emit({ type: 'authoring_step', step, ok, playbookId, detail: redacted });
  }

  private pastDeadline(): boolean {
    return this.trace.nowMs() >= this.flowEndMs;
  }

  private async flow(): Promise<Ended & { readonly playbookId: string | null }> {
    let format: Playbook;
    try {
      format = await this.ports.playbooks.get(FORMAT_PLAYBOOK_ID);
      this.step('format', true, FORMAT_PLAYBOOK_ID, 'format example read');
    } catch (error) {
      this.step('format', false, FORMAT_PLAYBOOK_ID, messageOf(error));
      return { result: 'failed', detail: 'the format example could not be read', playbookId: null };
    }
    const drafted = await this.draftAndStore(format.content);
    if ('result' in drafted) return drafted;
    const { id, validation } = drafted;
    if (this.pastDeadline()) return this.stopAndFail(id, this.trace.nowMs(), 'the flow deadline passed before the trial');
    const trialStartMs = this.trace.nowMs();
    const trial = await this.trial(id);
    if (trial === null) return this.stopAndFail(id, trialStartMs, 'the trial did not answer in time');
    const review = await this.review(id, validation, trial);
    if (review === null) return { result: 'failed', detail: 'the Critic could not review the playbook', playbookId: id };
    if (!trial.ok || review.verdict !== 'approve') {
      const why = trial.ok ? 'the Critic rejected the playbook' : `the trial failed (the Critic answered ${review.verdict})`;
      return { result: 'rejected', detail: why, playbookId: id };
    }
    if (this.pastDeadline()) return { result: 'failed', detail: 'the flow deadline passed before the approval', playbookId: id };
    return this.approve(id);
  }

  /** Drafts, checks, stores and validates, with one correction; a stored draft or how the flow ended. */
  private async draftAndStore(format: string): Promise<Stored | (Ended & { readonly playbookId: string | null })> {
    let refused: Refused | undefined;
    for (let attempt = 1; attempt <= AUTHORING_DRAFT_ATTEMPTS; attempt += 1) {
      const id = authoredPlaybookId(this.request.taskKind, this.request.suffix, attempt);
      const outcome = await this.decider.decide('playbook', {}, (signal) =>
        this.ports.brain.proposePlaybook(
          {
            taskKind: this.request.taskKind,
            examples: this.request.example.examples,
            formatExample: format,
            playbookId: id,
            ...(refused === undefined ? {} : { correction: refused }),
          },
          signal,
        ),
      );
      if (!outcome.ok) {
        this.step('draft', false, id, outcome.failure.detail);
        return { result: 'failed', detail: 'the Architect could not draft a playbook', playbookId: null };
      }
      if (outcome.decision === null) {
        this.step('draft', false, id, 'no playbook found for the examples');
        return { result: 'none', detail: 'the Architect found no reusable playbook', playbookId: null };
      }
      this.step('draft', true, id, outcome.decision.name);
      const attempted = await this.store(id, outcome.decision);
      if (!('issues' in attempted)) return attempted;
      refused = attempted;
      if (this.pastDeadline()) return { result: 'failed', detail: 'the flow deadline passed while drafting', playbookId: null };
    }
    return { result: 'rejected', detail: 'the corrected draft failed too', playbookId: null };
  }

  /** One draft attempt after the brain answered: policy, create, validate. */
  private async store(id: string, answer: PlaybookDraft): Promise<Stored | Refused> {
    const assigned = withId(answer, id);
    if (!assigned.ok) {
      this.step('policy', false, id, assigned.issue);
      return { draft: answer, issues: [assigned.issue] };
    }
    const { parsed, draft } = assigned;
    const issues = authoringPolicyIssues(parsed, id);
    this.step('policy', issues.length === 0, id, issues.length === 0 ? 'allowed' : issues.join('; '));
    if (issues.length > 0) return { draft, issues };
    try {
      const created = await this.ports.playbooks.create(draft);
      if (created.id !== id) {
        this.step('create', false, id, `stored as ${created.id}`);
        return { draft, issues: [`APB stored the playbook as ${created.id}, not ${id}`] };
      }
      this.step('create', true, id, 'stored');
    } catch (error) {
      this.step('create', false, id, messageOf(error));
      return { draft, issues: [`APB refused the playbook: ${messageOf(error)}`] };
    }
    const validation = await this.ports.playbooks.validate(id);
    const warned = validation.warnings.length === 0 ? '' : ` (warnings: ${validation.warnings.join('; ')})`;
    this.step('validate', validation.ok, id, `${validation.ok ? 'valid' : validation.problems.join('; ')}${warned}`);
    if (!validation.ok) return { draft, issues: validation.problems };
    return { id, validation };
  }

  /** The trial, or null when it did not answer within its deadline (nor the flow's). */
  private async trial(id: string): Promise<PlaybookTrial | null> {
    const limitMs = Math.min(AUTHORING_TRIAL_DEADLINE_MS, this.flowEndMs - this.trace.nowMs());
    const timer = new AbortController();
    const settled = await Promise.race([
      this.ports.playbooks.trial(id, {}, this.request.example.trialInstruction).then(
        (trial) => ({ tag: 'answered' as const, trial }),
        (error: unknown) => ({ tag: 'failed' as const, detail: messageOf(error) }),
      ),
      this.ports.sleep(limitMs, timer.signal).then(
        () => ({ tag: 'timeout' as const }),
        () => ({ tag: 'timeout' as const }),
      ),
    ]);
    timer.abort();
    if (settled.tag === 'answered') {
      this.step('trial', settled.trial.ok, id, settled.trial.output);
      return settled.trial;
    }
    this.step('trial', false, id, settled.tag === 'timeout' ? `no answer within ${String(limitMs)} ms` : settled.detail);
    return null;
  }

  private async stopAndFail(id: string, notBeforeMs: number, why: string): Promise<Ended & { readonly playbookId: string }> {
    const stop = await this.ports.playbooks.stopTrials(id, notBeforeMs, AUTHORING_TRIAL_STOP_MS);
    // A worktree trial is not listed in the project's runs, so finding none is not a confirmed stop.
    const confirmed = stop.searched && stop.runs.length > 0 && stop.runs.every((run) => run.outcome !== 'unconfirmed');
    this.step('trial_stop', confirmed, id, stop.detail);
    const runs = stop.runs.map((run) => run.runId).join(', ');
    return { result: 'failed', detail: `${why}; trial runs: ${runs === '' ? 'none found' : runs}`, playbookId: id };
  }

  private async review(id: string, validation: PlaybookValidation, trial: PlaybookTrial): Promise<PlaybookReview | null> {
    let stored: Playbook;
    try {
      stored = await this.ports.playbooks.get(id);
    } catch (error) {
      this.step('review', false, id, messageOf(error));
      return null;
    }
    const outcome = await this.decider.decide('playbook_review', {}, (signal) =>
      this.ports.brain.reviewPlaybook(stored, validation, trial, signal),
    );
    if (!outcome.ok) {
      this.step('review', false, id, outcome.failure.detail);
      return null;
    }
    this.reasons = outcome.decision.reasons;
    this.step('review', true, id, `${outcome.decision.verdict}: ${outcome.decision.reasons.join('; ')}`);
    return outcome.decision;
  }

  /**
   * Re-checks the playbook APB holds against the policy, then approves it
   * when at least AUTHORING_APPROVE_MARGIN_MS is left before the flow
   * deadline; an approval that ends after the deadline is reported `failed`
   * with the approved id (the port has no revoke).
   */
  private async approve(id: string): Promise<Ended & { readonly playbookId: string }> {
    let issues: readonly string[];
    try {
      const stored = await this.ports.playbooks.get(id);
      issues = authoringPolicyIssues(Bun.YAML.parse(stored.content), id);
    } catch (error) {
      issues = [messageOf(error)];
    }
    this.step('recheck', issues.length === 0, id, issues.length === 0 ? 'allowed' : issues.join('; '));
    if (issues.length > 0) return { result: 'rejected', detail: 'the stored playbook breaks the authoring policy', playbookId: id };
    if (this.flowEndMs - this.trace.nowMs() < AUTHORING_APPROVE_MARGIN_MS) {
      return { result: 'failed', detail: 'too little time was left before the flow deadline to approve', playbookId: id };
    }
    try {
      const { approved } = await this.ports.playbooks.approve(id);
      this.step('approve', approved, id, approved ? 'approved' : 'APB declined the approval');
      if (!approved) return { result: 'failed', detail: 'APB declined the approval', playbookId: id };
      return this.pastDeadline()
        ? { result: 'failed', detail: `approved as ${id}, but only after the flow deadline`, playbookId: id }
        : { result: 'approved', detail: `approved as ${id}`, playbookId: id };
    } catch (error) {
      this.step('approve', false, id, messageOf(error));
      return { result: 'failed', detail: 'the approval failed', playbookId: id };
    }
  }
}

/** Runs one authoring flow to its outcome; it never rejects. */
export function authorPlaybook(ports: AuthoringPorts, request: AuthoringRequest): Promise<AuthoringOutcome> {
  return new AuthoringRun(ports, request).run();
}
