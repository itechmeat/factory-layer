/**
 * The git workspace adapter: one repository per spec under
 * `<workRoot>/work/<spec>`, one worktree per task and revision, integration
 * on a detached worktree merged with `--no-ff`, main moved only by an
 * update-ref compare-and-set, a conflict handed over inside the task tree,
 * a clean delivery copy per request and a delivery without `.git` and
 * `node_modules`. Every git command is bounded by the constructor timeout
 * and killed past it; every error text the adapter reports is redacted of
 * the secrets set with `setSecrets`. Every prepare sets the factory's git
 * identity and adds `.factory/` and `node_modules/` to the shared
 * `info/exclude`, so the executor's scratch files and installed packages are
 * never committed by any task tree. A delivery writes the marker file
 * `.factory-delivery`; only a missing or empty directory, or one holding
 * that marker, is ever replaced, so `--out` never wipes a user's project.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { redactString } from '../../domain/redact';
import { WorkspaceError, type AdvanceResult, type IntegrationPreparation, type TaskTree, type Workspace } from '../../ports';
import { commandText, runGit, stderrTail, type GitOutcome } from './run-git';

/** Author of every commit the factory creates. */
const FACTORY_GIT_USER = 'factory-layer';
const FACTORY_GIT_EMAIL = 'factory-layer@localhost';

/** Directory names a delivery never copies. */
const EXCLUDED_FROM_DELIVERY = new Set(['.git', 'node_modules']);

/** The file a delivery leaves in its directory: the proof that the factory may replace it. */
export const DELIVERY_MARKER = '.factory-delivery';

/** Lines the shared `info/exclude` must hold: executor scratch and installed packages. */
const EXCLUDED_FROM_COMMITS = ['.factory/', 'node_modules/'];

/**
 * Why `outDir` must not be replaced by a delivery, or `undefined` when it
 * may be: it is missing, an empty directory, or a directory holding the
 * delivery marker.
 */
export function deliveryTargetProblem(outDir: string): string | undefined {
  if (!existsSync(outDir)) return undefined;
  if (!statSync(outDir).isDirectory()) return `${outDir} exists and is not a directory`;
  const entries = readdirSync(outDir);
  if (entries.length === 0 || entries.includes(DELIVERY_MARKER)) return undefined;
  return `${outDir} is not empty and was not created by the factory (no ${DELIVERY_MARKER}); choose another --out`;
}

/** The typed failure of one git command: redacted command text and redacted stderr tail. */
export function gitFailure(command: string, exitCode: number | null, stderr: string, secrets: readonly string[]): WorkspaceError {
  return new WorkspaceError({ command: redactString(command, secrets), exitCode, stderrTail: stderrTail(stderr, secrets) });
}

/** Copies a directory tree file by file, skipping the excluded names at every depth; returns the file count. */
function copyTree(source: string, target: string): number {
  let files = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (EXCLUDED_FROM_DELIVERY.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      files += copyTree(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
      files += 1;
    }
  }
  return files;
}

/** The next free `copy-<n>` number after the delivery copies on disk. */
function nextCopyNumber(names: readonly string[]): number {
  const taken = names
    .map((name) => /^copy-(\d+)$/.exec(name)?.[1])
    .filter((digits: string | undefined): digits is string => digits !== undefined)
    .map(Number);
  return taken.reduce((max, n) => Math.max(max, n), -1) + 1;
}

/** The `Workspace` port over the real `git` binary. */
export class GitWorkspace implements Workspace {
  private readonly workRoot: string;
  private readonly timeoutMs: number;
  private secrets: readonly string[];

  constructor(info: { workRoot: string; timeoutMs: number }) {
    this.workRoot = info.workRoot;
    this.timeoutMs = info.timeoutMs;
    this.secrets = [];
  }

  /** Adds secrets redacted from every error the adapter reports after the call. */
  setSecrets(secrets: readonly string[]): void {
    this.secrets = [...secrets];
  }

  async prepare(specName: string): Promise<{ readonly repoDir: string; readonly commit: string }> {
    const repoDir = this.repoDir(specName);
    mkdirSync(repoDir, { recursive: true });
    if (!existsSync(join(repoDir, '.git'))) await this.must(repoDir, ['init', '-b', 'main']);
    // Both are idempotent and run on every prepare, so a repository from an earlier run or another tool gets them too.
    await this.must(repoDir, ['config', 'user.name', FACTORY_GIT_USER]);
    await this.must(repoDir, ['config', 'user.email', FACTORY_GIT_EMAIL]);
    await this.must(repoDir, ['config', 'commit.gpgsign', 'false']);
    this.excludeScratch(repoDir);
    const head = await this.git(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']);
    if (head.exitCode !== 0) await this.must(repoDir, ['commit', '--allow-empty', '-m', 'initial commit']);
    return { repoDir, commit: await this.mainCommit(specName) };
  }

  async taskTree(specName: string, taskId: string, revision: number): Promise<TaskTree> {
    const repoDir = this.repoDir(specName);
    const branch = `task/${taskId}-r${revision}`;
    const tree = this.treeDir(repoDir, `${taskId}-r${revision}`);
    if (existsSync(tree)) {
      return { tree, branch, baseCommit: await this.must(repoDir, ['merge-base', `refs/heads/${branch}`, 'refs/heads/main']) };
    }
    const existing = await this.git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (existing.exitCode === 0) {
      // The branch outlived its tree (a crash inside `worktree add`, or a pruned tree): forget the stale entry and re-attach.
      await this.must(repoDir, ['worktree', 'prune']);
      await this.must(repoDir, ['worktree', 'add', tree, branch]);
      return { tree, branch, baseCommit: await this.must(repoDir, ['merge-base', `refs/heads/${branch}`, 'refs/heads/main']) };
    }
    const baseCommit = await this.mainCommit(specName);
    await this.must(repoDir, ['worktree', 'add', '-b', branch, tree, baseCommit]);
    return { tree, branch, baseCommit };
  }

  async commitTask(tree: string, message: string): Promise<{ readonly commit: string }> {
    await this.must(tree, ['add', '-A']);
    await this.must(tree, ['commit', '--allow-empty', '-m', message]);
    return { commit: await this.must(tree, ['rev-parse', 'HEAD']) };
  }

  async prepareIntegration(specName: string, taskId: string, revision: number): Promise<IntegrationPreparation> {
    const repoDir = this.repoDir(specName);
    const branch = `task/${taskId}-r${revision}`;
    const tree = this.treeDir(repoDir, `integrate-${taskId}-r${revision}`);
    const base = await this.mainCommit(specName);
    // A crashed run may have left the tree behind; a fresh preparation must not block on it.
    rmSync(tree, { recursive: true, force: true });
    await this.must(repoDir, ['worktree', 'prune']);
    await this.must(repoDir, ['worktree', 'add', '--detach', tree, base]);
    const mergeArgs = ['merge', '--no-ff', '--no-edit', branch];
    const merge = await this.git(tree, mergeArgs);
    if (merge.exitCode !== 0) {
      const paths = await this.unmergedPathsOf(tree);
      await this.git(tree, ['merge', '--abort']);
      await this.must(repoDir, ['worktree', 'remove', '--force', tree]);
      if (merge.exitCode !== 1 || paths.length === 0) {
        throw gitFailure(commandText(mergeArgs), merge.exitCode, merge.stderr, this.secrets);
      }
      return { ok: false, reason: 'conflict', paths };
    }
    return { ok: true, tree, commit: await this.must(tree, ['rev-parse', 'HEAD']), base };
  }

  async advanceMain(specName: string, commit: string, base: string): Promise<AdvanceResult> {
    const repoDir = this.repoDir(specName);
    const args = ['update-ref', 'refs/heads/main', commit, base];
    const outcome = await this.git(repoDir, args);
    if (outcome.exitCode === 0) return { ok: true };
    // The compare-and-set failed: main_moved only when main really no longer points at base.
    const now = await this.git(repoDir, ['rev-parse', 'refs/heads/main']);
    if (now.exitCode === 0 && now.stdout.trim() !== base) return { ok: false, reason: 'main_moved' };
    throw gitFailure(commandText(args), outcome.exitCode, outcome.stderr, this.secrets);
  }

  async mainCommit(specName: string): Promise<string> {
    return this.must(this.repoDir(specName), ['rev-parse', 'refs/heads/main']);
  }

  async handOverConflict(specName: string, taskId: string, revision: number): Promise<{ readonly unresolvedPaths: readonly string[] }> {
    const tree = this.treeDir(this.repoDir(specName), `${taskId}-r${revision}`);
    const mergeArgs = ['merge', '--no-edit', 'main'];
    const merge = await this.git(tree, mergeArgs);
    const paths = await this.unmergedPathsOf(tree);
    // The conflict stays in the task tree; only a merge with nothing to resolve is a protocol error.
    if (paths.length === 0) {
      const detail = `${merge.stderr}\nprotocol: merging main into the task tree left no unresolved paths`;
      throw gitFailure(commandText(mergeArgs), merge.exitCode, detail, this.secrets);
    }
    return { unresolvedPaths: paths };
  }

  async unresolvedPaths(tree: string): Promise<readonly string[]> {
    const args = ['diff', '--name-only', '--diff-filter=U'];
    const outcome = await this.git(tree, args);
    if (outcome.exitCode !== 0) throw gitFailure(commandText(args), outcome.exitCode, outcome.stderr, this.secrets);
    return outcome.stdout.split('\n').filter((line) => line.length > 0);
  }

  async cleanCopy(specName: string): Promise<{ readonly dir: string }> {
    const repoDir = this.repoDir(specName);
    const delivery = join(repoDir, '.delivery');
    mkdirSync(delivery, { recursive: true });
    const dir = join(delivery, `copy-${nextCopyNumber(readdirSync(delivery))}`);
    const base = await this.mainCommit(specName);
    await this.must(repoDir, ['worktree', 'add', '--detach', dir, base]);
    return { dir };
  }

  async deliver(copyDir: string, outDir: string): Promise<{ readonly files: number }> {
    const problem = deliveryTargetProblem(outDir);
    if (problem !== undefined) throw gitFailure(`deliver ${copyDir} to ${outDir}`, null, `refused: ${problem}`, this.secrets);
    try {
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      const files = copyTree(copyDir, outDir);
      writeFileSync(join(outDir, DELIVERY_MARKER), 'Delivered by factory-layer; the factory may replace this directory.\n');
      return { files };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw gitFailure(`deliver ${copyDir} to ${outDir}`, null, detail, this.secrets);
    }
  }

  /** The repository directory of one spec. */
  private repoDir(specName: string): string {
    return join(this.workRoot, 'work', specName);
  }

  /** A worktree directory of the spec repository. */
  private treeDir(repoDir: string, name: string): string {
    return join(repoDir, '.trees', name);
  }

  /** Adds `.factory/` and `node_modules/` to the repository's shared info/exclude, each once. */
  private excludeScratch(repoDir: string): void {
    const exclude = join(repoDir, '.git', 'info', 'exclude');
    mkdirSync(dirname(exclude), { recursive: true });
    const current = new Set(
      readTextOrEmpty(exclude)
        .split('\n')
        .map((line) => line.trim()),
    );
    const missing = EXCLUDED_FROM_COMMITS.filter((line) => !current.has(line));
    if (missing.length > 0) appendFileSync(exclude, missing.map((line) => `${line}\n`).join(''));
  }

  /** One git command of this workspace. */
  private async git(cwd: string, args: readonly string[]): Promise<GitOutcome> {
    return runGit({ cwd, args, timeoutMs: this.timeoutMs, secrets: this.secrets });
  }

  /** Runs a command that must exit zero; any other exit is a typed failure. Returns the trimmed stdout. */
  private async must(cwd: string, args: readonly string[]): Promise<string> {
    const outcome = await this.git(cwd, args);
    if (outcome.exitCode !== 0) throw gitFailure(commandText(args), outcome.exitCode, outcome.stderr, this.secrets);
    return outcome.stdout.trim();
  }

  /** The unresolved conflict paths of a tree; empty when the read itself fails (the caller decides). */
  private async unmergedPathsOf(tree: string): Promise<readonly string[]> {
    const outcome = await this.git(tree, ['diff', '--name-only', '--diff-filter=U']);
    if (outcome.exitCode !== 0) return [];
    return outcome.stdout.split('\n').filter((line) => line.length > 0);
  }
}

/** The file's text, or empty when it does not exist (read once, no exists-then-read race). */
function readTextOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }
}
