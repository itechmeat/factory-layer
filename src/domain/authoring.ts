/**
 * Playbook authoring rules: the Critic's playbook review, the outcome of an
 * authoring run, the id each draft attempt gets, the operator's example
 * file, and the deterministic policy an authored playbook must meet before
 * APB stores or approves it. The draft comes from a model and is untrusted:
 * the policy is an allowlist (agent steps on the `claude` profile only, no
 * scripts, sub-playbooks, gates, connectors, supervisors or goal scripts,
 * and effects within those the starter playbooks declare).
 */

import { z } from 'zod';

/** The trial of one draft may run this long. */
export const AUTHORING_TRIAL_DEADLINE_MS = 900_000;
/** The whole authoring flow may run this long. */
export const AUTHORING_FLOW_DEADLINE_MS = 1_800_000;
/** Finding and stopping the runs a timed out trial left, confirmation included. */
export const AUTHORING_TRIAL_STOP_MS = 60_000;
/** The least time before the flow deadline an approval may start with. */
export const AUTHORING_APPROVE_MARGIN_MS = 60_000;
/** Draft attempts: the first draft plus one correction. */
export const AUTHORING_DRAFT_ATTEMPTS = 2;

/** The only agent profile an authored playbook may use. */
export const AUTHORING_PROFILE = 'claude';
/** The effects the starter playbooks declare; an authored playbook stays within them. */
export const AUTHORING_EFFECTS: readonly string[] = ['fs_read', 'fs_write', 'network'];

/** The Critic's review of a playbook draft; it always gives at least one reason. */
export const PlaybookReviewSchema = z.object({
  verdict: z.enum(['approve', 'reject']),
  reasons: z.array(z.string().min(1)).min(1),
});
export type PlaybookReview = z.infer<typeof PlaybookReviewSchema>;

/** How an authoring run ended. */
export const AUTHORING_RESULTS = ['approved', 'rejected', 'none', 'failed'] as const;
export type AuthoringResult = (typeof AUTHORING_RESULTS)[number];

/** The steps an authoring run traces. */
export const AUTHORING_STEPS = [
  'format',
  'draft',
  'policy',
  'create',
  'validate',
  'trial',
  'trial_stop',
  'review',
  'recheck',
  'approve',
] as const;
export type AuthoringStep = (typeof AUTHORING_STEPS)[number];

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** True when `kind` can be part of a playbook id. */
export function isAuthoringKind(kind: string): boolean {
  return SLUG.test(kind) && kind.length <= 40;
}

/** The id of one draft attempt: unique to the authoring run (`suffix`) and the attempt. */
export function authoredPlaybookId(kind: string, suffix: string, attempt: number): string {
  return `authored-${kind}-${suffix}-d${String(attempt)}`;
}

/** What the operator's example file gives the authoring run. */
export interface AuthoringExample {
  readonly examples: readonly string[];
  readonly trialInstruction: string;
}

/** The body of the `## <title>` section, or null when there is none. */
function section(markdown: string, title: string): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${title.toLowerCase()}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

/**
 * Reads an example file: the `## Examples` bullets (at least one) and the
 * `## Trial` instruction (not empty); anything else throws `RangeError`.
 */
export function parseAuthoringExample(markdown: string): AuthoringExample {
  const bullets = (section(markdown, 'Examples') ?? '')
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
  if (bullets.length === 0) throw new RangeError('the example file has no `## Examples` bullet');
  const trial = section(markdown, 'Trial');
  if (trial === null || trial === '') throw new RangeError('the example file has no `## Trial` instruction');
  return { examples: bullets, trialInstruction: trial };
}

// ---- policy ----

const TOP_LEVEL_KEYS = new Set([
  'schema',
  'id',
  'name',
  'description',
  'version',
  'params',
  'defaults',
  'trigger',
  'requires',
  'effects',
  'goal',
  'supervisor',
  'nodes',
  'edges',
]);
const COMMON_NODE_KEYS = ['id', 'type', 'title', 'expected_duration', 'inputs', 'outputs', 'cache'];
const NODE_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  start: new Set(COMMON_NODE_KEYS),
  finish: new Set([...COMMON_NODE_KEYS, 'outcome', 'prompt', 'profile']),
  agent_task: new Set([
    ...COMMON_NODE_KEYS,
    'prompt',
    'profile',
    'max_retries',
    'timeout_seconds',
    'workdir',
    'isolation',
    'connectors',
    'interactive',
  ]),
};
/** Node fields that must be absent or empty: each widens what the agent can reach. */
const EMPTY_NODE_FIELDS = ['workdir', 'isolation', 'connectors', 'interactive'] as const;

const ProfileRefSchema = z.union([z.string(), z.looseObject({ name: z.string() }).transform((ref) => ref.name)]);
const ParamSchema = z.looseObject({ name: z.string(), default: z.unknown().optional() });
const CriterionSchema = z.looseObject({ check: z.looseObject({ type: z.string() }).optional() });

const MappingSchema = z.record(z.string(), z.unknown());

function record(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return null;
  const parsed = MappingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === false || (Array.isArray(value) && value.length === 0);
}

/** The profile name a reference names, `null` for no reference, `undefined` for a malformed one. */
function profileName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  const parsed = ProfileRefSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function nodeIssues(node: unknown, index: number, defaultProfile: string | null | undefined): string[] {
  const fields = record(node);
  if (fields === null) return [`node ${String(index)}: not an object`];
  const id = typeof fields['id'] === 'string' ? fields['id'] : String(index);
  const type = typeof fields['type'] === 'string' ? fields['type'] : '';
  const allowedKeys = NODE_KEYS[type];
  if (allowedKeys === undefined) return [`node ${id}: type ${JSON.stringify(type)} is not allowed; use start, agent_task or finish`];
  const issues = Object.keys(fields)
    .filter((key) => !allowedKeys.has(key))
    .map((key) => `node ${id}: field ${key} is not allowed`);
  if (type !== 'agent_task') return issues;
  for (const field of EMPTY_NODE_FIELDS) {
    if (!isEmpty(fields[field])) issues.push(`node ${id}: ${field} must be empty`);
  }
  const own = profileName(fields['profile']);
  const effective = own === null ? defaultProfile : own;
  if (effective !== AUTHORING_PROFILE) issues.push(`node ${id}: the agent node must run on the ${AUTHORING_PROFILE} profile`);
  return issues;
}

function paramIssues(params: unknown): string[] {
  if (params === undefined || params === null) return [];
  if (!Array.isArray(params)) return ['params must be a list'];
  return params.flatMap((param, index) => {
    const parsed = ParamSchema.safeParse(param);
    if (!parsed.success) return [`param ${String(index)}: malformed`];
    return parsed.data.default === undefined || parsed.data.default === null ? [`param ${parsed.data.name}: needs a default`] : [];
  });
}

function goalIssues(goal: unknown): string[] {
  if (goal === undefined || goal === null) return [];
  const criteria = record(goal)?.['criteria'];
  if (criteria === undefined) return [];
  if (!Array.isArray(criteria)) return ['goal criteria must be a list'];
  return criteria.flatMap((criterion, index) => {
    const parsed = CriterionSchema.safeParse(criterion);
    if (!parsed.success) return [`goal criterion ${String(index)}: malformed`];
    return parsed.data.check?.type === 'script' ? [`goal criterion ${String(index)}: script checks are not allowed`] : [];
  });
}

/**
 * Every way the parsed playbook `draft` breaks the authoring policy, given
 * the `id` it must declare; an empty list means it may be stored and
 * approved.
 */
export function authoringPolicyIssues(draft: unknown, id: string): string[] {
  const fields = record(draft);
  if (fields === null) return ['the playbook is not a YAML mapping'];
  const issues = Object.keys(fields)
    .filter((key) => !TOP_LEVEL_KEYS.has(key))
    .map((key) => `field ${key} is not allowed`);
  if (fields['id'] !== id) issues.push(`the id must be ${id}`);
  if (!isEmpty(fields['supervisor'])) issues.push('a supervisor is not allowed');
  const effects = fields['effects'];
  if (Array.isArray(effects)) {
    for (const effect of effects) {
      if (typeof effect !== 'string' || !AUTHORING_EFFECTS.includes(effect))
        issues.push(`effect ${JSON.stringify(effect)} is not allowed; use only ${AUTHORING_EFFECTS.join(', ')}`);
    }
  } else issues.push('effects must be a list');
  issues.push(...paramIssues(fields['params']), ...goalIssues(fields['goal']));
  const defaultProfile = profileName(record(fields['defaults'])?.['profile']);
  const nodes = fields['nodes'];
  if (!Array.isArray(nodes) || nodes.length === 0) issues.push('nodes must be a non-empty list');
  else issues.push(...nodes.flatMap((node, index) => nodeIssues(node, index, defaultProfile)));
  return issues;
}
