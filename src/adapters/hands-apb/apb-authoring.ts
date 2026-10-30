/**
 * `ApbAuthoring`: the factory's playbook store over `apb mcp`, shaped like
 * implementing the `PlaybookAuthoring` port.
 * Each method is one APB tool call with an MCP timeout: `playbook_list`,
 * `playbook_get` (full detail, for the YAML), `playbook_create`,
 * `playbook_validate`, `playbook_trial` and `playbook_approve`. Answers are
 * validated; a failed call rejects with an `ApbAuthoringError` naming the
 * playbook and the cause, while validation, trial and approval report their
 * verdict as a result. APB writes created playbooks into the project's
 * `.apb/playbooks/`, trials them in a detached worktree of the project HEAD,
 * and records approvals in the machine's trust store.
 */

import { z } from 'zod';

import { messageOf } from '../mcp-stdio/errors';
import type { ApbToolCaller } from './apb-tool-caller';
import type { Playbook, PlaybookDraft, PlaybookRef } from '../../domain/decisions';
import type { PlaybookAuthoring, PlaybookTrial, PlaybookValidation } from '../../ports/playbook-authoring';

/** Timeouts of the authoring calls, in milliseconds. */
export interface ApbAuthoringTimeouts {
  readonly callMs?: number;
  /** A trial blocks until the trial run ends. */
  readonly trialMs?: number;
}

/** A playbook store call failed. */
export class ApbAuthoringError extends Error {
  readonly playbookId: string;

  constructor(playbookId: string, detail: string) {
    super(`playbook ${playbookId}: ${detail}`);
    this.name = 'ApbAuthoringError';
    this.playbookId = playbookId;
  }
}

const ListSchema = z.array(z.looseObject({ id: z.string(), name: z.string() }));
const GetSchema = z.looseObject({ id: z.string(), yaml: z.string(), playbook: z.looseObject({ name: z.string() }) });
const CreateSchema = z.looseObject({ id: z.string(), version: z.string() });
const ValidateSchema = z.looseObject({ valid: z.boolean(), issues: z.array(z.unknown()) });
const TrialSchema = z.union([
  z.looseObject({ rejected: z.string() }).transform((answer) => ({ kind: 'rejected' as const, reason: answer.rejected })),
  z
    .looseObject({ run_id: z.string(), status: z.string(), notes: z.unknown().optional(), diff: z.unknown().optional() })
    .transform((answer) => ({ kind: 'ran' as const, status: answer.status, notes: answer.notes, diff: answer.diff })),
]);
const ApproveSchema = z.looseObject({ trusted: z.boolean() });
const DraftIdSchema = z.looseObject({ id: z.string().min(1) });

/** One validation issue as text. */
function issueText(issue: unknown): string {
  if (typeof issue === 'string') return issue;
  const message = z.looseObject({ message: z.string() }).safeParse(issue);
  return message.success ? message.data.message : JSON.stringify(issue);
}

/** The playbook store over one `apb mcp` connection. */
export class ApbAuthoring implements PlaybookAuthoring {
  private readonly caller: () => Promise<ApbToolCaller>;
  private readonly callMs: number;
  private readonly trialMs: number;

  /** `caller` gives the live `apb mcp` connection (the executor's session may share it). */
  constructor(caller: () => Promise<ApbToolCaller>, timeouts: ApbAuthoringTimeouts = {}) {
    this.caller = caller;
    this.callMs = timeouts.callMs ?? 30_000;
    this.trialMs = timeouts.trialMs ?? 900_000;
  }

  async list(): Promise<readonly PlaybookRef[]> {
    const playbooks = await this.call('*', 'playbook_list', {}, ListSchema);
    return playbooks.map(({ id, name }) => ({ id, name }));
  }

  async get(id: string): Promise<Playbook> {
    const answer = await this.call(id, 'playbook_get', { id, detail: 'full' }, GetSchema);
    return { id: answer.id, name: answer.playbook.name, content: answer.yaml };
  }

  /** Stores a draft under the `id` its YAML declares. */
  async create(draft: PlaybookDraft): Promise<PlaybookRef> {
    let raw: unknown;
    try {
      raw = Bun.YAML.parse(draft.content);
    } catch (error) {
      throw new ApbAuthoringError(draft.name, `the draft is not YAML: ${messageOf(error)}`);
    }
    const declared = DraftIdSchema.safeParse(raw);
    if (!declared.success) throw new ApbAuthoringError(draft.name, 'the draft declares no id');
    const created = await this.call(declared.data.id, 'playbook_create', { id: declared.data.id, yaml: draft.content }, CreateSchema);
    return { id: created.id, name: draft.name };
  }

  async validate(id: string): Promise<PlaybookValidation> {
    const answer = await this.call(id, 'playbook_validate', { id }, ValidateSchema);
    return { ok: answer.valid && answer.issues.length === 0, problems: answer.issues.map(issueText) };
  }

  async trial(id: string, inputs: Readonly<Record<string, string>>): Promise<PlaybookTrial> {
    const answer = await this.call(id, 'playbook_trial', { id, params: inputs }, TrialSchema, this.trialMs);
    if (answer.kind === 'rejected') return { ok: false, output: `trial rejected: ${answer.reason}` };
    return { ok: answer.status === 'succeeded', output: JSON.stringify({ status: answer.status, notes: answer.notes, diff: answer.diff }) };
  }

  /** Approves the playbook's current version; `approved` is what APB reports as trusted. */
  async approve(id: string): Promise<{ readonly approved: boolean }> {
    const answer = await this.call(id, 'playbook_approve', { id }, ApproveSchema);
    return { approved: answer.trusted };
  }

  private async call<T>(
    id: string,
    tool: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
    timeoutMs = this.callMs,
  ): Promise<T> {
    try {
      return await (await this.caller()).callToolParsed(tool, args, schema, { timeoutMs });
    } catch (error) {
      throw new ApbAuthoringError(id, `${tool}: ${messageOf(error)}`);
    }
  }
}
