/**
 * An in-memory `PlaybookAuthoring` for tests: drafts stored under the `id`
 * their YAML declares (sequential `pb-<n>` ids when it declares none), seeded
 * playbooks, validate, trial and approve ok by default with per-id scripted
 * outcomes (a trial may be scripted as any promise: one that rejects or
 * never settles), scripted create refusals and trial stops, unknown ids
 * rejecting with a plain Error as the port defines, and every call recorded
 * in order, so tests can drive the authoring paths without a store.
 */

import type { Playbook, PlaybookDraft, PlaybookRef } from '../../domain';
import type { PlaybookAuthoring, PlaybookTrial, PlaybookValidation, TrialStopResult } from '../../ports';

/** One call the fake saw, in call order; the other fields depend on the method. */
export type FakePlaybookCall =
  | { readonly method: 'list' }
  | { readonly method: 'get'; readonly id: string }
  | { readonly method: 'create'; readonly draft: PlaybookDraft }
  | { readonly method: 'validate'; readonly id: string }
  | {
      readonly method: 'trial';
      readonly id: string;
      readonly inputs: Readonly<Record<string, string>>;
      readonly instruction: string | undefined;
    }
  | { readonly method: 'stopTrials'; readonly id: string; readonly notBeforeMs: number; readonly timeoutMs: number }
  | { readonly method: 'approve'; readonly id: string };

/** The output of an unscripted trial. */
const DEFAULT_TRIAL_OUTPUT = 'fake trial output';

/** The `id` a YAML draft declares, when it parses and declares one. */
function declaredId(content: string): string | undefined {
  try {
    const parsed: unknown = Bun.YAML.parse(content);
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed && typeof parsed.id === 'string') return parsed.id;
  } catch {
    // Not YAML: the fake assigns a sequential id.
  }
  return undefined;
}

export class FakePlaybookAuthoring implements PlaybookAuthoring {
  private readonly stored: Playbook[] = [];
  private readonly callLog: FakePlaybookCall[] = [];
  private readonly validations = new Map<string, PlaybookValidation>();
  private readonly trials = new Map<string, () => Promise<PlaybookTrial>>();
  private readonly approvals = new Map<string, { readonly approved: boolean }>();
  private readonly refusals = new Map<string, string>();
  private stopResult: TrialStopResult = { searched: true, runs: [], detail: 'no trial runs' };
  private counter = 0;

  /** Every call the fake saw, in call order. */
  get calls(): readonly FakePlaybookCall[] {
    return this.callLog;
  }

  /** Stores a playbook as if it existed before the test. */
  seed(playbook: Playbook): void {
    this.stored.push(playbook);
  }

  /** Replaces the stored content of an id: the store returns something else than was created. */
  replaceContent(id: string, content: string): void {
    const index = this.stored.findIndex((playbook) => playbook.id === id);
    this.stored[index] = { ...this.require(id), content };
  }

  /** Makes `create` of a draft declaring `id` reject with `detail`. */
  refuseCreate(id: string, detail: string): void {
    this.refusals.set(id, detail);
  }

  /** Scripts the validation outcome of one stored id; unscripted ids validate ok. */
  setValidation(id: string, validation: PlaybookValidation): void {
    this.validations.set(id, validation);
  }

  /** Scripts the trial outcome of one stored id; unscripted ids trial ok. */
  setTrial(id: string, trial: PlaybookTrial | (() => Promise<PlaybookTrial>)): void {
    this.trials.set(id, typeof trial === 'function' ? trial : async () => trial);
  }

  /** Scripts what `stopTrials` reports. */
  setStopResult(result: TrialStopResult): void {
    this.stopResult = result;
  }

  /** Scripts the approval outcome of one stored id; unscripted ids approve. */
  setApproval(id: string, approved: { readonly approved: boolean }): void {
    this.approvals.set(id, approved);
  }

  async list(): Promise<readonly PlaybookRef[]> {
    this.callLog.push({ method: 'list' });
    return this.stored.map((playbook) => ({ id: playbook.id, name: playbook.name }));
  }

  async get(id: string): Promise<Playbook> {
    this.callLog.push({ method: 'get', id });
    return this.require(id);
  }

  async create(draft: PlaybookDraft): Promise<PlaybookRef> {
    this.callLog.push({ method: 'create', draft });
    this.counter += 1;
    const id = declaredId(draft.content) ?? `pb-${String(this.counter)}`;
    const refusal = this.refusals.get(id);
    if (refusal !== undefined) throw new Error(`playbook ${id}: ${refusal}`);
    const playbook: Playbook = { id, name: draft.name, content: draft.content };
    this.stored.push(playbook);
    return { id: playbook.id, name: playbook.name };
  }

  async validate(id: string): Promise<PlaybookValidation> {
    this.callLog.push({ method: 'validate', id });
    const playbook = this.require(id);
    return this.validations.get(playbook.id) ?? { ok: true, problems: [], warnings: [] };
  }

  async trial(id: string, inputs: Readonly<Record<string, string>>, instruction?: string): Promise<PlaybookTrial> {
    this.callLog.push({ method: 'trial', id, inputs, instruction });
    const playbook = this.require(id);
    const scripted = this.trials.get(playbook.id);
    return scripted === undefined ? { ok: true, output: DEFAULT_TRIAL_OUTPUT } : scripted();
  }

  async stopTrials(id: string, notBeforeMs: number, timeoutMs: number): Promise<TrialStopResult> {
    this.callLog.push({ method: 'stopTrials', id, notBeforeMs, timeoutMs });
    return this.stopResult;
  }

  async approve(id: string): Promise<{ readonly approved: boolean }> {
    this.callLog.push({ method: 'approve', id });
    const playbook = this.require(id);
    return this.approvals.get(playbook.id) ?? { approved: true };
  }

  /** The stored playbook of an id, or a plain Error naming the id, as the port defines. */
  private require(id: string): Playbook {
    const playbook = this.stored.find((candidate) => candidate.id === id);
    if (playbook === undefined) {
      throw new Error(`playbook ${id} does not exist`);
    }
    return playbook;
  }
}
