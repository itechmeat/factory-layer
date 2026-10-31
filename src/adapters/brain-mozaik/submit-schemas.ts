/**
 * The submit-tool schemas of the brain's decisions: the domain schemas
 * narrowed for the model and flattened into one object per tool call, and
 * the step that fills in what the core owns. A plan names only the
 * playbook a plan may run (`build-task`) and carries no
 * revisions: the adapter assigns them against the plan being replaced, and
 * a re-plan keeps every integrated task exactly as it was. Verdicts,
 * recovery choices and playbook proposals are flat objects the model fills
 * in, validated into the domain's discriminated shapes, so a missing field
 * goes back to the model as a validation error naming it. Acceptance
 * checks are validated against the spec they derive from: each must quote
 * its source passage verbatim and may not take an example check's id; an
 * acceptance review may object only to the checks it was shown; a playbook
 * review gives at least one reason.
 */

import { z } from 'zod';

import {
  CheckObjectionSchema,
  CliCheckSchema,
  CommandCheckSchema,
  HttpCheckSchema,
  type AcceptanceCheck,
  type CheckObjection,
} from '../../domain/acceptance';
import { PlaybookReviewSchema } from '../../domain/authoring';
import { RecoveryChoiceSchema, type PlaybookDraft, type RecoveryChoice, type Verdict } from '../../domain/decisions';
import { PlanTaskSchema, type Plan, type PlanTask } from '../../domain/plan';
import { isSpecExampleCheckId, SPEC_EXAMPLE_ID_PREFIX, unquotedParts } from '../../domain/spec-examples';

/** The playbooks a plan may name: one, which scaffolds the root task and implements the others. */
export const PLAN_PLAYBOOKS = ['build-task'] as const;

const PlanTaskSubmissionSchema = z.object({
  id: PlanTaskSchema.shape.id,
  title: z.string().min(1),
  description: z.string().min(1),
  playbook: z.enum(PLAN_PLAYBOOKS),
  ownedPaths: z.array(z.string().min(1)),
  dependsOn: z.array(z.string().min(1)),
});
type PlanTaskSubmission = z.infer<typeof PlanTaskSubmissionSchema>;

/** A plan as the model submits it: no revisions, only the allowed playbooks. */
export const PlanSubmissionSchema = z.object({ tasks: z.array(PlanTaskSubmissionSchema).min(1) });
export type PlanSubmission = z.infer<typeof PlanSubmissionSchema>;

function sameContent(task: PlanTaskSubmission, previous: PlanTask): boolean {
  return (
    task.title === previous.title &&
    task.description === previous.description &&
    task.playbook === previous.playbook &&
    task.ownedPaths.join('\n') === previous.ownedPaths.join('\n') &&
    task.dependsOn.join('\n') === previous.dependsOn.join('\n')
  );
}

/**
 * The full plan for a submission: a new task gets revision 1, a task of the
 * previous plan keeps its revision when unchanged and gets the next one when
 * changed; every `kept` task (integrated ones on a re-plan) is the previous
 * task itself, added in front when the submission left it out.
 */
export function completePlan(submitted: PlanSubmission, previous: Plan | null, kept: ReadonlySet<string> = new Set()): Plan {
  const before = new Map((previous?.tasks ?? []).map((task) => [task.id, task]));
  const tasks = submitted.tasks.map((task): PlanTask => {
    const old = before.get(task.id);
    if (old === undefined) return { ...task, revision: 1 };
    if (kept.has(task.id)) return old;
    return { ...task, revision: sameContent(task, old) ? old.revision : old.revision + 1 };
  });
  const submittedIds = new Set(tasks.map((task) => task.id));
  const missing = (previous?.tasks ?? []).filter((task) => kept.has(task.id) && !submittedIds.has(task.id));
  return { tasks: [...missing, ...tasks] };
}

const SOURCE = z
  .string()
  .min(1)
  .describe('the spec sentence(s) or example this check derives from, copied verbatim from the spec; join separate passages with "..."');

/** A derived check as the model submits it: one of the check kinds with a required `source` quote. */
const SubmittedCheckSchema = z.discriminatedUnion('kind', [
  CliCheckSchema.extend({ source: SOURCE }),
  HttpCheckSchema.extend({ source: SOURCE }),
  CommandCheckSchema.extend({ source: SOURCE }),
]);

/**
 * The acceptance checks derived from `markdown`: ids unique and outside the
 * example prefix, every `source` a verbatim quote of the spec (whitespace
 * aside); a violation goes back to the model naming the check and the
 * unquoted text.
 */
export function acceptanceSubmissionSchema(markdown: string): z.ZodType<readonly AcceptanceCheck[]> {
  return z
    .object({ checks: z.array(SubmittedCheckSchema) })
    .superRefine((value, ctx) => {
      const seen = new Set<string>();
      for (const [index, check] of value.checks.entries()) {
        if (seen.has(check.id)) ctx.addIssue({ code: 'custom', path: ['checks', index, 'id'], message: `duplicate check id ${check.id}` });
        seen.add(check.id);
        if (isSpecExampleCheckId(check.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['checks', index, 'id'],
            message: `check ids starting with ${SPEC_EXAMPLE_ID_PREFIX} are reserved for the spec example checks; choose another id`,
          });
        }
        const missing = unquotedParts(markdown, check.source);
        if (missing.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['checks', index, 'source'],
            message: `check ${check.id}: the source is not a verbatim quote of the spec: ${missing.map((part) => JSON.stringify(part)).join(', ')}; copy the sentence(s) or example from the spec exactly, or drop the check when the spec does not state it`,
          });
        }
      }
    })
    .transform((value): readonly AcceptanceCheck[] => value.checks);
}

/** A review of the checks with `ids`: objections only to those checks, at most one each. */
export function reviewSubmissionSchema(ids: readonly string[]): z.ZodType<readonly CheckObjection[]> {
  const known = new Set(ids);
  return z
    .object({
      objections: z.array(CheckObjectionSchema).describe('one entry per check that contradicts the spec; empty when every check is right'),
    })
    .superRefine((value, ctx) => {
      const seen = new Set<string>();
      for (const [index, objection] of value.objections.entries()) {
        if (!known.has(objection.checkId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['objections', index, 'checkId'],
            message: `unknown check id ${objection.checkId}; object only to the candidate checks: ${ids.join(', ')}`,
          });
        }
        if (seen.has(objection.checkId)) {
          ctx.addIssue({ code: 'custom', path: ['objections', index, 'checkId'], message: `duplicate objection to ${objection.checkId}` });
        }
        seen.add(objection.checkId);
      }
    })
    .transform((value): readonly CheckObjection[] => value.objections);
}

/** A verdict as one flat object; a reject needs at least one reason. */
export const VerdictSubmissionSchema = z
  .object({
    outcome: z.enum(['accept', 'reject']),
    reasons: z.array(z.string().min(1)).default([]),
    failedCheckIds: z.array(z.string().min(1)).default([]),
  })
  .refine((value) => value.outcome === 'accept' || value.reasons.length > 0, {
    message: 'a reject needs at least one reason',
    path: ['reasons'],
  })
  .transform((value): Verdict =>
    value.outcome === 'accept'
      ? { outcome: 'accept' }
      : { outcome: 'reject', reasons: value.reasons, failedCheckIds: value.failedCheckIds },
  );

/** The APB agent profiles a rebind may name; only `claude` exists today. */
export const AGENT_PROFILES: readonly [string, ...string[]] = ['claude'];

/**
 * A recovery choice as one flat object; the fields the choice needs are
 * required by the domain schema, and a rebind names one of `profiles`.
 */
export function recoverySubmissionSchema(profiles: readonly [string, ...string[]]): z.ZodType<RecoveryChoice> {
  return (
    z
      .object({
        choice: z.enum(['retry', 'rebind', 'repair', 'replan', 'give_up']),
        hint: z.string().optional().describe('required for retry and rebind'),
        profile: z.enum(profiles).optional().describe('required for rebind: the agent profile to switch to'),
        failingCheckIds: z.array(z.string()).optional().describe('required for repair'),
        reason: z.string().optional().describe('required for give_up'),
      })
      // The shape is checked by the domain schema the pipe hands it to.
      .transform((value): unknown => {
        switch (value.choice) {
          case 'retry':
            return { choice: value.choice, hint: value.hint };
          case 'rebind':
            return { choice: value.choice, profile: value.profile, hint: value.hint };
          case 'repair':
            return { choice: value.choice, failingCheckIds: value.failingCheckIds };
          case 'replan':
            return { choice: value.choice };
          case 'give_up':
            return { choice: value.choice, reason: value.reason };
        }
      })
      .pipe(RecoveryChoiceSchema)
  );
}

/** A playbook proposal: `found: false` means none; otherwise the draft's fields are required. */
export const PlaybookSubmissionSchema = z
  .object({
    found: z.boolean(),
    name: z.string().optional(),
    description: z.string().optional(),
    content: z.string().optional().describe('the playbook YAML, declaring its id'),
  })
  .transform((value) => (value.found ? { name: value.name, description: value.description, content: value.content } : null))
  .pipe(
    z.object({ name: z.string().min(1), description: z.string().min(1), content: z.string().min(1) }).nullable(),
  ) satisfies z.ZodType<PlaybookDraft | null>;

/** A playbook review: approve or reject with at least one reason. */
export const PlaybookReviewSubmissionSchema = z.object({
  verdict: PlaybookReviewSchema.shape.verdict,
  reasons: PlaybookReviewSchema.shape.reasons.describe('what you checked and what you found; at least one'),
});
