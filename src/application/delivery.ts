/**
 * Delivery and the run outcome (task 3.10). Before delivery the unconfirmed
 * runs and abandoned trees are checked once more. Then, bracketed by a
 * deliver intent, a clean copy of `main` is installed, built (when a build
 * script exists) and tested under every required runtime, and every
 * acceptance check runs on it; a failed derived check the Critic excuses
 * (acceptance-review: every example check passed and the check contradicts
 * the spec) does not count as failed. The tree is copied to the output directory
 * (without `.git` and `node_modules`) only when every package step passed,
 * or when `deliverUnverified` is set: then the clean `main` is copied
 * before any verification step (design D2), so a process killed while
 * verifying still leaves it, a passing verification replaces it with the
 * verified tree, and the outcome still records a failed verification. The
 * outcome is `succeeded` when every task is integrated, the copy is
 * verified and every acceptance check passes; `partial` when a verified tree was delivered with failed tasks
 * (even none integrated), failed checks, unavailable acceptance, or an empty
 * set of acceptance checks (the Brain port's contract: an empty answer caps
 * the outcome at `partial`); `failed` when no verified tree was delivered.
 * A run without an output directory delivers its verified tree in place
 * (the clean copy), so verification alone decides between `failed` and the
 * rest. A deliver intent left by a crash is replaced by the new one: a
 * resume repeats delivery from the start.
 */

import type { RunOutcome, RunState } from '../domain';

import { excusedAtDelivery } from './acceptance-review';
import { runAcceptance } from './judge';
import type { RunContext } from './run-context';
import { sweepBeforeDelivery } from './stops';

/** What delivery did: whether the copy was verified, whether and where it was copied, and the checks that failed. */
export interface DeliveryResult {
  readonly verified: boolean;
  readonly copied: boolean;
  readonly outDir: string | null;
  readonly failedSteps: readonly string[];
  readonly failedCheckIds: readonly string[];
}

/** Verifies a clean copy of main and copies it when allowed; see the module header. */
export async function deliverRun(ctx: RunContext): Promise<DeliveryResult> {
  const { owner, ports } = ctx;
  const { options, spec } = owner.state;
  await sweepBeforeDelivery(ctx);
  const at = ctx.trace.now();
  await owner.update((state) => {
    state.intents = [...state.intents.filter((intent) => intent.kind !== 'deliver'), { kind: 'deliver', at }];
  });
  const copy = await ports.workspace.cleanCopy(spec.name);
  const outDir = options.outDir ?? null;
  const copyOut = async (): Promise<void> => {
    if (outDir === null) {
      return;
    }
    const delivered = await ports.workspace.deliver(copy.dir, outDir);
    ctx.trace.emit({ type: 'delivery_step', step: 'copy', runtime: null, ok: true, detail: `${delivered.files} files copied` });
  };
  if (options.deliverUnverified) {
    await copyOut();
  }
  const steps = await ports.checks.packageSteps(copy.dir, options.requiredRuntimes);
  for (const step of steps.steps) {
    ctx.trace.emit({ type: 'delivery_step', step: step.step, runtime: step.runtime, ok: step.ok, detail: ctx.trace.redact(step.detail) });
  }
  const results = await runAcceptance(ctx, copy.dir);
  ctx.trace.emit({ type: 'checks_run', scope: 'delivery', results: [...results] });
  const excused = excusedAtDelivery(ctx.trace, owner.state.acceptanceChecks, results);
  const verified = steps.ok;
  if (verified) {
    await copyOut();
  }
  const copied = outDir !== null && (verified || options.deliverUnverified);
  ctx.trace.emit({ type: 'delivery_done', copied, outDir: copied ? outDir : null, verified });
  await owner.removeIntents((intent) => intent.kind === 'deliver' && intent.at === at);
  return {
    verified,
    copied,
    outDir: copied ? outDir : null,
    failedSteps: steps.steps.filter((step) => !step.ok).map((step) => `${step.runtime} ${step.step}`),
    failedCheckIds: results.filter((result) => result.status !== 'passed' && !excused.has(result.checkId)).map((result) => result.checkId),
  };
}

/** The run outcome and, unless it succeeded, the reason. */
export function decideOutcome(
  state: Readonly<RunState>,
  delivery: DeliveryResult,
): { readonly outcome: RunOutcome; readonly reason: string | null } {
  if (!delivery.verified) {
    return { outcome: 'failed', reason: `verification failed: ${delivery.failedSteps.join(', ')}` };
  }
  const tasks = Object.entries(state.tasks);
  const notIntegrated = tasks.filter(([, task]) => task.state !== 'integrated').map(([taskId]) => taskId);
  const shortfalls = [
    ...(notIntegrated.length > 0 ? [`tasks not integrated: ${notIntegrated.join(', ')}`] : []),
    ...(delivery.failedCheckIds.length > 0 ? [`failed checks: ${delivery.failedCheckIds.join(', ')}`] : []),
    ...(state.acceptanceUnavailable ? ['acceptance_unavailable'] : []),
    ...(!state.acceptanceUnavailable && state.acceptanceChecks.length === 0 ? ['no acceptance checks'] : []),
  ];
  return shortfalls.length === 0 ? { outcome: 'succeeded', reason: null } : { outcome: 'partial', reason: shortfalls.join('; ') };
}
