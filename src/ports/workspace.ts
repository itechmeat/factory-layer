/**
 * The Workspace port: the git side of the factory (spec repositories, task
 * trees, integration, advancing main, conflict hand-over, clean copies and
 * delivery). Git is driven with per-command timeouts; the stderr the port
 * reports is redacted by the adapter.
 */

/** What a failed git command left behind; `stderrTail` is redacted. */
export interface WorkspaceErrorInfo {
  readonly command: string;
  readonly exitCode: number | null; // null when the command never ran to an exit
  readonly stderrTail: string; // redacted, truncated tail
}

/** Typed workspace failure; carries what the failed command left behind. */
export class WorkspaceError extends Error {
  readonly info: WorkspaceErrorInfo;

  constructor(info: WorkspaceErrorInfo) {
    super(`${info.command} failed (exit ${info.exitCode ?? 'none'})`);
    this.name = 'WorkspaceError';
    this.info = info;
  }
}

/** One task's working tree: its name, its branch and the commit it started from. */
export interface TaskTree {
  readonly tree: string;
  readonly branch: string;
  readonly baseCommit: string;
}

/**
 * What preparing an integration produced: a merged integration tree with
 * its commit and base, or the conflict, with the conflicting paths.
 */
export type IntegrationPreparation =
  | { readonly ok: true; readonly tree: string; readonly commit: string; readonly base: string }
  | { readonly ok: false; readonly reason: 'conflict'; readonly paths: readonly string[] };

/** What advancing main did; `main_moved` means the fast-forward base is stale. */
export type AdvanceResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'main_moved' };

/**
 * The git operations of the factory. Every method is bounded: the adapter
 * runs each git command under GIT_COMMAND_TIMEOUT_MS (milliseconds) and
 * the caller bounds the operation as a whole; the implementation resolves
 * or rejects within that, never hanging. Failure: rejects with
 * WorkspaceError carrying the command, its exit code and the redacted
 * stderr tail, except where the signature defines a discriminated result
 * for the case (a conflict, a moved main); never a stringly-typed error.
 */
export interface Workspace {
  /**
   * Creates or reuses the spec's repository and returns its root and the
   * main commit. Deadline: bounded by the caller over per-command
   * GIT_COMMAND_TIMEOUT_MS timeouts (milliseconds). Failure: rejects with
   * WorkspaceError; never hangs.
   */
  prepare(specName: string): Promise<{ readonly repoDir: string; readonly commit: string }>;

  /**
   * Creates or returns the task's working tree; idempotent per (taskId,
   * revision): the same call again returns the existing tree. Deadline:
   * bounded by the caller over per-command GIT_COMMAND_TIMEOUT_MS
   * timeouts (milliseconds). Failure: rejects with WorkspaceError; never
   * hangs.
   */
  taskTree(specName: string, taskId: string, revision: number): Promise<TaskTree>;

  /**
   * Commits the task tree's current state. Deadline: bounded by the
   * caller over per-command GIT_COMMAND_TIMEOUT_MS timeouts
   * (milliseconds). Failure: rejects with WorkspaceError; never hangs.
   */
  commitTask(tree: string, message: string): Promise<{ readonly commit: string }>;

  /**
   * Merges the task branch onto the current main in a separate integration
   * tree. Deadline: bounded by the caller over per-command
   * GIT_COMMAND_TIMEOUT_MS timeouts (milliseconds). Failure: resolves
   * with reason 'conflict' and the conflicting paths when the merge
   * conflicts; rejects with WorkspaceError on git failure; never hangs.
   */
  prepareIntegration(specName: string, taskId: string, revision: number): Promise<IntegrationPreparation>;

  /**
   * Advances main to the commit as a fast-forward compare-and-set.
   * Deadline: bounded by the caller over per-command
   * GIT_COMMAND_TIMEOUT_MS timeouts (milliseconds). Failure: resolves
   * with reason 'main_moved' when main no longer points at `base`;
   * rejects with WorkspaceError on git failure; never hangs.
   */
  advanceMain(specName: string, commit: string, base: string): Promise<AdvanceResult>;

  /**
   * Returns the commit main points at. Deadline: bounded by the caller
   * over per-command GIT_COMMAND_TIMEOUT_MS timeouts (milliseconds).
   * Failure: rejects with WorkspaceError; never hangs.
   */
  mainCommit(specName: string): Promise<string>;

  /**
   * Merges main into the task branch inside the task tree and leaves the
   * conflict there for the integrate run to resolve. Deadline: bounded by
   * the caller over per-command GIT_COMMAND_TIMEOUT_MS timeouts
   * (milliseconds). Failure: rejects with WorkspaceError; never hangs.
   */
  handOverConflict(specName: string, taskId: string, revision: number): Promise<{ readonly unresolvedPaths: readonly string[] }>;

  /**
   * Lists the unresolved conflict paths of a tree, empty when it is clean.
   * Deadline: bounded by the caller over per-command
   * GIT_COMMAND_TIMEOUT_MS timeouts (milliseconds). Failure: rejects with
   * WorkspaceError; never hangs.
   */
  unresolvedPaths(tree: string): Promise<readonly string[]>;

  /**
   * Checks out a fresh copy of main with no untracked files. Deadline:
   * bounded by the caller over per-command GIT_COMMAND_TIMEOUT_MS
   * timeouts (milliseconds). Failure: rejects with WorkspaceError; never
   * hangs.
   */
  cleanCopy(specName: string): Promise<{ readonly dir: string }>;

  /**
   * Copies a verified tree to the output directory without .git and
   * node_modules, replacing earlier contents. Deadline: bounded by the
   * caller (milliseconds). Failure: rejects with WorkspaceError; never
   * hangs.
   */
  deliver(copyDir: string, outDir: string): Promise<{ readonly files: number }>;
}
