/**
 * An in-memory `Workspace` for tests, keyed by spec name: idempotent task
 * trees, scriptable integration preparations (clean or conflicting) per
 * task and revision, a compare-and-swap `advanceMain`, and records of every
 * commit, hand-over and delivery. No git, no disk.
 */

import type { AdvanceResult, IntegrationPreparation, TaskTree, Workspace } from '../../ports';

/** The paths a hand-over leaves unresolved when nothing was scripted. */
const DEFAULT_CONFLICT_PATHS: readonly string[] = ['src/conflict.txt'];
/** The file count every delivery reports. */
const DELIVERY_FILES = 3;

/** How prepareIntegration answers for one (task, revision). */
export type FakeIntegrationScript =
  | { readonly outcome: 'ok'; readonly commit?: string; readonly base?: string }
  | { readonly outcome: 'conflict'; readonly paths: readonly string[] };

/** One task branch commit the fake recorded. */
export interface FakeCommitRecord {
  readonly tree: string;
  readonly message: string;
  readonly commit: string;
}

/** One conflict hand-over the fake recorded. */
export interface FakeHandoverRecord {
  readonly specName: string;
  readonly taskId: string;
  readonly revision: number;
  readonly unresolvedPaths: readonly string[];
}

/** One delivery the fake recorded. */
export interface FakeDeliveryRecord {
  readonly copyDir: string;
  readonly outDir: string;
  readonly files: number;
}

interface SpecState {
  readonly repoDir: string;
  mainCommit: string;
  readonly trees: Map<string, TaskTree>;
}

export class FakeWorkspace implements Workspace {
  private readonly specStates = new Map<string, SpecState>();
  private readonly integrationScripts = new Map<string, FakeIntegrationScript[]>();
  private readonly lastConflicts = new Map<string, readonly string[]>();
  private readonly unresolvedByTree = new Map<string, readonly string[]>();
  private readonly commitLog: FakeCommitRecord[] = [];
  private readonly handoverLog: FakeHandoverRecord[] = [];
  private readonly deliveryLog: FakeDeliveryRecord[] = [];
  private mainCounter = 0;
  private commitCounter = 0;
  private integrateCounter = 0;
  private copyCounter = 0;

  /** Every task branch commit, in commit order. */
  get commits(): readonly FakeCommitRecord[] {
    return this.commitLog;
  }

  /** Every conflict hand-over, in order. */
  get handovers(): readonly FakeHandoverRecord[] {
    return this.handoverLog;
  }

  /** Every delivery, in order. */
  get deliveries(): readonly FakeDeliveryRecord[] {
    return this.deliveryLog;
  }

  /** Scripts how prepareIntegration answers for the (task, revision), every time. */
  setIntegration(specName: string, taskId: string, revision: number, script: FakeIntegrationScript): void {
    this.integrationScripts.set(this.integrationKey(specName, taskId, revision), [script]);
  }

  /** Appends one answer for the (task, revision); answers are served in order and the last one repeats. */
  queueIntegration(specName: string, taskId: string, revision: number, script: FakeIntegrationScript): void {
    const key = this.integrationKey(specName, taskId, revision);
    const existing = this.integrationScripts.get(key);
    if (existing === undefined) {
      this.integrationScripts.set(key, [script]);
    } else {
      existing.push(script);
    }
  }

  /** Clears the unresolved paths of a tree, as an integrate run that resolved the conflict would. */
  markResolved(tree: string): void {
    this.unresolvedByTree.delete(tree);
  }

  async prepare(specName: string): Promise<{ readonly repoDir: string; readonly commit: string }> {
    const state = this.mustSpec(specName);
    return { repoDir: state.repoDir, commit: state.mainCommit };
  }

  async taskTree(specName: string, taskId: string, revision: number): Promise<TaskTree> {
    const state = this.mustSpec(specName);
    const key = this.integrationKey(specName, taskId, revision);
    const existing = state.trees.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const tree: TaskTree = {
      tree: `tree-${taskId}-r${revision}`,
      branch: `task/${taskId}-r${revision}`,
      baseCommit: state.mainCommit,
    };
    state.trees.set(key, tree);
    return tree;
  }

  async commitTask(tree: string, message: string): Promise<{ readonly commit: string }> {
    this.commitCounter += 1;
    const commit = `commit-${this.commitCounter}`;
    this.commitLog.push({ tree, message, commit });
    return { commit };
  }

  async prepareIntegration(specName: string, taskId: string, revision: number): Promise<IntegrationPreparation> {
    const state = this.mustSpec(specName);
    const key = this.integrationKey(specName, taskId, revision);
    const scripts = this.integrationScripts.get(key) ?? [];
    const script = scripts.length > 1 ? scripts.shift() : scripts[0];
    if (script?.outcome === 'conflict') {
      this.lastConflicts.set(key, script.paths);
      return { ok: false, reason: 'conflict', paths: script.paths };
    }
    const tree = await this.taskTree(specName, taskId, revision);
    this.integrateCounter += 1;
    return {
      ok: true,
      tree: tree.tree,
      commit: script?.outcome === 'ok' && script.commit !== undefined ? script.commit : `integrate-${this.integrateCounter}`,
      base: script?.outcome === 'ok' && script.base !== undefined ? script.base : state.mainCommit,
    };
  }

  async advanceMain(specName: string, commit: string, base: string): Promise<AdvanceResult> {
    const state = this.mustSpec(specName);
    if (state.mainCommit !== base) {
      return { ok: false, reason: 'main_moved' };
    }
    state.mainCommit = commit;
    return { ok: true };
  }

  async mainCommit(specName: string): Promise<string> {
    return this.mustSpec(specName).mainCommit;
  }

  async handOverConflict(specName: string, taskId: string, revision: number): Promise<{ readonly unresolvedPaths: readonly string[] }> {
    const key = this.integrationKey(specName, taskId, revision);
    const scripted = this.integrationScripts.get(key)?.[0];
    const unresolvedPaths = this.lastConflicts.get(key) ?? (scripted?.outcome === 'conflict' ? scripted.paths : DEFAULT_CONFLICT_PATHS);
    this.unresolvedByTree.set(`tree-${taskId}-r${revision}`, unresolvedPaths);
    this.handoverLog.push({ specName, taskId, revision, unresolvedPaths });
    return { unresolvedPaths };
  }

  async unresolvedPaths(tree: string): Promise<readonly string[]> {
    return this.unresolvedByTree.get(tree) ?? [];
  }

  async cleanCopy(_specName: string): Promise<{ readonly dir: string }> {
    this.copyCounter += 1;
    return { dir: `copy-${this.copyCounter}` };
  }

  async deliver(copyDir: string, outDir: string): Promise<{ readonly files: number }> {
    this.deliveryLog.push({ copyDir, outDir, files: DELIVERY_FILES });
    return { files: DELIVERY_FILES };
  }

  private integrationKey(specName: string, taskId: string, revision: number): string {
    return `${specName}|${taskId}|r${revision}`;
  }

  private mustSpec(specName: string): SpecState {
    const existing = this.specStates.get(specName);
    if (existing !== undefined) {
      return existing;
    }
    this.mainCounter += 1;
    const fresh: SpecState = { repoDir: `repo-${specName}`, mainCommit: `main-${this.mainCounter}`, trees: new Map() };
    this.specStates.set(specName, fresh);
    return fresh;
  }
}
