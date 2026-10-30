/**
 * The Node-only environment of generated code: the allowlisted
 * generated-code environment with `PATH` set to one tool directory, a
 * temporary directory of symlinks to `node`, `npm`, `npx`, `git`, the
 * shells (its `bash` is the process's chosen bash, see `shell.ts`) and the core utilities a package script calls, each resolved from
 * a given `PATH`. Removing whole directories from `PATH` is not enough,
 * because Homebrew and other layouts put `bun`, `node` and `npm` in one
 * directory. Invariant: the tool directory never holds `bun` or `bunx`,
 * nor any tool that resolves to a file named `bun` or `bunx` (a `node`
 * shim that is Bun in disguise is skipped for the next one on the `PATH`),
 * so a package that only works under Bun fails here as it would on a
 * Node-only grader. A tool not found is left out. Each tool directory is
 * built once per `PATH` per process and removed when the process exits.
 * `node` is resolved to a real binary (a version-manager shim that reads
 * the operator's `HOME` would fail under the scratch `HOME`): the candidate
 * is asked once for `process.execPath`, and `npm` and `npx` come from the
 * `bin` directory next to that binary. The bun-runtime environment puts the
 * same tool directory first and the factory's `PATH` after it, so `bun`
 * stays reachable while `node`, `npm` and `npx` are the real binaries.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';

import { generatedCodeEnv, type ChildEnv } from './child-env';
import { bashCommand } from './shell';

/** The tools linked into a Node-only tool directory: Node, git, shells and the core utilities scripts call. */
export const NODE_ONLY_TOOLS = [
  'node',
  'npm',
  'npx',
  'git',
  'sh',
  'bash',
  'env',
  'awk',
  'basename',
  'cat',
  'chmod',
  'cp',
  'cut',
  'date',
  'diff',
  'dirname',
  'echo',
  'false',
  'find',
  'grep',
  'head',
  'ln',
  'ls',
  'mkdir',
  'mktemp',
  'mv',
  'printf',
  'pwd',
  'rm',
  'sed',
  'sleep',
  'sort',
  'tail',
  'tee',
  'test',
  'touch',
  'tr',
  'true',
  'uname',
  'uniq',
  'wc',
  'which',
  'xargs',
] as const;

/** File names that are Bun, under whatever name they are linked. */
const BUN_FILES = new Set(['bun', 'bunx']);

/** The tool directory built for each PATH value in this process. */
const built = new Map<string, string>();

/** Removes every tool directory this process built. */
function removeToolDirs(): void {
  for (const dir of built.values()) rmSync(dir, { recursive: true, force: true });
  built.clear();
}

/** The first executable file named `name` in `dirs` that is not Bun, or null. */
function resolveTool(name: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile() && !BUN_FILES.has(basename(realpathSync(candidate)))) return candidate;
    } catch {
      // Absent or not executable here: the next directory may have it.
    }
  }
  return null;
}

/** How long the probe of a `node` candidate may run. */
const NODE_PROBE_MS = 5000;

/**
 * The real executable behind the `node` candidate: the candidate is run once
 * with the factory's own environment (and `path` as its `PATH`) and asked for
 * `process.execPath`. Null when it does not start, prints no absolute path,
 * or prints a Bun file.
 */
function probeNode(candidate: string, path: string): string | null {
  const probe = spawnSync(candidate, ['-p', 'process.execPath'], {
    env: { ...process.env, PATH: path },
    timeout: NODE_PROBE_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const printed = probe.status === 0 ? probe.stdout.trim() : '';
  if (!isAbsolute(printed) || BUN_FILES.has(basename(printed))) return null;
  try {
    accessSync(printed, constants.X_OK);
    return printed;
  } catch {
    return null;
  }
}

/** The executable `name` in `dir` when there is one, else null. */
function siblingTool(dir: string, name: string): string | null {
  const candidate = join(dir, name);
  try {
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/** The process's chosen bash when it is an absolute file, else the first `bash` on `dirs`. */
function chosenBash(dirs: readonly string[]): string | null {
  const shell = bashCommand();
  return isAbsolute(shell) ? shell : resolveTool('bash', dirs);
}

/** Builds (once per `path` value) the tool directory of the tools found on `path`, and returns it. */
export function toolDir(path: string): string {
  const existing = built.get(path);
  if (existing !== undefined) return existing;
  // Only absolute entries: an empty or relative entry would resolve against the package's own directory.
  const dirs = path.split(delimiter).filter((entry) => isAbsolute(entry));
  const dir = mkdtempSync(join(tmpdir(), 'factory-node-only-'));
  const candidate = resolveTool('node', dirs);
  const realNode = candidate === null ? null : probeNode(candidate, path);
  const nodeBin = realNode === null ? null : dirname(realNode);
  for (const name of NODE_ONLY_TOOLS) {
    const target =
      name === 'bash'
        ? chosenBash(dirs)
        : name === 'node' && realNode !== null
          ? realNode
          : (name === 'npm' || name === 'npx') && nodeBin !== null
            ? (siblingTool(nodeBin, name) ?? resolveTool(name, dirs))
            : resolveTool(name, dirs);
    if (target !== null) symlinkSync(target, join(dir, name));
  }
  if (built.size === 0) process.once('exit', removeToolDirs);
  built.set(path, dir);
  return dir;
}

/**
 * The environment of a Node-only process: `generatedCodeEnv(home, extra)`
 * with `PATH` replaced by the tool directory of the factory's own `PATH`
 * (an `extra` PATH is replaced too; a caller prepends to the result).
 */
export function nodeOnlyEnv(home: string, extra: ChildEnv = {}): ChildEnv {
  return { ...generatedCodeEnv(home, extra), PATH: toolDir(process.env['PATH'] ?? '') };
}

/**
 * The environment of a process under the `bun` runtime: `generatedCodeEnv(home, extra)`
 * with `PATH` set to the tool directory of the factory's own `PATH` followed by
 * that `PATH`, so `bun` is found and `node` resolves to the real binary, never
 * a version-manager shim that needs the operator's `HOME`.
 */
export function bunRuntimeEnv(home: string, extra: ChildEnv = {}): ChildEnv {
  const path = process.env['PATH'] ?? '';
  return { ...generatedCodeEnv(home, extra), PATH: [toolDir(path), path].join(delimiter) };
}
