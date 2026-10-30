import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceError } from '../../ports';
import { DELIVERY_MARKER, deliveryTargetProblem, GitWorkspace, gitFailure } from './git-workspace';
import { runGit } from './run-git';

const TIMEOUT_MS = 10_000;
const SPEC = 'todo-cli';

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'factory-git-'));
  roots.push(root);
  return root;
}

function workspace(root: string): GitWorkspace {
  return new GitWorkspace({ workRoot: root, timeoutMs: TIMEOUT_MS });
}

async function run(cwd: string, args: readonly string[]): Promise<string> {
  return (await runGit({ cwd, args, timeoutMs: TIMEOUT_MS, secrets: [] })).stdout;
}

async function head(cwd: string): Promise<string> {
  return (await run(cwd, ['rev-parse', 'HEAD'])).trim();
}

async function ref(cwd: string, name: string): Promise<string> {
  return (await run(cwd, ['rev-parse', name])).trim();
}

async function branchOf(cwd: string): Promise<string> {
  return (await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

async function commitCount(cwd: string): Promise<number> {
  return Number((await run(cwd, ['rev-list', '--count', 'HEAD'])).trim());
}

async function worktrees(cwd: string): Promise<string[]> {
  return (await run(cwd, ['worktree', 'list'])).split('\n').filter((line) => line.length > 0);
}

async function catchWorkspaceError(run_: () => Promise<unknown>): Promise<WorkspaceError> {
  const caught: unknown = await run_().then(
    () => null,
    (error: unknown) => error,
  );
  if (!(caught instanceof WorkspaceError)) throw new Error(`expected a WorkspaceError, got ${String(caught)}`);
  return caught;
}

/** A prepared repo with one task branch that conflicts with an already advanced main. */
async function conflictFixture(root: string): Promise<{ ws: GitWorkspace; repoDir: string; tree: string; betaCommit: string }> {
  const ws = workspace(root);
  const { repoDir } = await ws.prepare(SPEC);
  const alpha = await ws.taskTree(SPEC, 'alpha', 1);
  const beta = await ws.taskTree(SPEC, 'beta', 1);
  writeFileSync(join(alpha.tree, 'shared.txt'), 'from-alpha\n');
  writeFileSync(join(beta.tree, 'shared.txt'), 'from-beta\n');
  await ws.commitTask(alpha.tree, 'alpha change');
  const betaCommit = (await ws.commitTask(beta.tree, 'beta change')).commit;
  const clean = await ws.prepareIntegration(SPEC, 'alpha', 1);
  if (!clean.ok) throw new Error(`expected a clean first integration, got ${clean.paths.join(', ')}`);
  const advanced = await ws.advanceMain(SPEC, clean.commit, clean.base);
  if (!advanced.ok) throw new Error('expected the first advance to succeed');
  return { ws, repoDir, tree: beta.tree, betaCommit };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('prepare', () => {
  test('a fresh spec repository is on main with one initial commit', async () => {
    const ws = workspace(newRoot());
    const { repoDir, commit } = await ws.prepare(SPEC);
    expect(existsSync(join(repoDir, '.git'))).toBe(true);
    expect(await branchOf(repoDir)).toBe('main');
    expect(await commitCount(repoDir)).toBe(1);
    expect(commit).toBe(await head(repoDir));
  });

  test('prepare is idempotent and keeps the initial commit', async () => {
    const ws = workspace(newRoot());
    const first = await ws.prepare(SPEC);
    const second = await ws.prepare(SPEC);
    expect(second.repoDir).toBe(first.repoDir);
    expect(second.commit).toBe(first.commit);
    expect(await commitCount(first.repoDir)).toBe(1);
  });

  test('the executor scratch directory is never committed', async () => {
    const ws = workspace(newRoot());
    await ws.prepare(SPEC);
    const tree = await ws.taskTree(SPEC, 'scratch', 1);
    mkdirSync(join(tree.tree, '.factory'), { recursive: true });
    writeFileSync(join(tree.tree, '.factory', 'notes.txt'), 'scratch\n');
    writeFileSync(join(tree.tree, 'task.ts'), 'export {};\n');
    const { commit } = await ws.commitTask(tree.tree, 'task work');
    const shown = await run(tree.tree, ['show', '--name-only', '--format=', commit]);
    expect(shown).toContain('task.ts');
    expect(shown).not.toContain('.factory/');
  });

  test('every prepare restores the factory git config and the scratch exclude of an existing repository', async () => {
    const root = newRoot();
    const repoDir = join(root, 'work', SPEC);
    mkdirSync(repoDir, { recursive: true });
    await run(repoDir, ['init', '-b', 'main']);
    rmSync(join(repoDir, '.git', 'info'), { recursive: true, force: true });

    await workspace(root).prepare(SPEC);

    expect((await run(repoDir, ['config', '--local', 'user.name'])).trim()).toBe('factory-layer');
    expect((await run(repoDir, ['config', '--local', 'user.email'])).trim()).toBe('factory-layer@localhost');
    expect((await run(repoDir, ['config', '--local', 'commit.gpgsign'])).trim()).toBe('false');
    expect(readFileSync(join(repoDir, '.git', 'info', 'exclude'), 'utf8')).toContain('.factory/');
  });
});

describe('taskTree', () => {
  test('creates a worktree on a branch from the current main', async () => {
    const ws = workspace(newRoot());
    const { repoDir, commit } = await ws.prepare(SPEC);
    const tree = await ws.taskTree(SPEC, 'api', 1);
    expect(tree.tree).toBe(join(repoDir, '.trees', 'api-r1'));
    expect(tree.branch).toBe('task/api-r1');
    expect(tree.baseCommit).toBe(commit);
    expect(existsSync(tree.tree)).toBe(true);
    expect(await branchOf(tree.tree)).toBe('task/api-r1');
  });

  test('re-adds the tree when its branch exists but the directory is gone', async () => {
    const ws = workspace(newRoot());
    await ws.prepare(SPEC);
    const first = await ws.taskTree(SPEC, 'api', 1);
    writeFileSync(join(first.tree, 'kept.ts'), 'kept\n');
    await ws.commitTask(first.tree, 'kept');
    rmSync(first.tree, { recursive: true, force: true });
    const again = await ws.taskTree(SPEC, 'api', 1);
    expect(again.tree).toBe(first.tree);
    expect(again.baseCommit).toBe(first.baseCommit);
    expect(readFileSync(join(again.tree, 'kept.ts'), 'utf8')).toBe('kept\n');
  });

  test('returns the existing tree when asked twice, with one worktree', async () => {
    const ws = workspace(newRoot());
    const { repoDir } = await ws.prepare(SPEC);
    const first = await ws.taskTree(SPEC, 'api', 1);
    const second = await ws.taskTree(SPEC, 'api', 1);
    expect(second).toEqual(first);
    const listed = await worktrees(repoDir);
    expect(listed.filter((line) => line.includes('.trees/api-r1'))).toHaveLength(1);
  });
});

describe('commitTask', () => {
  test('commits all changes and returns the new head', async () => {
    const ws = workspace(newRoot());
    await ws.prepare(SPEC);
    const tree = await ws.taskTree(SPEC, 'api', 1);
    writeFileSync(join(tree.tree, 'src.ts'), 'export const one = 1;\n');
    const { commit } = await ws.commitTask(tree.tree, 'add src');
    expect(commit).not.toBe(tree.baseCommit);
    expect(commit).toBe(await head(tree.tree));
    const shown = await run(tree.tree, ['show', '--name-only', '--format=', commit]);
    expect(shown).toContain('src.ts');
  });

  test('never commits node_modules', async () => {
    const ws = workspace(newRoot());
    await ws.prepare(SPEC);
    const tree = await ws.taskTree(SPEC, 'api', 1);
    mkdirSync(join(tree.tree, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(tree.tree, 'node_modules', 'pkg', 'index.js'), 'junk\n');
    writeFileSync(join(tree.tree, 'src.ts'), 'x\n');
    const { commit } = await ws.commitTask(tree.tree, 'with deps');
    const shown = await run(tree.tree, ['show', '--name-only', '--format=', commit]);
    expect(shown).toContain('src.ts');
    expect(shown).not.toContain('node_modules');
  });

  test('creates a new commit when nothing changed', async () => {
    const ws = workspace(newRoot());
    await ws.prepare(SPEC);
    const tree = await ws.taskTree(SPEC, 'api', 1);
    const first = await ws.commitTask(tree.tree, 'first');
    const second = await ws.commitTask(tree.tree, 'no change');
    expect(second.commit).not.toBe(first.commit);
    expect(second.commit).toBe(await head(tree.tree));
  });
});

describe('prepareIntegration', () => {
  test('merges the task branch with a merge commit and leaves main alone', async () => {
    const ws = workspace(newRoot());
    const { repoDir, commit } = await ws.prepare(SPEC);
    const tree = await ws.taskTree(SPEC, 'api', 1);
    writeFileSync(join(tree.tree, 'api.ts'), 'export {};\n');
    await ws.commitTask(tree.tree, 'api work');
    const prep = await ws.prepareIntegration(SPEC, 'api', 1);
    expect(prep.ok).toBe(true);
    if (!prep.ok) throw new Error(`expected a clean integration, got ${prep.paths.join(', ')}`);
    expect(prep.base).toBe(commit);
    expect(prep.commit).toBe(await head(prep.tree));
    expect(await ref(repoDir, 'refs/heads/main')).toBe(commit);
    const parents = (await run(prep.tree, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ');
    expect(parents).toHaveLength(3);
  });

  test('reports a conflict with its paths, leaves main and the task branch alone and removes the tree', async () => {
    const { ws, repoDir, betaCommit } = await conflictFixture(newRoot());
    const mainBefore = await ref(repoDir, 'refs/heads/main');
    const conflict = await ws.prepareIntegration(SPEC, 'beta', 1);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error('expected a conflict');
    expect(conflict.paths).toContain('shared.txt');
    expect(await ref(repoDir, 'refs/heads/main')).toBe(mainBefore);
    expect(await ref(repoDir, 'refs/heads/task/beta-r1')).toBe(betaCommit);
    expect(existsSync(join(repoDir, '.trees', 'integrate-beta-r1'))).toBe(false);
    const listed = await worktrees(repoDir);
    expect(listed.some((line) => line.includes('integrate-beta-r1'))).toBe(false);
  });
});

describe('advanceMain', () => {
  test('advances main to the integration commit from its base', async () => {
    const ws = workspace(newRoot());
    const { repoDir } = await ws.prepare(SPEC);
    const tree = await ws.taskTree(SPEC, 'api', 1);
    writeFileSync(join(tree.tree, 'api.ts'), 'export {};\n');
    await ws.commitTask(tree.tree, 'api work');
    const prep = await ws.prepareIntegration(SPEC, 'api', 1);
    if (!prep.ok) throw new Error(`expected a clean integration, got ${prep.paths.join(', ')}`);
    const advanced = await ws.advanceMain(SPEC, prep.commit, prep.base);
    expect(advanced).toEqual({ ok: true });
    expect(await ref(repoDir, 'refs/heads/main')).toBe(prep.commit);
  });

  test('reports main_moved on a stale base and leaves main alone', async () => {
    const ws = workspace(newRoot());
    const { repoDir } = await ws.prepare(SPEC);
    const tree = await ws.taskTree(SPEC, 'api', 1);
    writeFileSync(join(tree.tree, 'api.ts'), 'export {};\n');
    await ws.commitTask(tree.tree, 'api work');
    const prep = await ws.prepareIntegration(SPEC, 'api', 1);
    if (!prep.ok) throw new Error(`expected a clean integration, got ${prep.paths.join(', ')}`);
    const first = await ws.advanceMain(SPEC, prep.commit, prep.base);
    expect(first.ok).toBe(true);
    const stale = await ws.advanceMain(SPEC, prep.commit, prep.base);
    expect(stale).toEqual({ ok: false, reason: 'main_moved' });
    expect(await ref(repoDir, 'refs/heads/main')).toBe(prep.commit);
  });
});

describe('handOverConflict', () => {
  test('leaves the conflict in the task tree with markers and reports the unresolved paths', async () => {
    const { ws, repoDir, tree, betaCommit } = await conflictFixture(newRoot());
    const mainBefore = await ref(repoDir, 'refs/heads/main');
    const hand = await ws.handOverConflict(SPEC, 'beta', 1);
    expect(hand.unresolvedPaths).toContain('shared.txt');
    expect(readFileSync(join(tree, 'shared.txt'), 'utf8')).toContain('<<<<<<<');
    const gitdir = readFileSync(join(tree, '.git'), 'utf8')
      .replace(/^gitdir: /, '')
      .trim();
    expect(existsSync(join(gitdir, 'MERGE_HEAD'))).toBe(true);
    expect(await ref(repoDir, 'refs/heads/task/beta-r1')).toBe(betaCommit);
    expect(await ref(repoDir, 'refs/heads/main')).toBe(mainBefore);
  });
});

describe('unresolvedPaths', () => {
  test('is empty on a clean tree', async () => {
    const ws = workspace(newRoot());
    await ws.prepare(SPEC);
    const tree = await ws.taskTree(SPEC, 'api', 1);
    expect(await ws.unresolvedPaths(tree.tree)).toEqual([]);
  });
});

describe('cleanCopy', () => {
  test('checks main out into fresh numbered delivery copies', async () => {
    const ws = workspace(newRoot());
    const { repoDir } = await ws.prepare(SPEC);
    writeFileSync(join(repoDir, 'app.ts'), 'app\n');
    await run(repoDir, ['add', '-A']);
    await run(repoDir, ['commit', '-m', 'app on main']);
    const first = await ws.cleanCopy(SPEC);
    expect(first.dir).toBe(join(repoDir, '.delivery', 'copy-0'));
    expect(existsSync(join(first.dir, 'app.ts'))).toBe(true);
    const second = await ws.cleanCopy(SPEC);
    expect(second.dir).toBe(join(repoDir, '.delivery', 'copy-1'));
  });
});

describe('deliver', () => {
  test('replaces the output directory without .git and node_modules', async () => {
    const ws = workspace(newRoot());
    const root = newRoot();
    const { repoDir } = await ws.prepare(SPEC);
    writeFileSync(join(repoDir, 'app.ts'), 'app\n');
    await run(repoDir, ['add', '-A']);
    await run(repoDir, ['commit', '-m', 'app on main']);
    const copy = await ws.cleanCopy(SPEC);
    mkdirSync(join(copy.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(copy.dir, 'node_modules', 'pkg.js'), 'junk\n');
    const outDir = join(root, 'out', SPEC);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'stale.txt'), 'stale\n');
    writeFileSync(join(outDir, DELIVERY_MARKER), '');
    const { files } = await ws.deliver(copy.dir, outDir);
    expect(files).toBeGreaterThan(0);
    expect(readFileSync(join(outDir, 'app.ts'), 'utf8')).toBe('app\n');
    expect(existsSync(join(outDir, 'node_modules'))).toBe(false);
    expect(existsSync(join(outDir, '.git'))).toBe(false);
    expect(existsSync(join(outDir, 'stale.txt'))).toBe(false);
    expect(existsSync(join(outDir, DELIVERY_MARKER))).toBe(true);
  });

  test('refuses a non-empty directory the factory did not deliver, and leaves it alone', async () => {
    const ws = workspace(newRoot());
    await ws.prepare(SPEC);
    const copy = await ws.cleanCopy(SPEC);
    const outDir = join(newRoot(), 'my-project');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'precious.txt'), 'keep\n');
    expect(deliveryTargetProblem(outDir)).toContain('not created by the factory');
    const error = await catchWorkspaceError(() => ws.deliver(copy.dir, outDir));
    expect(error.info.stderrTail).toContain('not created by the factory');
    expect(readFileSync(join(outDir, 'precious.txt'), 'utf8')).toBe('keep\n');
  });

  test('accepts a missing or empty output directory', () => {
    const root = newRoot();
    expect(deliveryTargetProblem(join(root, 'absent'))).toBeUndefined();
    mkdirSync(join(root, 'empty'));
    expect(deliveryTargetProblem(join(root, 'empty'))).toBeUndefined();
  });
});

describe('failures', () => {
  test('a failed command names the command, the exit code and a stderr tail', async () => {
    const root = newRoot();
    mkdirSync(join(root, 'work', SPEC), { recursive: true });
    const ws = workspace(root);
    const error = await catchWorkspaceError(() => ws.mainCommit(SPEC));
    expect(error.info.command).toContain('rev-parse');
    expect(typeof error.info.exitCode).toBe('number');
    expect(error.info.stderrTail.length).toBeGreaterThan(0);
  });

  test('a command that never starts is a typed failure with no exit code', async () => {
    const ws = workspace(newRoot());
    const error = await catchWorkspaceError(() => ws.mainCommit(SPEC));
    expect(error.info.command).toContain('rev-parse');
    expect(error.info.exitCode).toBeNull();
    expect(error.info.stderrTail.length).toBeGreaterThan(0);
  });

  test('secrets set with setSecrets never appear in an error', async () => {
    const root = newRoot();
    const ws = workspace(root);
    ws.setSecrets(['hunter2']);
    await ws.prepare(SPEC);
    // No task branch exists, so the merge names the missing branch in its stderr.
    const error = await catchWorkspaceError(() => ws.prepareIntegration(SPEC, 'x-hunter2', 1));
    expect(error.info.stderrTail).toContain('not something we can merge');
    expect(error.info.stderrTail).toContain('[redacted]');
    expect(error.info.stderrTail).not.toContain('hunter2');
    expect(error.info.command).not.toContain('hunter2');
    expect(error.message).toContain('[redacted]');
  });

  test('the stderr tail helper redacts a real git stderr', async () => {
    const ws = workspace(newRoot());
    const { repoDir } = await ws.prepare(SPEC);
    const outcome = await runGit({ cwd: repoDir, args: ['log', 'missing-hunter2-ref'], timeoutMs: TIMEOUT_MS, secrets: [] });
    expect(outcome.stderr).toContain('missing-hunter2-ref');
    const error = gitFailure('git log missing-hunter2-ref', outcome.exitCode, outcome.stderr, ['hunter2']);
    expect(error.info.exitCode).toBe(outcome.exitCode);
    expect(error.info.stderrTail).toContain('[redacted]');
    expect(error.info.stderrTail).not.toContain('hunter2');
  });

  test('a timed out command is killed and reports no exit code', async () => {
    const root = newRoot();
    const ws = workspace(root);
    const { repoDir } = await ws.prepare(SPEC);
    const tree = await ws.taskTree(SPEC, 'slow', 1);
    const hooks = join(repoDir, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nsleep 5\n');
    chmodSync(hook, 0o755);
    writeFileSync(join(tree.tree, 'x.txt'), 'data\n');
    const slow = new GitWorkspace({ workRoot: root, timeoutMs: 1 });
    const error = await catchWorkspaceError(() => slow.commitTask(tree.tree, 'slow'));
    expect(error.info.exitCode).toBeNull();
    expect(/add|commit/.test(error.info.command)).toBe(true);
    expect(error.info.command.startsWith('git ')).toBe(true);
  });
});
