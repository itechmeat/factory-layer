/**
 * The doctor's MCP plumbing and its APB trust check. `withServer` connects
 * to a stdio MCP server under the check's abort signal, so an aborted check
 * closes its client and the server process ends with it. `starterApproval`
 * checks that each starter playbook is approved at its current version and
 * that each profile the starters default to is approved at its current
 * bundle. APB 1.0.0-beta.1 lists playbook approvals by digest only and
 * exposes no playbook digest per version, so the playbook half reads
 * `playbook_catalog`, whose `trusted` is APB's verdict for the current
 * version; the profile half matches `profile_get`'s `bundle_digest` against
 * the `profile_bundle` entries of `trust_list`. Every answer is validated
 * with Zod.
 */

import { z } from 'zod';

import type { ApbToolCaller } from '../adapters/hands-apb/apb-tool-caller';
import { connectMcpStdio, type McpServerCommand, type McpStdioClient } from '../adapters/mcp-stdio/client';

/** The budgets of one server check, in milliseconds. */
export interface ServerBudget {
  readonly signal: AbortSignal;
  readonly connectMs: number;
  readonly callMs: number;
}

/** Connects under `budget.signal`, runs `work` and closes, so no server outlives the check. */
export async function withServer<T>(
  server: McpServerCommand,
  budget: ServerBudget,
  work: (client: McpStdioClient) => Promise<T>,
): Promise<T> {
  const client = await connectMcpStdio(server, { connectTimeoutMs: budget.connectMs, callTimeoutMs: budget.callMs, signal: budget.signal });
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}

const CatalogSchema = z.looseObject({
  entries: z.array(
    z.looseObject({
      ref: z.looseObject({ id: z.string(), version: z.string() }),
      shadowed: z.boolean(),
      trusted: z.boolean(),
    }),
  ),
});
const PlaybookDefaultsSchema = z.looseObject({
  defaults: z.looseObject({ profile: z.looseObject({ name: z.string() }).nullable().optional() }).optional(),
});
const ProfileSchema = z.looseObject({ bundle_digest: z.string() });
const TrustListSchema = z.looseObject({ approvals: z.array(z.looseObject({ kind: z.string(), id: z.string(), digest: z.string() })) });

/** The starters approved at their current versions, as `id version`, and what is not approved. */
async function catalogApproval(
  caller: ApbToolCaller,
  starters: readonly string[],
  timeoutMs: number,
): Promise<{ approved: string[]; problems: string[] }> {
  const catalog = await caller.callToolParsed('playbook_catalog', {}, CatalogSchema, { timeoutMs });
  const approved: string[] = [];
  const problems: string[] = [];
  for (const id of starters) {
    const entry = catalog.entries.find((candidate) => candidate.ref.id === id && !candidate.shadowed);
    if (entry === undefined) problems.push(`${id} is not in the playbook catalog`);
    else if (entry.trusted) approved.push(`${id} ${entry.ref.version}`);
    else problems.push(`${id} ${entry.ref.version} is not approved at its current version`);
  }
  return { approved, problems };
}

/** The profiles the starters name as their default. */
async function defaultProfiles(caller: ApbToolCaller, starters: readonly string[], timeoutMs: number): Promise<string[]> {
  const names = new Set<string>();
  for (const id of starters) {
    const playbook = await caller.callToolParsed('playbook_get', { id }, PlaybookDefaultsSchema, { timeoutMs });
    const name = playbook.defaults?.profile?.name;
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

/** The profiles among `names` whose current bundle is not in the trust list. */
async function unapprovedProfiles(caller: ApbToolCaller, names: readonly string[], timeoutMs: number): Promise<string[]> {
  if (names.length === 0) return [];
  const trust = await caller.callToolParsed('trust_list', {}, TrustListSchema, { timeoutMs });
  const problems: string[] = [];
  for (const name of names) {
    const profile = await caller.callToolParsed('profile_get', { name }, ProfileSchema, { timeoutMs });
    const approved = trust.approvals.some(
      (entry) => entry.kind === 'profile_bundle' && entry.id === name && entry.digest === profile.bundle_digest,
    );
    if (!approved) problems.push(`profile ${name}: its current bundle is not approved`);
  }
  return problems;
}

/**
 * Checks the starters and their default profiles; resolves with what it
 * found, rejects naming every starter or profile that is not approved at its
 * current version or bundle.
 */
export async function starterApproval(caller: ApbToolCaller, starters: readonly string[], timeoutMs: number): Promise<string> {
  const playbooks = await catalogApproval(caller, starters, timeoutMs);
  const profiles = await defaultProfiles(caller, starters, timeoutMs);
  const problems = [...playbooks.problems, ...(await unapprovedProfiles(caller, profiles, timeoutMs))];
  if (problems.length > 0) throw new Error(problems.join('; '));
  const profileText = profiles.length === 0 ? 'no default profile' : profiles.map((name) => `profile ${name}`).join(', ');
  return `approved at their current versions: ${playbooks.approved.join(', ')}; ${profileText} approved at its current bundle`;
}
