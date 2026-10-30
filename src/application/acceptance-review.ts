/**
 * Keeping the acceptance checks true to the spec. At the start of a run the
 * spec's own examples become checks without any model; the derived checks
 * of the Acceptance analyst follow them, minus every check that reuses an
 * example id, never runs the package's command (when the examples name
 * one), runs an example's invocation with another expectation, or
 * draws an objection from the Critic's review (concurrent decisions, one per
 * batch; a review that fails every attempt keeps its batch). The HTTP checks
 * form one batch of their own, in order: they run in that order against one
 * server, so each one's expectation depends on the requests before it. The
 * spec's examples are authoritative: while the run has example checks and
 * every one of them passed, the failed derived checks are advisory, hidden
 * from the judge and excused at delivery without a review; a spec without
 * examples keeps them blocking, and a failed derived HTTP check stays
 * blocking unless the spec has HTTP example checks (a malformed HTTP block
 * gives none, so shell examples alone do not cover HTTP). Every dropped or excused check is traced
 * with its reason; example checks are never dropped.
 */

import {
  contradictionWithExamples,
  isSpecExampleCheckId,
  runsNoPackageCommand,
  specExampleChecks,
  type AcceptanceCheck,
  type CheckObjection,
  type CheckResult,
  type Spec,
} from '../domain';
import type { Brain } from '../ports';

import type { Decider } from './decide';
import type { RunTrace } from './run-trace';

/** How many derived checks one review decision sees. */
export const REVIEW_BATCH_SIZE = 5;

/** What reviewing the checks needs. */
export interface ReviewInfo {
  readonly spec: Spec;
  readonly brain: Brain;
  readonly decider: Decider;
  readonly trace: RunTrace;
}

/** The checks taken from the spec's examples. */
export function exampleChecks(spec: Spec): readonly AcceptanceCheck[] {
  return specExampleChecks(spec.markdown);
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

/** The review batches: every HTTP check in one batch, in order, the other checks in batches of `REVIEW_BATCH_SIZE`. */
function reviewBatches(checks: readonly AcceptanceCheck[]): AcceptanceCheck[][] {
  const http = checks.filter((check) => check.kind === 'http');
  const rest = batches(
    checks.filter((check) => check.kind !== 'http'),
    REVIEW_BATCH_SIZE,
  );
  return http.length === 0 ? rest : [http, ...rest];
}

/** The Critic's objections to `checks`, by check id; a failed review objects to nothing. */
async function objections(
  info: ReviewInfo,
  examples: readonly AcceptanceCheck[],
  checks: readonly AcceptanceCheck[],
  results: readonly CheckResult[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const reviews = await Promise.all(
    reviewBatches(checks).map((batch) =>
      info.decider.decide(
        'acceptance_review',
        {},
        (decisionSignal) => info.brain.reviewAcceptance(info.spec, examples, batch, results, decisionSignal),
        signal,
      ),
    ),
  );
  const ids = new Set(checks.map((check) => check.id));
  const found = new Map<string, string>();
  for (const review of reviews) {
    const objected: readonly CheckObjection[] = review.ok ? review.decision : [];
    for (const objection of objected) {
      if (ids.has(objection.checkId) && !found.has(objection.checkId)) found.set(objection.checkId, objection.reason);
    }
  }
  return found;
}

/** The deterministic reason to drop a derived check, or null. */
function deterministicDrop(check: AcceptanceCheck, examples: readonly AcceptanceCheck[]): string | null {
  if (isSpecExampleCheckId(check.id)) return 'its id is reserved for the checks taken from the spec examples';
  const commands = examples.filter((example) => example.kind === 'command');
  return runsNoPackageCommand(check, commands) ?? contradictionWithExamples(check, commands);
}

/**
 * The run's checks: the example checks, then the derived checks that
 * survive the deterministic rules and the Critic's review.
 */
export async function settleChecks(
  info: ReviewInfo,
  examples: readonly AcceptanceCheck[],
  derived: readonly AcceptanceCheck[],
  signal?: AbortSignal,
): Promise<readonly AcceptanceCheck[]> {
  const drop = (checkId: string, reason: string): void => {
    info.trace.emit({ type: 'acceptance_check_dropped', checkId, stage: 'planning', reason: info.trace.redact(reason) });
  };
  const candidates: AcceptanceCheck[] = [];
  for (const check of derived) {
    const reason = deterministicDrop(check, examples);
    if (reason === null) candidates.push(check);
    else drop(check.id, reason);
  }
  const objected = candidates.length === 0 ? new Map<string, string>() : await objections(info, examples, candidates, [], signal);
  for (const [checkId, reason] of objected) drop(checkId, `the Critic objected: ${reason}`);
  return [...examples, ...candidates.filter((check) => !objected.has(check.id))];
}

/** Why an advisory failure does not block, as traced. */
export const ADVISORY_REASON = 'advisory: every spec example check passed';

/**
 * The failed derived checks that are advisory: when the run has example
 * checks and every one of them passed in `results`, every failed derived
 * check (an HTTP one only when an HTTP example check exists); otherwise none.
 */
export function advisoryFailures(checks: readonly AcceptanceCheck[], results: readonly CheckResult[]): string[] {
  const passed = new Set(results.filter((result) => result.status === 'passed').map((result) => result.checkId));
  const examples = checks.filter((check) => isSpecExampleCheckId(check.id));
  if (examples.length === 0 || examples.some((example) => !passed.has(example.id))) return [];
  const httpCovered = examples.some((example) => example.kind === 'http');
  const httpIds = new Set(checks.filter((check) => check.kind === 'http').map((check) => check.id));
  return results
    .filter((result) => result.status !== 'passed' && !isSpecExampleCheckId(result.checkId))
    .filter((result) => httpCovered || !httpIds.has(result.checkId))
    .map((result) => result.checkId);
}

/** The failed derived checks excused at delivery (the advisory ones), each traced as dropped with its reason. */
export function excusedAtDelivery(
  trace: RunTrace,
  checks: readonly AcceptanceCheck[],
  results: readonly CheckResult[],
): ReadonlySet<string> {
  const excused = advisoryFailures(checks, results);
  for (const checkId of excused) trace.emit({ type: 'acceptance_check_dropped', checkId, stage: 'delivery', reason: ADVISORY_REASON });
  return new Set(excused);
}
