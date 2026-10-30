/**
 * `ApbAuthoring`: the factory's playbook store over `apb mcp`, shaped like
 * implementing the `PlaybookAuthoring` port.
 * Each method is one APB tool call with an MCP timeout: `playbook_list`,
 * `playbook_get` (full detail, for the YAML), `playbook_create`,
 * `playbook_validate`, `playbook_trial` and `playbook_approve`; stopping
 * trial runs lists the runs (`runs_list`) and stops each live one of the
 * playbook started since the given instant (`run_stop`, then `run_status`
 * until confirmed). A trial run is attributed by its `playbook` (the draft
 * id) and `started_ts` (wall-clock ms), as recorded under
 * `tests/fixtures/apb/runs_list-trial.json`; a run `runs_list` already shows
 * terminal needs no stop (`run_status` may still report its driver alive
 * right after it ended). Answers are
 * validated (a validation issue APB marks as a warning does not block); a failed call rejects with an `ApbAuthoringError` naming the
 * playbook and the cause, while validation, trial and approval report their
 * verdict as a result. APB writes created playbooks into the project's
 * `.apb/playbooks/`, trials them in a detached worktree of the project HEAD,
 * and records approvals in the machine's trust store.
 */

import { z } from 'zod';

import { messageOf } from '../mcp-stdio/errors';
import { type ApbToolCaller, leftUntil } from './apb-tool-caller';
import { RunsListSchema, RunStatusSchema, TERMINAL_RUN_STATUSES } from './apb-run-schemas';
import { stopAndConfirm } from './stop-run';
import type { Playbook, PlaybookDraft, PlaybookRef } from '../../domain/decisions';
import type { PlaybookAuthoring, PlaybookTrial, PlaybookValidation, TrialRunStop, TrialStopResult } from '../../ports/playbook-authoring';

/** Timeouts of the authoring calls, in milliseconds. */
export interface ApbAuthoringTimeouts {
  readonly callMs?: number;
  /** A trial blocks until the trial run ends. */
  readonly trialMs?: number;
  /** The pause between two status polls while a stop is confirmed. */
  readonly pollIntervalMs?: number;
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
    .looseObject({ run_id: z.string(), status: z.string() })
    .transform((answer) => ({ kind: 'ran' as const, status: answer.status, answer })),
]);
const ApproveSchema = z.looseObject({ trusted: z.boolean() });
const DraftIdSchema = z.looseObject({ id: z.string().min(1) });
/** `runs_list` with the status each run had when listed. */
const TrialRunsSchema = RunsListSchema.element.extend({ status: RunStatusSchema });

const IssueSchema = z.looseObject({ message: z.string(), code: z.string().optional(), severity: z.string().optional() });

/** One validation issue as text, with its APB code when it has one. */
function issueText(issue: unknown): string {
  if (typeof issue === 'string') return issue;
  const parsed = IssueSchema.safeParse(issue);
  if (!parsed.success) return JSON.stringify(issue);
  return parsed.data.code === undefined ? parsed.data.message : `${parsed.data.code}: ${parsed.data.message}`;
}

/** True for an issue APB marks as a warning; anything else blocks. */
function isWarning(issue: unknown): boolean {
  const parsed = IssueSchema.safeParse(issue);
  return parsed.success && parsed.data.severity === 'warning';
}

/** The playbook store over one `apb mcp` connection. */
export class ApbAuthoring implements PlaybookAuthoring {
  private readonly caller: () => Promise<ApbToolCaller>;
  private readonly callMs: number;
  private readonly trialMs: number;
  private readonly pollIntervalMs: number;

  /** `caller` gives the live `apb mcp` connection (the executor's session may share it). */
  constructor(caller: () => Promise<ApbToolCaller>, timeouts: ApbAuthoringTimeouts = {}) {
    this.caller = caller;
    this.callMs = timeouts.callMs ?? 30_000;
    this.trialMs = timeouts.trialMs ?? 900_000;
    this.pollIntervalMs = timeouts.pollIntervalMs ?? 1_000;
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
    const problems = answer.issues.filter((issue) => !isWarning(issue)).map((issue) => issueText(issue));
    const warnings = answer.issues.filter((issue) => isWarning(issue)).map((issue) => issueText(issue));
    return { ok: answer.valid && problems.length === 0, problems, warnings };
  }

  async trial(id: string, inputs: Readonly<Record<string, string>>, instruction?: string): Promise<PlaybookTrial> {
    const args = { id, params: inputs, ...(instruction === undefined ? {} : { instruction }) };
    const answer = await this.call(id, 'playbook_trial', args, TrialSchema, this.trialMs);
    if (answer.kind === 'rejected') return { ok: false, output: `trial rejected: ${answer.reason}` };
    return { ok: answer.status === 'succeeded', output: JSON.stringify(answer.answer) };
  }

  async stopTrials(id: string, notBeforeMs: number, timeoutMs: number): Promise<TrialStopResult> {
    const deadline = performance.now() + timeoutMs;
    let caller: ApbToolCaller;
    let listed: z.infer<typeof TrialRunsSchema>[];
    try {
      caller = await this.caller();
      listed = await caller.callToolParsed('runs_list', {}, z.array(TrialRunsSchema), {
        timeoutMs: Math.min(this.callMs, leftUntil(deadline)),
      });
    } catch (error) {
      return { searched: false, runs: [], detail: `runs_list: ${messageOf(error)}` };
    }
    const mine = listed.filter((run) => run.playbook === id && run.started_ts >= notBeforeMs);
    const runs = await Promise.all(
      mine.map(async (run): Promise<TrialRunStop> => {
        if (TERMINAL_RUN_STATUSES.has(run.status)) return { runId: run.run_id, outcome: 'already_ended' };
        const stop = await stopAndConfirm(caller, run.run_id, deadline, this.pollIntervalMs);
        return { runId: run.run_id, outcome: stop.confirmed ? 'stopped' : 'unconfirmed' };
      }),
    );
    const detail = runs.length === 0 ? 'no trial run found' : runs.map((run) => `${run.runId} ${run.outcome}`).join(', ');
    return { searched: true, runs, detail };
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
