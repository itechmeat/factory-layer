/**
 * An in-memory `PlaybookAuthoring` for tests: drafts stored under sequential
 * `pb-<n>` ids, validate, trial and approve ok by default with per-id
 * scripted outcomes, unknown ids rejecting with a plain Error as the port
 * defines, and every call recorded in order, so tests can drive the
 * authoring paths without a store.
 */

import type { Playbook, PlaybookDraft, PlaybookRef } from '../../domain';
import type { PlaybookAuthoring, PlaybookTrial, PlaybookValidation } from '../../ports';

/** One call the fake saw, in call order; the other fields depend on the method. */
export type FakePlaybookCall =
  | { readonly method: 'list' }
  | { readonly method: 'get'; readonly id: string }
  | { readonly method: 'create'; readonly draft: PlaybookDraft }
  | { readonly method: 'validate'; readonly id: string }
  | { readonly method: 'trial'; readonly id: string; readonly inputs: Readonly<Record<string, string>> }
  | { readonly method: 'approve'; readonly id: string };

/** The output of an unscripted trial. */
const DEFAULT_TRIAL_OUTPUT = 'fake trial output';

export class FakePlaybookAuthoring implements PlaybookAuthoring {
  private readonly stored: Playbook[] = [];
  private readonly callLog: FakePlaybookCall[] = [];
  private readonly validations = new Map<string, PlaybookValidation>();
  private readonly trials = new Map<string, PlaybookTrial>();
  private readonly approvals = new Map<string, { readonly approved: boolean }>();
  private counter = 0;

  /** Every call the fake saw, in call order. */
  get calls(): readonly FakePlaybookCall[] {
    return this.callLog;
  }

  /** Scripts the validation outcome of one stored id; unscripted ids validate ok. */
  setValidation(id: string, validation: PlaybookValidation): void {
    this.validations.set(id, validation);
  }

  /** Scripts the trial outcome of one stored id; unscripted ids trial ok. */
  setTrial(id: string, trial: PlaybookTrial): void {
    this.trials.set(id, trial);
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
    const playbook: Playbook = { id: `pb-${this.counter}`, name: draft.name, content: draft.content };
    this.stored.push(playbook);
    return { id: playbook.id, name: playbook.name };
  }

  async validate(id: string): Promise<PlaybookValidation> {
    this.callLog.push({ method: 'validate', id });
    const playbook = this.require(id);
    return this.validations.get(playbook.id) ?? { ok: true, problems: [] };
  }

  async trial(id: string, inputs: Readonly<Record<string, string>>): Promise<PlaybookTrial> {
    this.callLog.push({ method: 'trial', id, inputs });
    const playbook = this.require(id);
    return this.trials.get(playbook.id) ?? { ok: true, output: DEFAULT_TRIAL_OUTPUT };
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
